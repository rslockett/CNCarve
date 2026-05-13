/**
 * Minimal GRBL sender over Web Serial API (Chrome / Edge).
 *
 * Diagnostic philosophy: every meaningful event (TX line, RX line, ack, timeout, stall,
 * disconnect) is forwarded to {@link GrblSerial.onDiagnostic}. Callers (RunPanel) drop these
 * into a session log the user can download and share. Silent failures here are the #1 cause
 * of "machine just stopped" reports — so no path may swallow an error without emitting at
 * least one diag event.
 */

export type SerialWireStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; portLabel: string }
  | { kind: "streaming"; line: number; total: number }
  | { kind: "error"; message: string };

const BAUD = 115200;

/**
 * Web Serial defaults to a **255-byte** read buffer on some builds; sustained line-at-a-time
 * streaming + status replies can stress cheap USB-serial bridges. Chrome accepts a larger
 * `bufferSize` on `open()` even when TypeScript’s `SerialOptions` typings lag behind.
 */
function serialPortOpenOptions(): SerialOptions {
  return { baudRate: BAUD, bufferSize: 16384 } as unknown as SerialOptions;
}

/**
 * Predicate: should this stripped/uppercased G-code line be dropped before streaming to a
 * stock GRBL 1.1 build? GRBL rejects several common Kiri/Fusion outputs with `error:20`
 * ("unsupported or invalid g-code") even though the bit doesn't need them — e.g. `M6` tool
 * change on a single-spindle 3018, or a bare `T<n>` tool-select line. Dropping them lets the
 * job stream cleanly without changing any physical motion.
 *
 * Keep this list narrow — strip ONLY commands that are demonstrably safe to drop on a
 * single-spindle 3-axis hobby machine.
 */
function isUnsupportedGrblLine(upper: string): boolean {
  /** `M6` and `M6 T<n>` tool change — meaningless on a single-tool machine. */
  if (/^M0*6(\b|\s|$)/.test(upper)) return true;
  /** Bare `T<n>` tool-select on its own line. Embedded `T<n>` on a motion line is left alone. */
  if (/^T\d+\s*$/.test(upper)) return true;
  return false;
}

/** Summary of what `parseGrblGcodeLines` dropped, for surfacing to the user once at stream start. */
export interface GcodeSanitizationReport {
  /** Number of `M6`/tool-change lines removed. */
  m6Removed: number;
  /** Number of bare `T<n>` lines removed. */
  toolSelectRemoved: number;
  /** First-occurrence sample of each kind of dropped line (for log clarity). */
  samples: string[];
}

/**
 * Pre-flight safety scan of the G-code about to be streamed. Surfaces the catastrophic case
 * where the file has cutting moves but no spindle-on (`M3`/`M4`) command — running such a file
 * drags a stationary bit through wood, ruining the bit, straining the steppers, possibly
 * launching the workpiece. This actually happened on cnc-006.nc when Kiri emitted only `M6 T4`
 * + `M30` with no `M3` in between.
 */
export interface GcodePreflight {
  hasCuttingMoves: boolean;
  hasSpindleOn: boolean;
  hasSpindleOff: boolean;
  /** Suggested spindle RPM pulled from `; camOutlineSpindle = NNNN` etc. comments, if any. */
  detectedSpindleRpm: number | null;
  /** 1-based index of the first G1/G2/G3 line — used to position an injected M3 just before it. */
  firstCutLineIndex: number | null;
}

export function preflightGcode(gcode: string): GcodePreflight {
  const result: GcodePreflight = {
    hasCuttingMoves: false,
    hasSpindleOn: false,
    hasSpindleOff: false,
    detectedSpindleRpm: null,
    firstCutLineIndex: null,
  };
  const lines = gcode.split(/\r?\n/);
  /** Pull a sensible RPM from Kiri's spec comments so the auto-inject uses the user's choice. */
  const rpmFromComment =
    /[;]\s*cam(?:Outline|Contour|Rough|Trace)Spindle\s*=\s*(\d+(?:\.\d+)?)/;
  let lineIdx = 0;
  for (const raw of lines) {
    lineIdx++;
    const noParen = raw.replace(/\([^)]*\)/g, "");
    const commentSplit = noParen.indexOf(";");
    const code = (commentSplit >= 0 ? noParen.slice(0, commentSplit) : noParen).trim();
    /** Read RPM out of stripped comment portion too. */
    const m = raw.match(rpmFromComment);
    if (m) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v) && v > 0 && (result.detectedSpindleRpm === null || v > result.detectedSpindleRpm)) {
        result.detectedSpindleRpm = v;
      }
    }
    if (!code) continue;
    const upper = code.toUpperCase();
    /** Cutting moves: G1/G2/G3 (modal numeric prefix). G0 is a rapid, doesn't count. */
    if (/^G0*[123](\b|\s|$)/.test(upper)) {
      if (!result.hasCuttingMoves) {
        result.hasCuttingMoves = true;
        result.firstCutLineIndex = lineIdx;
      }
    }
    if (/^M0*[34](\b|\s|$)/.test(upper)) result.hasSpindleOn = true;
    if (/^M0*5(\b|\s|$)/.test(upper)) result.hasSpindleOff = true;
  }
  return result;
}

/**
 * Insert spindle-on/off and strip unsupported lines so GRBL + a real spindle behave predictably.
 *
 * 1. Drops standalone `M6` / `T<n>` lines (GRBL error:20 on M6; bare T is useless on 3018).
 * 2. Inserts `M3 S<rpm>` + `G4 P2` **before the first G0/G1 motion** (after G21/G90 setup), so the
 *    spindle starts before *any* axis move — not only before the first cut. Files that only had
 *    `M6` as a pseudo spindle command then had every move with spindle off; inserting before first
 *    G0 fixes that.
 * 3. Inserts `M5` before `M30` when present.
 */
export function injectSpindleCommands(gcode: string, rpm: number): string {
  const stripComments = (line: string) => {
    const noParen = line.replace(/\([^)]*\)/g, "");
    const semi = noParen.indexOf(";");
    return semi >= 0 ? noParen.slice(0, semi).trim() : noParen.trim();
  };
  const sRpm = Math.round(Math.max(500, Math.min(rpm, 60_000)));

  const filtered = gcode.split(/\r?\n/).filter((raw) => {
    const code = stripComments(raw);
    if (!code) return true;
    const up = code.toUpperCase();
    if (/^M0*6(\b|\s|$)/.test(up)) return false;
    if (/^T\d+\s*$/.test(up)) return false;
    return true;
  });

  const out: string[] = [];
  let injected = false;
  let m5Inserted = false;

  for (const raw of filtered) {
    const code = stripComments(raw);
    const up = code.toUpperCase();
    /** First motion command: rapid or linear/circular feed. */
    const isMotion =
      /^G0*[0123](\b|\s|$)/.test(up) && !/^G0*28(\b|\s|$)/.test(up) && !/^G0*53(\b|\s|$)/.test(up);
    if (!injected && isMotion) {
      out.push(`M3 S${sRpm} ; CNCarve spindle on (file lacked M3)`);
      out.push("G4 P2 ; spindle spin-up (seconds)");
      injected = true;
    }
    if (!m5Inserted && /^M0*30(\b|\s|$)/.test(up)) {
      out.push("M5 ; CNCarve spindle off before end");
      m5Inserted = true;
    }
    out.push(raw);
  }
  if (injected && !m5Inserted) {
    out.push("M5 ; CNCarve spindle off");
  }
  return out.join("\n");
}

/**
 * Same line splitting / comment stripping as {@link GrblSerial.streamGcode} (for resume indices),
 * with stock-GRBL safety filtering applied. Returns ONLY the lines that will actually be sent
 * over the wire — so a resume index N points at the Nth line GRBL will see, not the Nth line of
 * the raw file. That keeps every downstream consumer (resume, progress %, stall messages,
 * `resumeTargetXY`) consistent.
 */
export function parseGrblGcodeLines(gcode: string): string[] {
  const stripComments = (line: string) => {
    const noParen = line.replace(/\([^)]*\)/g, "");
    const semi = noParen.indexOf(";");
    return semi >= 0 ? noParen.slice(0, semi).trim() : noParen.trim();
  };

  return gcode
    .split(/\r?\n/)
    .map(stripComments)
    .filter((l) => l.length > 0 && l !== "%")
    .filter((l) => !isUnsupportedGrblLine(l.toUpperCase()));
}

/**
 * Run the same sanitization {@link parseGrblGcodeLines} applies, but emit a report of what got
 * dropped. The panel logs this once at stream start so the user understands why their "line
 * 13898" file is being sent as 13897 lines, and so we have a paper trail when a future job
 * fails on a different unsupported command.
 */
export function reportGcodeSanitization(gcode: string): GcodeSanitizationReport {
  const stripComments = (line: string) => {
    const noParen = line.replace(/\([^)]*\)/g, "");
    const semi = noParen.indexOf(";");
    return semi >= 0 ? noParen.slice(0, semi).trim() : noParen.trim();
  };
  const report: GcodeSanitizationReport = {
    m6Removed: 0,
    toolSelectRemoved: 0,
    samples: [],
  };
  const seen = new Set<string>();
  for (const raw of gcode.split(/\r?\n/)) {
    const stripped = stripComments(raw);
    if (!stripped || stripped === "%") continue;
    const upper = stripped.toUpperCase();
    if (/^M0*6(\b|\s|$)/.test(upper)) {
      report.m6Removed++;
      if (!seen.has("M6")) {
        report.samples.push(`M6 (tool change) — first occurrence: ${stripped}`);
        seen.add("M6");
      }
    } else if (/^T\d+\s*$/.test(upper)) {
      report.toolSelectRemoved++;
      if (!seen.has("T")) {
        report.samples.push(`Tool select — first occurrence: ${stripped}`);
        seen.add("T");
      }
    }
  }
  return report;
}

export type StreamGcodeOpts = {
  /** 0-based index into {@link parseGrblGcodeLines}; retry the line that failed or continue after pause. */
  startIndex?: number;
  /**
   * Wait for `ok` / `error` after each line (ms). Relief jobs often use low feed; a single `G1`
   * can exceed 10s, which caused false timeouts with the old default.
   */
  perLineTimeoutMs?: number;
  /**
   * Emit a `"stall"` diag event if no `ok`/`error` arrives for this many ms while waiting on one
   * line. The stream itself keeps waiting up to `perLineTimeoutMs`; this is just an early warning
   * so the UI can show "GRBL hasn't answered in 30 s" before the full 5-minute timeout fires.
   */
  stallWarnMs?: number;
  /**
   * Realtime `?` poll interval (ms) while waiting for `ok` on each line. Lower = faster disconnect
   * detection, more USB traffic. **0** disables heartbeats during streaming (quietest; link-loss
   * waits for `perLineTimeoutMs`). Omit for default (14s).
   */
  heartbeatMs?: number;
};

/**
 * Structured event the sender pushes to whoever subscribes via {@link GrblSerial.onDiagnostic}.
 * Keep this serializable (no functions / DOM refs) so the panel can JSON.stringify it into the
 * downloadable session log.
 */
export type GrblDiagnostic =
  | { t: number; kind: "tx"; line: string; index?: number; total?: number }
  | { t: number; kind: "rx"; line: string; ackMs?: number; forIndex?: number }
  | { t: number; kind: "ack"; ok: boolean; line: string; ackMs: number; forIndex?: number }
  | { t: number; kind: "heartbeat"; reason: string }
  | {
      t: number;
      kind: "stall";
      index: number;
      total: number;
      line: string;
      sinceAckMs: number;
    }
  | { t: number; kind: "timeout"; index: number; line: string; afterMs: number }
  | { t: number; kind: "error"; message: string; index?: number }
  /**
   * Disconnect event. `intentional: true` means the user clicked Disconnect (or another
   * intentional close path) and the UI should **not** show the red "USB link dropped" banner —
   * everything happened on purpose. `intentional: false` means a surprise drop (cable yanked,
   * port lost, writer stream errored mid-stream) which the user needs to know about.
   */
  | { t: number; kind: "disconnect"; reason: string; intentional: boolean }
  | { t: number; kind: "info"; message: string };

export class GrblSerial {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private textDecoder = new TextDecoder();
  private rxBuf = "";
  private ackResolvers: Array<{
    resolve: (ok: boolean, msg?: string) => void;
    sentAt: number;
    line: string;
    forIndex?: number;
  }> = [];
  /** Bound listener so we can `removeEventListener` on disconnect. */
  private boundOnDisconnect: ((ev: Event) => void) | null = null;
  /** Last time we received ANY byte from GRBL — used by the stall detector + diag output. */
  private lastRxAt = 0;
  /** Last time we received an `ok`/`error` (real ack, not a `<status>` heartbeat reply). */
  private lastAckAt = 0;
  /**
   * True while the user is in the middle of calling {@link disconnect}. During an intentional
   * disconnect the writer/reader streams close cleanly and the port fires its `disconnect` event
   * — all expected, none of which should trigger the panel's red "USB link dropped" banner. The
   * UI distinguishes "intentional" vs "surprise" via the {@link GrblDiagnostic.intentional} flag.
   */
  private disconnectInFlight = false;
  /** One-shot waiter for {@link queryWorkPosition} (resolved from next `<…>` line with `WPos`). */
  private wposWaiter: {
    resolve: (v: { x: number; y: number; z: number } | null) => void;
    tid: number;
  } | null = null;

  /**
   * Reject every in-flight `waitAck` (e.g. stuck mid–G-code stream). Replacing the array with `[]`
   * orphans those Promises forever and can make Unlock / Soft reset feel dead while the writer is wedged.
   */
  private rejectAllPendingAcks(reason: string): void {
    const pending = this.ackResolvers.splice(0, this.ackResolvers.length);
    for (const res of pending) {
      res.resolve(false, reason);
    }
  }

  /**
   * Subscribe to structured events. Called from the read pump, the stream loop, and connect/disconnect
   * hooks. The panel mirrors these into the serial log with timestamps and into a downloadable file.
   */
  onDiagnostic?: (event: GrblDiagnostic) => void;
  /** Legacy raw-line callback (used by RunPanel to mirror RX into the serial log). */
  onLine?: (line: string) => void;

  private emit(event: GrblDiagnostic): void {
    try {
      this.onDiagnostic?.(event);
    } catch {
      /** Never let UI callback bugs kill the sender. */
    }
  }

  isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.serial;
  }

  async connect(): Promise<void> {
    if (!this.isSupported()) {
      throw new Error("Web Serial is not available. Use Chrome or Edge on desktop.");
    }
    this.ackResolvers = [];
    const serial = navigator.serial;
    if (!serial) {
      throw new Error("Web Serial is not available.");
    }
    this.port = await serial.requestPort({});
    await this.port.open(serialPortOpenOptions());
    this.writer = this.port.writable!.getWriter();
    this.reader = this.port.readable!.getReader();
    this.lastRxAt = Date.now();
    this.lastAckAt = Date.now();

    /**
     * Web Serial fires `disconnect` on the port when the device goes away (USB unplugged, hub power
     * loss, sleep). Without this hook the stream loop sits in `waitAck` until the 5-minute timeout
     * fires — the user sees "Sending… 503/18925" frozen with no clue what happened. Reject every
     * pending ack with a clear reason so streamGcode throws and the UI shows it.
     *
     * Note: this fires for **surprise** USB events. User-initiated disconnects close the port
     * from our side (`port.close()`), which does NOT fire this listener — exactly what we want.
     */
    this.boundOnDisconnect = () => {
      this.emit({
        t: Date.now(),
        kind: "disconnect",
        reason: "USB serial port disconnect event",
        intentional: false,
      });
      this.rejectAllPendingAcks("USB serial port disconnect event");
    };
    this.port.addEventListener("disconnect", this.boundOnDisconnect);

    /**
     * If the writer's stream errors mid-stream (USB cable yanked, kernel driver crash), `closed`
     * rejects — that we always want to surface. A clean `closed` resolution, on the other hand,
     * happens during the user's intentional `disconnect()` call (we close it ourselves) — we
     * mark that one `intentional: true` so the panel doesn't show the red "USB link dropped"
     * banner for a normal Disconnect click.
     */
    if (this.writer.closed) {
      this.writer.closed
        .then(() => {
          this.emit({
            t: Date.now(),
            kind: "disconnect",
            reason: "Writer stream closed cleanly",
            intentional: this.disconnectInFlight,
          });
          this.rejectAllPendingAcks("Writer stream closed");
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.emit({
            t: Date.now(),
            kind: "disconnect",
            reason: `Writer stream errored: ${msg}`,
            intentional: false,
          });
          this.rejectAllPendingAcks(`Writer stream errored: ${msg}`);
        });
    }

    this.emit({ t: Date.now(), kind: "info", message: "Connected to serial port" });
    void this.pumpRead();
  }

  async disconnect(): Promise<void> {
    this.disconnectInFlight = true;
    if (this.wposWaiter) {
      window.clearTimeout(this.wposWaiter.tid);
      this.wposWaiter.resolve(null);
      this.wposWaiter = null;
    }
    this.rejectAllPendingAcks("disconnected (user)");
    if (this.boundOnDisconnect && this.port) {
      try {
        this.port.removeEventListener("disconnect", this.boundOnDisconnect);
      } catch {
        /* ignore */
      }
    }
    this.boundOnDisconnect = null;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    this.writer = null;
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.emit({ t: Date.now(), kind: "info", message: "Disconnected from serial port" });
    this.disconnectInFlight = false;
  }

  private async pumpRead(): Promise<void> {
    if (!this.reader) return;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.emit({
            t: Date.now(),
            kind: "disconnect",
            reason: "Read stream closed (port.readable ended)",
            intentional: this.disconnectInFlight,
          });
          this.rejectAllPendingAcks("Read stream closed");
          if (this.wposWaiter) {
            window.clearTimeout(this.wposWaiter.tid);
            this.wposWaiter.resolve(null);
            this.wposWaiter = null;
          }
          break;
        }
        if (value) {
          this.lastRxAt = Date.now();
          this.rxBuf += this.textDecoder.decode(value, { stream: true });
          const lines = this.rxBuf.split(/\r?\n/);
          this.rxBuf = lines.pop() ?? "";
          for (const line of lines) {
            const ln = line.trim();
            if (!ln) continue;
            const low = ln.toLowerCase();
            if (low.startsWith("ok") || low.startsWith("error")) {
              const ok = !low.startsWith("error");
              const head = this.ackResolvers.shift();
              if (head) {
                const ackMs = Date.now() - head.sentAt;
                this.lastAckAt = Date.now();
                this.emit({
                  t: Date.now(),
                  kind: "ack",
                  ok,
                  line: head.line,
                  ackMs,
                  forIndex: head.forIndex,
                });
                head.resolve(ok, ln);
              } else {
                this.emit({
                  t: Date.now(),
                  kind: "rx",
                  line: ln + "  (unmatched — no pending ack waiter)",
                });
              }
            } else {
              if (ln.startsWith("<") && this.wposWaiter) {
                const w = parseGrblStatusWPos(ln);
                if (w) {
                  window.clearTimeout(this.wposWaiter.tid);
                  const { resolve } = this.wposWaiter;
                  this.wposWaiter = null;
                  resolve(w);
                }
              }
              /** Status `<...>` heartbeat reply, startup banner, or other unsolicited line. */
              this.emit({ t: Date.now(), kind: "rx", line: ln });
            }
            this.onLine?.(ln);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        t: Date.now(),
        kind: "disconnect",
        reason: `Read pump error: ${msg}`,
        intentional: this.disconnectInFlight,
      });
      this.rejectAllPendingAcks(`Read pump error: ${msg}`);
      if (this.wposWaiter) {
        window.clearTimeout(this.wposWaiter.tid);
        this.wposWaiter.resolve(null);
        this.wposWaiter = null;
      }
      /** Release the port so the UI is not stuck “connected” to a dead handle (matches Candle disconnect UX). */
      try {
        await this.disconnect();
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
  }

  async sendRaw(line: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(line + "\n"));
  }

  /** GRBL realtime command, no newline (e.g. ?, !, ~, 0x18). */
  async sendRealtime(command: "?" | "!" | "~"): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(command));
  }

  /**
   * Sends realtime `?` and resolves with the next status report’s `WPos` (work X/Y/Z in mm).
   * `null` on timeout or if `WPos` is absent from the report (GRBL `$10` mask).
   */
  async queryWorkPosition(timeoutMs = 3000): Promise<{ x: number; y: number; z: number } | null> {
    if (!this.writer) throw new Error("Not connected");
    if (this.wposWaiter) {
      window.clearTimeout(this.wposWaiter.tid);
      this.wposWaiter.resolve(null);
      this.wposWaiter = null;
    }
    return new Promise((resolve) => {
      const tid = window.setTimeout(() => {
        if (this.wposWaiter?.tid === tid) {
          this.wposWaiter = null;
          resolve(null);
        }
      }, timeoutMs);
      this.wposWaiter = { resolve, tid };
      void this.sendRealtime("?");
    });
  }

  /** Raw bytes (no newline) — for GRBL realtime commands like soft reset 0x18. */
  async writeBytes(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(data);
  }

  /** Send one line and wait for ok/error (ordering-safe). */
  async sendCommand(line: string, timeoutMs = 10_000): Promise<void> {
    const sentAt = Date.now();
    this.emit({ t: sentAt, kind: "tx", line });
    await this.sendRaw(line);
    await this.waitAck({ timeoutMs, line, sentAt });
  }

  /**
   * GRBL realtime soft reset (Ctrl+X, byte 0x18). Do not append newline.
   * After this, flush any stale ok/error waiters — responses may be startup text, not ok.
   */
  async softReset(): Promise<void> {
    this.rejectAllPendingAcks("soft reset (Ctrl+X)");
    await this.writeBytes(new Uint8Array([0x18]));
  }

  /**
   * Clear GRBL alarm lock. Many boards ignore `$X` until after a realtime soft reset, so we send
   * 0x18, wait for boot text, then `$X` (same practical sequence as Candle when alarm won’t clear).
   */
  async unlockAlarm(): Promise<void> {
    this.rejectAllPendingAcks("alarm unlock");
    await this.writeBytes(new Uint8Array([0x18]));
    await new Promise((r) => window.setTimeout(r, 450));
    await this.sendCommand("$X");
  }

  /**
   * Wait for one `ok` / `error` after sending a command, with a liveness heartbeat and an early
   * stall warning.
   *
   * Heartbeat: realtime `?` every few seconds (see stream caller) — GRBL answers with `<…>`, which proves
   * the link is alive and helps the kernel notice a yanked USB cable sooner.
   *
   * Stall detection: if {@link stallWarnMs} is set and no ack arrives within that window, we emit
   * a `stall` diag event so the UI can surface "GRBL has not answered in N s" before the full
   * timeout fires.
   */
  private waitAck(args: {
    timeoutMs: number;
    line: string;
    sentAt: number;
    forIndex?: number;
    heartbeatMs?: number;
    stallWarnMs?: number;
    streamTotal?: number;
  }): Promise<void> {
    const { timeoutMs, line, sentAt, forIndex, heartbeatMs, stallWarnMs, streamTotal } = args;
    return new Promise((resolve, reject) => {
      let hb: number | undefined;
      let stallTimer: number | undefined;
      const cleanup = (): void => {
        window.clearTimeout(t);
        if (hb !== undefined) window.clearInterval(hb);
        if (stallTimer !== undefined) window.clearTimeout(stallTimer);
      };
      const t = window.setTimeout(() => {
        cleanup();
        this.emit({
          t: Date.now(),
          kind: "timeout",
          index: forIndex ?? -1,
          line,
          afterMs: Date.now() - sentAt,
        });
        reject(new Error("GRBL did not respond in time."));
      }, timeoutMs);
      if (heartbeatMs && heartbeatMs > 0 && this.writer) {
        hb = window.setInterval(() => {
          this.emit({ t: Date.now(), kind: "heartbeat", reason: "?" });
          this.sendRealtime("?").catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit({
              t: Date.now(),
              kind: "disconnect",
              reason: `Heartbeat write failed: ${msg}`,
              intentional: this.disconnectInFlight,
            });
            /** Outer timeout will still fire; rejecting here would also be safe but redundant. */
          });
        }, heartbeatMs);
      }
      if (stallWarnMs && stallWarnMs > 0) {
        stallTimer = window.setTimeout(() => {
          this.emit({
            t: Date.now(),
            kind: "stall",
            index: forIndex ?? -1,
            total: streamTotal ?? -1,
            line,
            sinceAckMs: Date.now() - sentAt,
          });
        }, stallWarnMs);
      }
      this.ackResolvers.push({
        resolve: (ok, msg) => {
          cleanup();
          if (ok) resolve();
          else reject(new Error(msg ?? "GRBL error"));
        },
        sentAt,
        line,
        forIndex,
      });
    });
  }

  /**
   * Stream G-code one line at a time, waiting for `ok` after each. The per-line timeout is large
   * (default 5 min) so slow relief moves don't false-trigger; a periodic status heartbeat keeps the
   * USB link warm and surfaces real disconnects. If a timeout does fire, the caller can resume
   * from the failed line via {@link parseStreamStoppedLineIndex}.
   */
  async streamGcode(
    gcode: string,
    onProgress?: (i: number, total: number) => void,
    shouldAbort?: () => boolean,
    opts?: StreamGcodeOpts,
  ): Promise<void> {
    const lines = parseGrblGcodeLines(gcode);
    const startIdx = Math.max(
      0,
      Math.min(Math.floor(opts?.startIndex ?? 0), Math.max(0, lines.length - 1)),
    );
    const perLineTimeoutMs = opts?.perLineTimeoutMs ?? 300_000;
    const hbOpt = opts?.heartbeatMs;
    const heartbeatMs =
      hbOpt !== undefined && hbOpt >= 0 && Number.isFinite(hbOpt) ? Math.floor(hbOpt) : 14_000;
    const stallWarnMs = opts?.stallWarnMs ?? 30_000;

    this.emit({
      t: Date.now(),
      kind: "info",
      message: `Stream start: lines=${lines.length}, startIndex=${startIdx}, perLineTimeoutMs=${perLineTimeoutMs}, stallWarnMs=${stallWarnMs}, heartbeatMs=${heartbeatMs}`,
    });

    for (let i = startIdx; i < lines.length; i++) {
      if (shouldAbort?.()) {
        this.emit({
          t: Date.now(),
          kind: "info",
          message: `Stream aborted by caller at line ${i + 1}/${lines.length}`,
        });
        break;
      }
      const line = lines[i];
      const sentAt = Date.now();
      this.emit({
        t: sentAt,
        kind: "tx",
        line,
        index: i,
        total: lines.length,
      });
      try {
        await this.sendRaw(line);
        await this.waitAck({
          timeoutMs: perLineTimeoutMs,
          line,
          sentAt,
          forIndex: i,
          heartbeatMs: heartbeatMs > 0 ? heartbeatMs : undefined,
          stallWarnMs,
          streamTotal: lines.length,
        });
      } catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        this.emit({
          t: Date.now(),
          kind: "error",
          message: `Stream error at line ${i + 1}: ${base}`,
          index: i,
        });
        throw new Error(`Stopped near line ${i + 1}/${lines.length}: ${line} (${base})`);
      }
      onProgress?.(i + 1, lines.length);
    }
  }
}

/** 0-based index for `StreamGcodeOpts.startIndex` from {@link GrblSerial.streamGcode} error text. */
export function parseStreamStoppedLineIndex(message: string): number | null {
  const m = message.match(/Stopped near line (\d+)\/\d+:/);
  if (!m) return null;
  const oneBased = parseInt(m[1], 10);
  if (!Number.isFinite(oneBased) || oneBased < 1) return null;
  return oneBased - 1;
}

/**
 * Parse GRBL 1.1 `?<…>` status report for **work** coordinates (`WPos`).
 * Returns `null` if the line is not a status report or `WPos` is missing (some `$10` masks).
 */
export function parseGrblStatusWPos(line: string): { x: number; y: number; z: number } | null {
  const t = line.trim();
  if (!t.startsWith("<") || !t.includes("WPos:")) return null;
  const m = /\|WPos:([^|>]+)/.exec(t);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length < 3 || !parts.every((n) => Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/** Strip parentheses + `;` comments for lightweight G-code parsing (resume XY). */
function stripGcodeInlineComments(line: string): string {
  const noParen = line.replace(/\([^)]*\)/g, "");
  const semi = noParen.indexOf(";");
  return (semi >= 0 ? noParen.slice(0, semi) : noParen).trim();
}

/**
 * Work-coordinate **X/Y after executing** lines `[0 .. lineIndex - 1]` of the same stripped array
 * {@link GrblSerial.streamGcode} uses. Used for resume preamble: rapid to this XY at safe Z so
 * the next streamed line does not diagonal-plow from an arbitrary stop position.
 *
 * Tracks **G90 / G91** on each line (order within a line: modal first, then coordinates on that
 * line use the modal in effect **after** G90/G91 tokens on the same line). Multiple `X`/`Y` words
 * on one line are applied together in incremental mode relative to the position at **line start**.
 */
export function workXYBeforeLineIndex(
  lines: string[],
  lineIndex: number,
): { x: number; y: number } | null {
  if (lineIndex <= 0 || lineIndex > lines.length) return null;

  let absMode = true;
  let x: number | null = null;
  let y: number | null = null;

  for (let i = 0; i < lineIndex; i++) {
    const raw = stripGcodeInlineComments(lines[i]).toUpperCase();
    if (!raw) continue;

    let lineAbsMode: boolean = absMode;
    const gModes = [...raw.matchAll(/\bG(90|91)\b/g)];
    for (const m of gModes) {
      const code = m[1];
      if (code === "90") lineAbsMode = true;
      else if (code === "91") lineAbsMode = false;
    }

    const xM = raw.match(/(?:^|\s)X(-?\d+(?:\.\d+)?)/);
    const yM = raw.match(/(?:^|\s)Y(-?\d+(?:\.\d+)?)/);
    const xv = xM && Number.isFinite(parseFloat(xM[1])) ? parseFloat(xM[1]) : null;
    const yv = yM && Number.isFinite(parseFloat(yM[1])) ? parseFloat(yM[1]) : null;
    if (xv === null && yv === null) {
      absMode = lineAbsMode;
      continue;
    }

    if (lineAbsMode) {
      if (xv !== null) x = xv;
      if (yv !== null) y = yv;
    } else {
      const bx: number = x ?? 0;
      const by: number = y ?? 0;
      if (xv !== null && yv !== null) {
        x = bx + xv;
        y = by + yv;
      } else if (xv !== null) {
        x = bx + xv;
      } else if (yv !== null) {
        y = by + yv;
      }
    }
    absMode = lineAbsMode;
  }

  if (x === null || y === null) return null;
  return { x, y };
}

/**
 * Resolve the target X/Y of a resume line, honoring G-code's modal semantics.
 *
 * If the resume line itself specifies X/Y (the common case for the first G0/G1 of a new
 * trace), those win. If it's a modal continuation (e.g. `G1 Z-3` plunge only), we walk back
 * through the preceding lines to find the most recent X and Y values — that is the bit's
 * current X/Y under G-code modality.
 *
 * Used by RunPanel's Resume preamble to lift to safe Z, then rapid to **this** X/Y before
 * letting the stream's first line execute. Without that, a Resume from a line like
 * `G1 X20 Y20 Z-2` would feed the bit on a *diagonal* from wherever it stopped (could be at
 * any depth and XY), plowing through whatever's in the way. That's the "drilling random
 * holes" symptom from the cnc-003 attempt.
 */
export function resumeTargetXY(
  lines: string[],
  index: number,
): { x: number; y: number } | null {
  if (index < 0 || index >= lines.length) return null;
  const xRe = /(?:^|\s)X(-?\d+(?:\.\d+)?)/;
  const yRe = /(?:^|\s)Y(-?\d+(?:\.\d+)?)/;
  let x: number | null = null;
  let y: number | null = null;
  for (let i = index; i >= 0; i--) {
    const line = lines[i].toUpperCase();
    if (x === null) {
      const m = line.match(xRe);
      if (m) {
        const parsed = parseFloat(m[1]);
        if (Number.isFinite(parsed)) x = parsed;
      }
    }
    if (y === null) {
      const m = line.match(yRe);
      if (m) {
        const parsed = parseFloat(m[1]);
        if (Number.isFinite(parsed)) y = parsed;
      }
    }
    if (x !== null && y !== null) break;
  }
  if (x === null || y === null) return null;
  return { x, y };
}
