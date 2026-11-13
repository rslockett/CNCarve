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
 *
 * Pause: stops sending at the next segment start, lets the machine finish the pass it is on,
 * lifts the bit and turns the spindle off, then saves the exact line to resume from. Nothing is
 * left in GRBL's queue, so a sleeping computer, a USB drop or a power cut while paused loses
 * nothing: Resume (or Continue after re-homing) starts at that exact segment.
 *
 * Emergency stop: feed hold + soft reset — motion and spindle stop at once — and the job is
 * cancelled. The machine must be homed again afterwards.
 */

import { checkMachineSettings, type MachineCheckItem } from "./machineCheck";
import { GrblSerial, parseGrblGcodeLines } from "./grblSerial";
import type { BitShape } from "./relief/reliefCam";
import { motionFromGrbl, type MotionSettings } from "./relief/motionTime";
import { loadFactor, predictedAt, recordFactor, saveMotion } from "./carveTime";
import {
  loadOriginal,
  originalCommands,
  rememberOriginal,
  settingCommands,
  zFixCommands,
  testPattern,
  type SpeedSettings,
  type SpeedTarget,
} from "./speedCheck";
import {
  clearCarve,
  loadProgress,
  restartLineFor,
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
  | "stopping"
  | "speedtest";

/** Where the guided speed check is up to. */
export type SpeedCheckState = {
  phase: "off" | "marking" | "testing" | "check" | "kept" | "restored";
  /** The remembered spot over the pencil dot (machine coordinates). */
  mark: Pos | null;
  target: SpeedTarget | null;
};

/** What the caller passes to start a carve. */
export type NewCarve = Omit<SavedCarve, "g54" | "startedAt"> & {
  bit?: BitShape;
  area?: SavedCarve["area"];
  timeline?: number[];
};

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
  /** Parked: bit lifted, spindle off, resume point saved. */
  paused: boolean;
  /** Pause requested; finishing the current pass. */
  pausing: boolean;
  /** The carve being run or paused right now (null otherwise). */
  carve: SavedCarve | null;
  /** The carve that just finished, kept so its picture stays on screen until dismissed. */
  finishedCarve: SavedCarve | null;
  progress: null | {
    line: number;
    total: number;
    section: string;
    startedAt: number;
    /** Line the current run started from (0 for a fresh carve). */
    fromLine: number;
    /** Minutes left: predicted, corrected by how fast this machine is really going. */
    etaMinutes: number | null;
  };
  /** Speed / acceleration settings read from the machine ($$), for time estimates. */
  motion: MotionSettings | null;
  /** All settings as last read with $$. */
  grbl: Record<number, number> | null;
  speedCheck: SpeedCheckState;
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
    pausing: false,
    carve: null,
    finishedCarve: null,
    progress: null,
    motion: null,
    grbl: null,
    speedCheck: { phase: "off", mark: null, target: null },
    notice: null,
  };
  /** Latest machine position (MPos), for remembering the speed-check spot. */
  private mpos: Pos | null = null;
  /** Settings just before the current speed test: a failed test goes back to these. */
  private beforeTest: SpeedSettings | null = null;
  /** Machine position right after the last homing — where the home corner really is. */
  private homeMpos: Pos | null = null;
  /** Pause plumbing: requested flag, next line to send, and the waiter Resume releases. */
  private pauseRequested = false;
  private nextLine = 0;
  private resumeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private pollTick = 0;
  /** Set before an emergency stop touches the machine, so the carve loop knows to cancel. */
  private emergency = false;

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
      this.homeMpos = null; // must home again on this connection
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
    // A dropped port fires more than one signal (port event + stream error); handle it once.
    if (!this.state.connected) return;
    this.stopPolling();
    this.resumeWaiter?.reject(new Error("connection lost"));
    this.resumeWaiter = null;
    const wasCarving = this.state.busy === "carving" || this.state.busy === "restarting";
    this.set({
      connected: false,
      status: "",
      homed: false,
      paused: false,
      pausing: false,
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
      const carving = this.state.busy === "carving";
      // Ask for position 4×/s while carving (smooth live view), about 1×/s otherwise.
      this.pollTick++;
      if (carving || this.pollTick % 3 === 0) void this.serial.sendRealtime("?").catch(() => {});
      if (carving && !this.state.paused && Date.now() - this.lastStatusAt > SILENCE_LIMIT_MS) {
        this.abort = true;
        this.say("bad", "The machine stopped answering. Your progress is saved — check the USB cable and power, then Continue carving.");
      }
    }, 250);
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
      if (mpos) this.mpos = mpos;
      else if (wpos && this.wco) this.mpos = { x: wpos.x + this.wco.x, y: wpos.y + this.wco.y, z: wpos.z + this.wco.z };
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
      if (Object.keys(s).length) {
        const motion = motionFromGrbl(s);
        saveMotion(motion); // remembered on this device so estimates are right before connecting
        const items = checkMachineSettings(s);
        const zFix = zFixCommands(s);
        if (zFix)
          items.push({
            id: "zslip",
            status: "problem",
            title: "The up-and-down motor is set too fast",
            detail: `The speed check raised its acceleration to ${s[122]} mm/s² (corner setting ${s[11]}). That makes it slip now and then on long carvings, and each slip leaves a line across the carving. This puts it back to your machine's own setting; left-right and front-back stay fast.`,
            fix: zFix.join(" "),
          });
        this.set({ settings: items, motion, grbl: s });
      }
    } catch {
      /* shown as "not checked"; user can retry */
    }
  }

  async applyFix(cmd: string) {
    if (!this.idle()) return;
    try {
      for (const c of cmd.split(" ").filter(Boolean)) await this.serial.sendCommand(c);
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
      await this.rememberHome();
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

  /** Jogging is allowed when idle, and while a carve is paused (Resume lifts back first). */
  canJog() {
    return canJogIn(this.state);
  }

  async jog(axis: "X" | "Y" | "Z", mm: number) {
    if (!this.canJog()) return;
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
  async startCarve(c: NewCarve) {
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
      await this.rememberHome();
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
      // A deliberate pause saved the exact segment to resume from; otherwise back up safely.
      const from = restartLineFor(c, p);
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
    this.pauseRequested = false;
    const total = c.lineCount;
    const startedAt = Date.now();
    const restartSet = new Set(c.restartPoints);
    // ---- time measuring (paused time excluded) ----
    const runStart = Date.now();
    let pausedMs = 0;
    const factor0 = loadFactor()?.factor ?? 1;
    const tl = c.timeline;
    const predFrom = tl ? predictedAt(tl, fromLine, total) : 0;
    const predEnd = tl ? predictedAt(tl, total, total) : 0;
    const measure = (line: number) => {
      const activeSec = (Date.now() - runStart - pausedMs) / 1000;
      const predDone = tl ? predictedAt(tl, line, total) - predFrom : 0;
      return { activeSec, predDone };
    };
    const eta = (line: number): number | null => {
      if (!tl) return null;
      const { activeSec, predDone } = measure(line);
      let ratio = factor0;
      // After a couple of minutes, trust what this carve is really doing more and more.
      if (activeSec >= 120 && predDone >= 30) {
        const w = Math.min(1, activeSec / 1200);
        ratio = factor0 * (1 - w) + (activeSec / predDone) * w;
      }
      return ((predEnd - predictedAt(tl, line, total)) * ratio) / 60;
    };
    const learn = (line: number) => {
      const { activeSec, predDone } = measure(line);
      if (predDone > 0) recordFactor(activeSec / predDone, activeSec / 60);
    };
    let lastLine = fromLine;
    this.set({
      busy: "carving",
      paused: false,
      pausing: false,
      carve: c,
      finishedCarve: null,
      progress: {
        line: fromLine,
        total,
        section: sectionAt(c.sections, fromLine)?.label ?? "",
        startedAt,
        fromLine,
        etaMinutes: tl ? ((predEnd - predFrom) * factor0) / 60 : null,
      },
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
    let from = fromLine;
    try {
      // Sanity: the line numbering the restart points use must match what will be streamed.
      if (parseGrblGcodeLines(c.gcode).length !== total) throw new Error("program line count mismatch");
      for (;;) {
        this.nextLine = from;
        await this.serial.streamGcode(
          c.gcode,
          (i, t) => {
            this.nextLine = i;
            lastLine = i;
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
                  etaMinutes: eta(i),
                },
              });
          },
          // Stop sending for a pause only at a segment start: the previous segment ended by lifting.
          () => this.abort || (this.pauseRequested && restartSet.has(this.nextLine)),
          { startIndex: from, perLineTimeoutMs: PER_LINE_TIMEOUT_MS },
        );
        if (this.abort) throw new Error("stopped");
        if (!(this.pauseRequested && this.nextLine < total)) break; // finished

        // ---- park ----
        const resumeAt = this.nextLine;
        saveProgress({ id: c.id, lastAcked: resumeAt - 1, updatedAt: Date.now(), finished: false, resumeAt });
        await this.waitForIdle(120_000);
        await this.serial.sendCommand("G90");
        await this.serial.sendCommand("G0 Z5");
        await this.serial.sendCommand("M5");
        await this.waitForIdle(30_000);
        this.set({
          paused: true,
          pausing: false,
          notice: {
            tone: "info",
            text: "Paused. The bit is lifted and the spindle is off. Your place is saved — even if the computer sleeps or the power goes out, nothing is lost.",
          },
        });
        void this.unlockScreen();
        const pauseStart = Date.now();

        // ---- wait for Resume (rejects on emergency stop or a lost connection) ----
        await new Promise<void>((resolve, reject) => {
          this.resumeWaiter = { resolve, reject };
        });
        this.resumeWaiter = null;
        pausedMs += Date.now() - pauseStart;

        // ---- resume: lift (in case it was jogged), spindle on, carry on at the saved segment ----
        this.set({ notice: { tone: "info", text: "Resuming — spindle starting…" } });
        await this.lockScreen();
        for (const cmd of ["G90", "G0 Z5", `M3 S${c.spindleS}`, "G4 P4"]) await this.serial.sendCommand(cmd, 30_000);
        this.pauseRequested = false;
        saveProgress({ id: c.id, lastAcked: resumeAt - 1, updatedAt: Date.now(), finished: false });
        lastSaved = resumeAt - 1;
        from = resumeAt;
        this.set({ paused: false, notice: null });
      }
      saveProgress({ id: c.id, lastAcked: total - 1, updatedAt: Date.now(), finished: true });
      learn(total);
      await clearCarve();
      this.set({ busy: null, paused: false, pausing: false, carve: null, finishedCarve: c, progress: null });
      this.say("good", "Carving finished! Vacuum the chips, then saw along the groove around the design.");
    } catch (e) {
      learn(lastLine); // even an interrupted carve teaches how fast this machine really is
      const wasStop = this.emergency;
      this.emergency = false;
      this.pauseRequested = false;
      this.set({ busy: null, paused: false, pausing: false, carve: null });
      if (wasStop) {
        await clearCarve();
        this.set({ progress: null });
        this.say("info", "Stopped. The carving was cancelled. Home the machine before doing anything else.");
      } else if (!this.state.notice || this.state.notice.tone !== "bad")
        this.say("bad", `Carving stopped (${short(e)}). Your progress is saved — press Continue carving.`);
    } finally {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void this.unlockScreen();
    }
  }

  /** Note where the machine is right after homing (fresh status report). */
  private async rememberHome() {
    this.homeMpos = null;
    await this.serial.sendRealtime("?").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    this.homeMpos = this.mpos ? { ...this.mpos } : null;
  }

  /** Wait until GRBL reports Idle (its queue is empty and the machine has stopped moving). */
  private async waitForIdle(timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    // Make sure the status we read is fresh, not from before the last command.
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() < until) {
      if (!this.state.connected) throw new Error("connection lost");
      if (this.abort) throw new Error("stopped");
      await this.serial.sendRealtime("?").catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      if (this.state.status === "Idle") return;
    }
    throw new Error("the machine didn't come to a stop");
  }

  // ---- guided speed check ----
  /** Start the guided check (default: the recommended setting). */
  openSpeedCheck(target?: SpeedTarget) {
    this.set({ speedCheck: { phase: "marking", mark: null, target: target ?? null }, notice: null });
  }

  closeSpeedCheck() {
    // Closing at the "is it on the dot?" question without answering counts as No:
    // an untested setting must never stay on the machine.
    if (this.state.speedCheck.phase === "check") void this.restoreBeforeTest();
    this.set({ speedCheck: { phase: "off", mark: null, target: null } });
  }

  /** Run the air test at `target`, ending exactly over the spot the bit is at now. */
  async runSpeedTest(target: SpeedTarget) {
    if (!this.idle() || !this.state.homed) {
      this.say("warn", "Home the machine first.");
      return;
    }
    const g = this.state.grbl;
    if (!g) {
      this.say("warn", "The machine's settings haven't been read yet — wait a moment and try again.");
      return;
    }
    // Remember exactly where the bit is (fresh position).
    await this.serial.sendRealtime("?").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const mark = this.mpos;
    if (!mark) {
      this.say("bad", "Couldn't read the machine's position. Try again.");
      return;
    }
    const travel = { x: g[130] > 0 ? g[130] : 290, y: g[131] > 0 ? g[131] : 170, z: g[132] > 0 ? g[132] : 40 };
    let lines: string[];
    try {
      if (!this.homeMpos) throw new Error("Home the machine first, then try again.");
      lines = testPattern(mark, this.homeMpos, travel);
    } catch (e) {
      this.say("warn", short(e));
      return;
    }
    rememberOriginal(g);
    this.beforeTest = { 120: g[120], 121: g[121], 122: g[122], 11: g[11] };
    this.abort = false;
    this.set({
      busy: "speedtest",
      speedCheck: { phase: "testing", mark, target },
      notice: { tone: "info", text: "Running the speed test in the air (spindle off)…" },
    });
    try {
      for (const cmd of settingCommands(target)) await this.serial.sendCommand(cmd);
      await this.serial.streamGcode(lines.join("\n"), undefined, () => this.abort, { perLineTimeoutMs: 120_000 });
      if (this.abort) throw new Error("stopped");
      await this.waitForIdle(120_000);
      this.set({ busy: null, speedCheck: { phase: "check", mark, target }, notice: null });
    } catch (e) {
      // Anything went wrong (including STOP): put the original settings back. After a STOP the
      // controller restarts; give it a moment (GRBL accepts $ settings while in alarm).
      const stopped = this.abort;
      if (stopped) await new Promise((r) => setTimeout(r, 800));
      await this.restoreBeforeTest();
      this.set({ busy: null, speedCheck: { phase: "restored", mark, target } });
      this.say(
        "warn",
        stopped
          ? "Speed test stopped. Your previous settings are back. Home the machine before doing anything else."
          : `The speed test didn't finish (${short(e)}). Your previous settings are back.`,
      );
    }
  }

  /** The user's answer: is the tip still exactly over the dot? */
  async answerSpeedTest(onTheDot: boolean) {
    const sc = this.state.speedCheck;
    if (sc.phase !== "check" || !sc.target) return;
    if (onTheDot) {
      this.set({ speedCheck: { ...sc, phase: "kept" } });
      await this.checkSettings();
      this.say("good", `Kept. The machine now uses ${sc.target.accel} mm/s² — carving times have been updated.`);
    } else {
      await this.restoreBeforeTest();
      this.set({ speedCheck: { ...sc, phase: "restored" } });
      this.say("info", "Your previous settings are back. The machine is safest at those values.");
    }
  }

  /** Go back to the settings in use just before this test (the last ones that worked). */
  private async restoreBeforeTest() {
    const b = this.beforeTest;
    if (!b || !this.state.connected) return;
    try {
      for (const cmd of originalCommands(b)) await this.serial.sendCommand(cmd);
      await this.checkSettings();
    } catch (e) {
      this.say("bad", `Couldn't put the previous settings back (${short(e)}). Use "Restore my original speed settings".`);
    }
  }

  /** Put the settings from before the first speed check back. */
  async restoreOriginalSpeed(quiet = false) {
    const o = loadOriginal();
    if (!o || !this.state.connected) return;
    try {
      for (const cmd of originalCommands(o)) await this.serial.sendCommand(cmd);
      await this.checkSettings();
      if (!quiet) this.say("good", "Your original speed settings are back.");
    } catch (e) {
      this.say("bad", `Couldn't restore the original settings (${short(e)}).`);
    }
  }

  /** Hide the finished carving's picture. */
  dismissFinished() {
    this.set({ finishedCarve: null, notice: null });
  }

  /** Pause: finish the current pass, lift, spindle off, save the exact place. */
  async pause() {
    if (this.state.busy !== "carving" || this.state.paused || this.state.pausing) return;
    this.pauseRequested = true;
    this.set({ pausing: true, notice: { tone: "info", text: "Pausing — finishing this pass, then lifting the bit…" } });
  }

  async resume() {
    if (this.state.paused && this.resumeWaiter) {
      this.resumeWaiter.resolve();
      return;
    }
    // A pause was requested but hasn't taken effect yet: just cancel it.
    if (this.state.pausing) {
      this.pauseRequested = false;
      this.set({ pausing: false, notice: null });
    }
  }

  /**
   * Emergency stop: motion and spindle stop at once (feed hold + soft reset). Any carve that is
   * running or paused is cancelled. The machine has to be homed again afterwards.
   */
  async emergencyStop() {
    if (!this.state.connected) return;
    const carving = this.state.busy === "carving";
    // Flag first: the reset below makes the carve loop end straight away.
    this.emergency = carving;
    this.abort = true;
    this.pauseRequested = false;
    if (carving) this.set({ busy: "stopping" });
    try {
      await this.serial.sendRealtime("!");
      await this.serial.softReset();
    } catch {
      /* connection may already be gone */
    }
    this.set({ homed: false, traced: false });
    if (carving) {
      // If parked, nothing is streaming: release the waiter so the carve loop ends and cleans up.
      if (this.resumeWaiter) {
        this.resumeWaiter.reject(new Error("stopped"));
        this.resumeWaiter = null;
      }
    } else {
      this.set({ busy: null });
      this.say("info", "Stopped. Home the machine before doing anything else.");
    }
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

/** Pure check on a state snapshot (use this in React so the answer is never cached). */
export function canJogIn(s: MachineState): boolean {
  return s.connected && (s.busy === null || (s.paused && !s.pausing));
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
