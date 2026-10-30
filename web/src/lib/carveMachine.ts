/**
 * Everything the simple Carve screen does with the 3018, in one place, with plain-English state.
 *
 * Recovery design (why it is different from the old Run panel):
 *  - The program and progress are saved on the device (carveStore), so a page reload or Pi
 *    reboot does not lose the job.
 *  - Zero is recorded (`$#`) when carving starts. After re-homing it is read back and restored
 *    if it does not match, so the carve can never silently shift.
 *  - Restarts happen at a segment start well before the last acknowledged line (GRBL acks lines
 *    when it queues them, not when it cuts them). Segments begin at a safe height, so the only
 *    thing needed before restarting is "spindle on" — no guessing the machine's state.
 */

import { checkMachineSettings, type MachineCheckItem } from "./machineCheck";
import { GrblSerial, parseGrblGcodeLines } from "./grblSerial";
import {
  chooseRestartLine,
  clearCarve,
  loadProgress,
  saveCarve,
  saveProgress,
  sectionAt,
  type SavedCarve,
} from "./carveStore";

export type Pos = { x: number; y: number; z: number };

export type Busy =
  | null
  | "connecting"
  | "homing"
  | "zeroing"
  | "probing"
  | "tracing"
  | "carving"
  | "restarting"
  | "stopping";

export type Notice = { tone: "info" | "good" | "warn" | "bad"; text: string };

export type MachineState = {
  connected: boolean;
  /** GRBL state word: Idle, Run, Hold, Alarm, Home, Jog… ("" until the first status report). */
  status: string;
  homed: boolean;
  xyZeroSet: boolean;
  zZeroSet: boolean;
  traced: boolean;
  wpos: Pos | null;
  settings: MachineCheckItem[] | null;
  busy: Busy;
  paused: boolean;
  progress: null | {
    line: number;
    total: number;
    section: string;
    startedAt: number;
    /** Line the current run started from (0 for a fresh carve). */
    fromLine: number;
  };
  notice: Notice | null;
};

const HOMING_TIMEOUT_MS = 180_000;
/** A paused carve waits on GRBL; allow long pauses. Real USB drops are caught immediately. */
const PER_LINE_TIMEOUT_MS = 20 * 60_000;
/** No status reply for this long while carving (and not paused) = the machine stopped talking. */
const SILENCE_LIMIT_MS = 15_000;

export class CarveMachine {
  private serial = new GrblSerial();
  private listeners = new Set<() => void>();
  private abort = false;
  private wco: Pos | null = null;
  private lastStatusAt = 0;
  private poll: number | null = null;
  private offLines: (() => void) | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  state: MachineState = {
    connected: false,
    status: "",
    homed: false,
    xyZeroSet: false,
    zZeroSet: false,
    traced: false,
    wpos: null,
    settings: null,
    busy: null,
    paused: false,
    progress: null,
    notice: null,
  };

  // ---- store plumbing (useSyncExternalStore) ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getState = () => this.state;
  private set(patch: Partial<MachineState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  private say(tone: Notice["tone"], text: string) {
    this.set({ notice: { tone, text } });
  }

  isSupported() {
    return this.serial.isSupported();
  }

  // ---- connection ----
  async connect() {
    if (this.state.connected) return;
    this.set({ busy: "connecting", notice: null });
    // Clean up after a dropped connection before opening the port again.
    this.offLines?.();
    this.offLines = null;
    await this.serial.disconnect().catch(() => {});
    try {
      this.serial.onDiagnostic = (ev) => {
        if (ev.kind === "disconnect" && !ev.intentional) this.onLost("The USB connection to the machine dropped.");
      };
      await this.serial.connect();
      this.offLines = this.serial.addLineListener((ln) => this.onLine(ln));
      this.set({
        connected: true,
        busy: null,
        homed: false,
        xyZeroSet: false,
        zZeroSet: false,
        traced: false,
        settings: null,
      });
      this.startPolling();
      // Most 3018 boards restart when USB connects; give GRBL a moment, then read its settings.
      window.setTimeout(() => void this.checkSettings(), 2500);
    } catch (e) {
      this.set({ busy: null });
      const msg = e instanceof Error ? e.message : String(e);
      if (!/No port selected|cancel/i.test(msg)) this.say("bad", `Couldn't connect: ${msg}`);
    }
  }

  async disconnect() {
    this.abort = true;
    this.stopPolling();
    this.offLines?.();
    this.offLines = null;
    try {
      await this.serial.disconnect();
    } catch {
      /* already gone */
    }
    this.set({ connected: false, status: "", busy: null, paused: false, wpos: null });
  }

  private onLost(why: string) {
    this.stopPolling();
    const wasCarving = this.state.busy === "carving" || this.state.busy === "restarting";
    this.set({
      connected: false,
      status: "",
      homed: false,
      paused: false,
      wpos: null,
      busy: wasCarving ? this.state.busy : null,
    });
    this.say(
      "bad",
      wasCarving
        ? `${why} Your progress is saved. Reconnect, then press Continue carving.`
        : `${why} Reconnect to continue.`,
    );
  }

  private startPolling() {
    this.stopPolling();
    this.lastStatusAt = Date.now();
    this.poll = window.setInterval(() => {
      if (!this.state.connected) return;
      void this.serial.sendRealtime("?").catch(() => {});
      const carving = this.state.busy === "carving";
      if (carving && !this.state.paused && Date.now() - this.lastStatusAt > SILENCE_LIMIT_MS) {
        this.abort = true;
        this.say("bad", "The machine stopped answering. Your progress is saved — check the USB cable and power, then Continue carving.");
      }
    }, 700);
  }
  private stopPolling() {
    if (this.poll !== null) window.clearInterval(this.poll);
    this.poll = null;
  }

  /** Parse `<Idle|MPos:…|WCO:…>` (or WPos) status reports. */
  private onLine(ln: string) {
    if (ln.startsWith("<") && ln.endsWith(">")) {
      this.lastStatusAt = Date.now();
      const parts = ln.slice(1, -1).split("|");
      const status = parts[0].split(":")[0];
      let mpos: Pos | null = null;
      let wpos: Pos | null = null;
      for (const p of parts.slice(1)) {
        const [k, v] = p.split(":");
        const n = (v ?? "").split(",").map(Number);
        if (n.length < 3 || !n.every(Number.isFinite)) continue;
        const pos = { x: n[0], y: n[1], z: n[2] };
        if (k === "MPos") mpos = pos;
        if (k === "WPos") wpos = pos;
        if (k === "WCO") this.wco = pos;
      }
      if (!wpos && mpos && this.wco)
        wpos = { x: mpos.x - this.wco.x, y: mpos.y - this.wco.y, z: mpos.z - this.wco.z };
      const patch: Partial<MachineState> = {};
      if (status !== this.state.status) patch.status = status;
      if (wpos) patch.wpos = wpos;
      if (Object.keys(patch).length) this.set(patch);
    } else if (ln.startsWith("ALARM")) {
      this.say("bad", alarmText(ln));
    }
  }

  async checkSettings() {
    if (!this.state.connected || this.state.busy === "carving") return;
    try {
      const s = await this.serial.readSettings();
      if (Object.keys(s).length) this.set({ settings: checkMachineSettings(s) });
    } catch {
      /* shown as "not checked"; user can retry */
    }
  }

  async applyFix(cmd: string) {
    if (!this.idle()) return;
    try {
      await this.serial.sendCommand(cmd);
    } catch (e) {
      this.say("bad", String(e instanceof Error ? e.message : e));
    }
    await this.checkSettings();
  }

  private idle() {
    return this.state.connected && this.state.busy === null;
  }

  // ---- setup moves ----
  async home() {
    if (!this.idle()) return;
    this.set({ busy: "homing", notice: { tone: "info", text: "Homing — the machine moves to its corner switches." } });
    try {
      await this.unlockIfAlarm();
      await this.serial.sendCommand("$H", HOMING_TIMEOUT_MS);
      // Homing moves the machine, so any zero set before it no longer means the same spot.
      this.set({ homed: true, busy: null, xyZeroSet: false, zZeroSet: false, traced: false });
      this.say("good", "Homed.");
    } catch (e) {
      this.set({ busy: null });
      this.say("bad", `Homing didn't finish (${short(e)}). Check that nothing blocks the machine, then try again.`);
    }
  }

  private async unlockIfAlarm() {
    if (this.state.status === "Alarm") {
      await this.serial.sendCommand("$X").catch(() => {});
    }
  }

  async jog(axis: "X" | "Y" | "Z", mm: number) {
    if (!this.idle()) return;
    try {
      const feed = axis === "Z" ? 300 : 1000;
      await this.serial.sendCommand(`$J=G91 G21 ${axis}${mm.toFixed(3)} F${feed}`);
    } catch (e) {
      this.say("warn", `That move was refused (${short(e)}).`);
    }
  }

  async setXYZero() {
    if (!this.idle()) return;
    this.set({ busy: "zeroing" });
    try {
      await this.serial.sendCommand("G10 L20 P1 X0 Y0");
      this.set({ busy: null, xyZeroSet: true, traced: false });
      this.say("good", "Centre of the board saved as X0 Y0.");
    } catch (e) {
      this.set({ busy: null });
      this.say("bad", `Couldn't set zero (${short(e)}).`);
    }
  }

  /** Paper method: the bit is just touching the top of the board. */
  async setZZeroHere() {
    if (!this.idle()) return;
    this.set({ busy: "zeroing" });
    try {
      await this.serial.sendCommand("G10 L20 P1 Z0");
      await this.serial.sendCommand("$J=G91 G21 Z3 F300").catch(() => {});
      this.set({ busy: null, zZeroSet: true, traced: false });
      this.say("good", "Top of the board saved as Z0. The bit lifted 3 mm.");
    } catch (e) {
      this.set({ busy: null });
      this.say("bad", `Couldn't set zero (${short(e)}).`);
    }
  }

  /** Touch probe: plate on the board, clip on the bit. */
  async probeZ(plateMm: number) {
    if (!this.idle()) return;
    this.set({ busy: "probing", notice: { tone: "info", text: "Lowering slowly until the bit touches the plate…" } });
    try {
      await this.serial.sendCommand("G91");
      await this.serial.sendCommand("G38.2 Z-25 F60", 90_000);
      await this.serial.sendCommand("G90");
      await this.serial.sendCommand(`G10 L20 P1 Z${plateMm.toFixed(3)}`);
      await this.serial.sendCommand("G91");
      await this.serial.sendCommand("G0 Z5");
      await this.serial.sendCommand("G90");
      this.set({ busy: null, zZeroSet: true, traced: false });
      this.say("good", "Top of the board found and saved as Z0. Remove the plate and clip.");
    } catch (e) {
      await this.serial.sendCommand("G90").catch(() => {});
      this.set({ busy: null });
      this.say(
        "bad",
        `The probe didn't touch (${short(e)}). Check the clip is on the bit and the plate is under it — or use the paper method.`,
      );
    }
  }

  async trace(traceGcode: string) {
    if (!this.idle()) return;
    this.set({ busy: "tracing", notice: { tone: "info", text: "Tracing the outline 2 mm above the board (spindle off)." } });
    this.abort = false;
    try {
      await this.serial.streamGcode(traceGcode, undefined, () => this.abort, {
        perLineTimeoutMs: 120_000,
      });
      this.set({ busy: null, traced: true });
      this.say("good", "Outline traced. If it stayed on the wood and away from clamps, you're ready to carve.");
    } catch (e) {
      this.set({ busy: null });
      this.say("bad", `The trace stopped (${short(e)}).`);
    }
  }

  // ---- carving ----
  async startCarve(c: Omit<SavedCarve, "g54" | "startedAt">) {
    if (!this.idle()) return;
    if (!this.state.homed || !this.state.xyZeroSet || !this.state.zZeroSet) {
      this.say("warn", "Home the machine and set zero first.");
      return;
    }
    let g54 = null;
    try {
      g54 = await this.serial.readG54();
    } catch {
      /* older firmware — recovery will skip the zero check */
    }
    const saved: SavedCarve = { ...c, g54, startedAt: Date.now() };
    try {
      await saveCarve(saved);
    } catch {
      this.say("warn", "This browser can't save the job, so it can't be continued after a reload. Carving anyway.");
    }
    await this.run(saved, 0);
  }

  /**
   * Continue an interrupted carve: home, check/restore zero, spindle on, restart at a safe
   * segment start before the last acknowledged line.
   */
  async continueCarve(c: SavedCarve) {
    if (!this.state.connected) {
      this.say("warn", "Connect to the machine first.");
      return;
    }
    if (this.state.busy !== null) return;
    this.set({ busy: "restarting", notice: { tone: "info", text: "Homing to find exactly where the machine is…" } });
    try {
      await this.unlockIfAlarm();
      await this.serial.sendCommand("$H", HOMING_TIMEOUT_MS);
      this.set({ homed: true });

      let restored = false;
      if (c.g54) {
        const now = await this.serial.readG54().catch(() => null);
        const off =
          !now ||
          Math.abs(now.x - c.g54.x) > 0.02 ||
          Math.abs(now.y - c.g54.y) > 0.02 ||
          Math.abs(now.z - c.g54.z) > 0.02;
        if (off) {
          await this.serial.sendCommand(
            `G10 L2 P1 X${c.g54.x.toFixed(3)} Y${c.g54.y.toFixed(3)} Z${c.g54.z.toFixed(3)}`,
          );
          const check = await this.serial.readG54().catch(() => null);
          if (
            !check ||
            Math.abs(check.x - c.g54.x) > 0.02 ||
            Math.abs(check.y - c.g54.y) > 0.02 ||
            Math.abs(check.z - c.g54.z) > 0.02
          )
            throw new Error("the saved zero could not be restored");
          restored = true;
        }
      }
      this.set({ xyZeroSet: true, zZeroSet: true, traced: true });

      const p = loadProgress(c.id);
      const from = chooseRestartLine(c, p?.lastAcked ?? -1);
      // After homing the bit is at the top; the restart segment moves over, then down.
      const preamble = ["G21 G90 G17 G94", "G54", `M3 S${c.spindleS}`, "G4 P4"];
      for (const cmd of preamble) await this.serial.sendCommand(cmd, 30_000);
      this.set({ busy: null });
      await this.run(c, from, restored);
    } catch (e) {
      this.set({ busy: null });
      this.say("bad", `Couldn't continue (${short(e)}). Your progress is still saved — try again.`);
    }
  }

  private async run(c: SavedCarve, fromLine: number, restoredZero = false) {
    this.abort = false;
    const total = c.lineCount;
    const startedAt = Date.now();
    this.set({
      busy: "carving",
      paused: false,
      progress: { line: fromLine, total, section: sectionAt(c.sections, fromLine)?.label ?? "", startedAt, fromLine },
      notice:
        fromLine > 0
          ? {
              tone: "info",
              text: `${restoredZero ? "The machine had lost your zero — restored it to where the carving started. " : ""}Continuing — the first few moves may cut air.`,
            }
          : null,
    });
    await this.lockScreen();
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    let lastSaved = -1;
    try {
      // Sanity: the line numbering the restart points use must match what will be streamed.
      if (parseGrblGcodeLines(c.gcode).length !== total) throw new Error("program line count mismatch");
      await this.serial.streamGcode(
        c.gcode,
        (i, t) => {
          const lastAcked = i - 1;
          if (lastAcked - lastSaved >= 20 || i === t) {
            saveProgress({ id: c.id, lastAcked, updatedAt: Date.now(), finished: false });
            lastSaved = lastAcked;
          }
          if (i % 10 === 0 || i === t)
            this.set({
              progress: {
                line: i,
                total: t,
                section: sectionAt(c.sections, i)?.label ?? "",
                startedAt,
                fromLine,
              },
            });
        },
        () => this.abort,
        { startIndex: fromLine, perLineTimeoutMs: PER_LINE_TIMEOUT_MS },
      );
      if (this.abort) throw new Error("stopped");
      saveProgress({ id: c.id, lastAcked: total - 1, updatedAt: Date.now(), finished: true });
      await clearCarve();
      this.set({ busy: null, paused: false, progress: null });
      this.say("good", "Carving finished! Vacuum the chips, then saw along the groove around the design.");
    } catch (e) {
      const wasStop = this.state.busy === "stopping";
      this.set({ busy: null, paused: false });
      if (wasStop)
        this.say("info", "Stopped. Your progress is saved — press Continue carving whenever you're ready.");
      else if (!this.state.notice || this.state.notice.tone !== "bad")
        this.say("bad", `Carving stopped (${short(e)}). Your progress is saved — press Continue carving.`);
    } finally {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void this.unlockScreen();
    }
  }

  async pause() {
    if (this.state.busy !== "carving" || this.state.paused) return;
    await this.serial.sendRealtime("!").catch(() => {});
    this.set({ paused: true, notice: { tone: "info", text: "Paused. The spindle keeps spinning; press Resume to carry on." } });
  }

  async resume() {
    if (!this.state.paused) return;
    await this.serial.sendRealtime("~").catch(() => {});
    this.set({ paused: false, notice: null });
  }

  /** Stop now: hold, then reset (stops spindle and motion). Position must be re-found by homing. */
  async stop() {
    if (this.state.busy !== "carving") return;
    this.set({ busy: "stopping" });
    this.abort = true;
    try {
      await this.serial.sendRealtime("!");
      await new Promise((r) => setTimeout(r, 400));
      await this.serial.softReset();
    } catch {
      /* connection may already be gone */
    }
    this.set({ homed: false });
  }

  private async lockScreen() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }
  private async unlockScreen() {
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}

function alarmText(line: string): string {
  const code = Number(/ALARM:(\d+)/.exec(line)?.[1]);
  const why: Record<number, string> = {
    1: "a limit switch was hit",
    2: "a move would go past the machine's travel",
    3: "the machine was reset while moving",
    4: "the probe was already touching",
    5: "the probe never touched",
    8: "homing couldn't clear a switch",
    9: "homing couldn't find a switch",
  };
  return `The machine stopped with an alarm${why[code] ? `: ${why[code]}` : ""}. Press Home to reset it.`;
}
