"use client";

import { useAppState } from "@/context/AppState";
import { formatDuration, parseGcodeStats } from "@/lib/gcodeStats";
import {
  GrblSerial,
  injectSpindleCommands,
  parseGrblGcodeLines,
  parseStreamStoppedLineIndex,
  preflightGcode,
  reportGcodeSanitization,
  type GrblDiagnostic,
} from "@/lib/grblSerial";
import {
  buildResumePreamble,
  clearJobState,
  loadJobState,
  saveJobState,
  scanGcodeModalState,
} from "@/lib/gcodeRecovery";
import { getMachineOrDefault } from "@/lib/wizard";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Format milliseconds since epoch as `HH:MM:SS.mmm` for the serial log. Local time so it matches
 * a wall clock if the user is troubleshooting beside the machine.
 */
function fmtTs(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const mmm = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Render one structured event as a single human-readable line for the serial log. Keep these
 * compact so they don't blow out the 400-line ring buffer too quickly; the full structured
 * record is preserved in the downloadable JSON log.
 */
function diagToLogLine(ev: GrblDiagnostic): string {
  const ts = fmtTs(ev.t);
  switch (ev.kind) {
    case "tx":
      return ev.index != null && ev.total != null
        ? `[${ts}] tx #${ev.index + 1}/${ev.total}  ${ev.line}`
        : `[${ts}] tx  ${ev.line}`;
    case "rx":
      return `[${ts}] rx  ${ev.line}${ev.ackMs != null ? `  (+${ev.ackMs}ms)` : ""}`;
    case "ack":
      return `[${ts}] ack ${ev.ok ? "ok" : "ERROR"} in ${ev.ackMs}ms  ${ev.line}`;
    case "heartbeat":
      return `[${ts}] heartbeat ${ev.reason}`;
    case "stall":
      return `[${ts}] !! STALL — no ack for line ${ev.index + 1}/${ev.total} in ${ev.sinceAckMs}ms (line: ${ev.line})`;
    case "timeout":
      return `[${ts}] !! TIMEOUT — no ack for line ${ev.index + 1} after ${ev.afterMs}ms (line: ${ev.line})`;
    case "error":
      return `[${ts}] !! ERROR — ${ev.message}`;
    case "disconnect":
      return ev.intentional
        ? `[${ts}] disconnect (intentional) — ${ev.reason}`
        : `[${ts}] !! DISCONNECT — ${ev.reason}`;
    case "info":
      return `[${ts}] info  ${ev.message}`;
  }
}

const JOG_FEED = 800;
/** Per-line `ok` wait while streaming (ms). Slow relief feeds can exceed 10s per move. */
const STREAM_PER_LINE_TIMEOUT_MS = 300_000;
const HOMING_TIMEOUT_MS = 180_000;
/**
 * On resume only: nudge **up** in **G91** so a buried bit clears stock before the next streamed line.
 * X/Y are **not** moved by the app — GRBL stays at the stopped coordinates until your G-code says otherwise.
 */
const RESUME_RELATIVE_Z_CLEAR_MM = 12;

/** Parse line number from the resume box: digits, optional commas/spaces, or paste `15984/129946`. */
function parseResumeLineNumberInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const noSep = t.replace(/[,_'’\s]+/g, "");
  const head = noSep.split("/")[0] ?? noSep;
  const m = head.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/** Dark-panel controls: readable on CNCarve’s slate sidebar (avoids white-on-white). */
const btnSecondaryFull =
  "rounded-lg border border-slate-500/90 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 shadow-sm hover:bg-slate-700 hover:border-teal-500/60 disabled:pointer-events-none disabled:opacity-40";
const btnCompact =
  "rounded-md border border-slate-500/90 bg-slate-800 px-2 py-1.5 text-[11px] font-semibold text-slate-100 shadow-sm hover:bg-slate-700 hover:border-teal-500/60 disabled:pointer-events-none disabled:opacity-40";
const panelBoxFull =
  "rounded-xl border border-white/10 bg-slate-950/80 p-4 shadow-inner ring-1 ring-white/5";
const panelCompact =
  "rounded-lg border border-white/10 bg-slate-950/80 p-2 shadow-inner ring-1 ring-white/5";

export function RunPanel({
  gcodeSourceHint,
  compact = false,
}: {
  gcodeSourceHint?: string;
  compact?: boolean;
}) {
  const b = compact ? btnCompact : btnSecondaryFull;
  const p = compact ? panelCompact : panelBoxFull;
  const gap = compact ? "space-y-1.5" : "space-y-4";
  const {
    answers,
    exportedGcode,
    setExportedGcode,
    appendSerialLog,
    serialLog,
    clearSerialLog,
  } = useAppState();
  /** When Kiri comments omit spindle RPM (minimal `.nc` export), use a sane 3018 default, not 10k blind guess. */
  const defaultInjectRpm = useMemo(() => {
    const p = getMachineOrDefault(answers.machineId);
    return Math.min(p.spindleMaxRpm, 8000);
  }, [answers.machineId]);
  const serialRef = useRef(new GrblSerial());
  /** While streaming G-code, keeps the display awake (Chrome) so dim/saver is less likely to throttle the tab. */
  const streamWakeLockRef = useRef<WakeLockSentinel | null>(null);
  const abortRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const [jogMm, setJogMm] = useState(1);
  const [lastError, setLastError] = useState<string | null>(null);
  /**
   * Full structured event log from GrblSerial. Capped at 20k events (~ a few MB) to avoid OOM
   * on very long sessions but big enough for an 8-hour carve. User can download as JSON to
   * share with us when something fails — that's the actual goal here.
   */
  const diagEventsRef = useRef<GrblDiagnostic[]>([]);
  /**
   * "Stall" banner shown while GRBL is silent for more than ~30 s during streaming. Clears on the
   * next ack or on stream stop. This is the specific symptom behind "machine stopped, no message":
   * the stream is sitting in `waitAck` and the user has no way to know.
   */
  const [stallInfo, setStallInfo] = useState<
    | null
    | {
        line: string;
        index: number;
        total: number;
        sinceMs: number;
        wallClockAt: number;
      }
  >(null);
  /**
   * When the loaded G-code lacks `M3`/`M4` but has cutting moves, we refuse to stream and surface
   * this banner with a one-click "inject M3 + M5" recovery. Auto-injection is **opt-in** — silently
   * adding spindle commands when the user expected a different RPM is its own foot-gun, but we
   * also can NEVER let the bit drag through wood with the spindle off (which is what cnc-006.nc
   * just did and broke the user's day).
   */
  const [spindleSafetyBlocker, setSpindleSafetyBlocker] = useState<
    | null
    | {
        hasCutting: boolean;
        hasSpindleOff: boolean;
        suggestedRpm: number;
      }
  >(null);
  /** 0-based line into stripped G-code; set when a stream errors so we can offer “Resume job”. */
  const [jobResumeAtIndex, setJobResumeAtIndex] = useState<number | null>(null);
  /** Manual resume: left number from `Line X/Y` equals next 0-based index; “Stopped near line N” uses error mode. */
  const [manualResumeInput, setManualResumeInput] = useState("");
  const [manualResumeMode, setManualResumeMode] = useState<"progress" | "error">("progress");
  /** Last work X/Y/Z from GRBL status (`WPos`) — see “Read work XYZ”. */
  const [lastWorkPos, setLastWorkPos] = useState<{
    x: number;
    y: number;
    z: number;
  } | null>(null);
  /** Last successfully ack'd 0-based line of the **current** stream; used as fallback resume index. */
  const lastAckedIndexRef = useRef<number | null>(null);
  /** True between stream start and `finally` in `streamFromIndex` (for USB-drop context logging). */
  const streamActiveRef = useRef(false);
  /** Live 1-based progress shown in the UI ("Sending… 4321/12889"). */
  const [streamProgress, setStreamProgress] = useState<{ i: number; total: number } | null>(
    null,
  );
  /** After G10 L20, GRBL must return `ok` before we show success — gives visible confidence. */
  const [workZeroStatus, setWorkZeroStatus] = useState<"idle" | "pending" | "done">(
    "idle",
  );
  const workZeroBannerClearRef = useRef<number | null>(null);
  const parsed = useMemo(() => parseGcodeStats(exportedGcode), [exportedGcode]);

  const STREAM_HEARTBEAT_STORAGE_KEY = "cnccarve.grblStreamHeartbeatMs";
  const readStreamHeartbeatMs = useCallback((): number => {
    if (typeof window === "undefined") return 14_000;
    const raw = window.localStorage.getItem(STREAM_HEARTBEAT_STORAGE_KEY);
    if (raw == null || raw === "") return 14_000;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 14_000;
    return n;
  }, []);

  const [streamHeartbeatMs, setStreamHeartbeatMs] = useState(14_000);
  /** True after a successful $H home cycle this session — required for EEPROM-based WCS recovery. */
  const [hasHomed, setHasHomed] = useState(false);
  /** Non-null when the loaded G-code matches a saved mid-job state (USB drop recovery). */
  const [savedRecovery, setSavedRecovery] = useState<{
    lineIndex: number;
    lineCount: number;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    setStreamHeartbeatMs(readStreamHeartbeatMs());
  }, [readStreamHeartbeatMs]);

  const persistStreamHeartbeatMs = useCallback((ms: number) => {
    setStreamHeartbeatMs(ms);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STREAM_HEARTBEAT_STORAGE_KEY, String(ms));
    }
  }, []);

  useEffect(
    () => () => {
      if (workZeroBannerClearRef.current != null) {
        window.clearTimeout(workZeroBannerClearRef.current);
      }
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setJobResumeAtIndex(null);
    lastAckedIndexRef.current = null;
    setStreamProgress(null);
  }, [exportedGcode]);

  const releaseStreamWakeLock = useCallback(async () => {
    const w = streamWakeLockRef.current;
    streamWakeLockRef.current = null;
    if (!w) return;
    try {
      await w.release();
    } catch {
      /* already released */
    }
  }, []);

  const acquireStreamWakeLock = useCallback(async () => {
    const held = streamWakeLockRef.current;
    if (held && !held.released) return;
    await releaseStreamWakeLock();
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      appendSerialLog(
        "(No Screen Wake Lock in this browser — keep this tab in front for long jobs; turn off the screen saver if you still see stalls.)",
      );
      return;
    }
    try {
      const sent = await navigator.wakeLock!.request("screen");
      streamWakeLockRef.current = sent;
      sent.addEventListener("release", () => {
        streamWakeLockRef.current = null;
        appendSerialLog("(Screen wake lock released by browser/OS)");
      });
      appendSerialLog(
        "(Screen wake lock on while sending — display stays awake; reduces saver-related stalls.)",
      );
    } catch {
      appendSerialLog(
        "(Screen wake lock not granted — keep Chrome focused; disable screen saver for multi-hour carves.)",
      );
    }
  }, [appendSerialLog, releaseStreamWakeLock]);

  useEffect(() => {
    if (!streaming) return;
    const onVis = () => {
      if (document.visibilityState === "visible") void acquireStreamWakeLock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [streaming, acquireStreamWakeLock]);

  useEffect(() => {
    if (!streaming) {
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      return;
    }
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
    }
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => {
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [streaming]);

  /** Check for a saved job state whenever G-code changes (e.g. after Kiri export). */
  useEffect(() => {
    if (!exportedGcode.trim()) {
      setSavedRecovery(null);
      return;
    }
    const saved = loadJobState(exportedGcode);
    setSavedRecovery(saved);
  }, [exportedGcode]);

  const supported =
    typeof navigator !== "undefined" && !!navigator.serial;

  const wireLog = useCallback(
    (line: string) => {
      appendSerialLog(line);
    },
    [appendSerialLog],
  );

  /**
   * Funnel every structured GRBL event into:
   *   1. the ring-buffered serial log shown in the UI,
   *   2. the unbounded diag array for the downloadable JSON log,
   *   3. high-priority UI updates (stall banner, disconnect → setLastError).
   *
   * This is the heart of "why did the machine stop" — every silent failure GrblSerial used to
   * swallow now lands here and surfaces.
   */
  const handleDiag = useCallback(
    (ev: GrblDiagnostic) => {
      const buf = diagEventsRef.current;
      if (buf.length >= 20_000) {
        buf.splice(0, buf.length - 19_500);
      }
      buf.push(ev);
      appendSerialLog(diagToLogLine(ev));

      if (ev.kind === "ack") {
        setStallInfo(null);
      }
      if (ev.kind === "stall") {
        setStallInfo({
          line: ev.line,
          index: ev.index,
          total: ev.total,
          sinceMs: ev.sinceAckMs,
          wallClockAt: ev.t,
        });
      }
      if (ev.kind === "disconnect") {
        setStallInfo(null);
        setHasHomed(false);
        /**
         * Only shout when it's a SURPRISE drop. Clean closes during a Disconnect-button click
         * (reader.cancel, writer.close, port.close) all emit disconnect events with
         * intentional=true; those are not failures and must not look like one.
         */
        if (!ev.intentional) {
          const wasStreamingFile = streamActiveRef.current;
          /** Persist line index so the user can recover after rehoming. */
          if (wasStreamingFile) {
            const lastAck = lastAckedIndexRef.current;
            if (lastAck !== null && lastAck >= 0 && exportedGcode.trim()) {
              const total = parseGrblGcodeLines(exportedGcode).length;
              saveJobState(exportedGcode, lastAck + 1, total);
              setSavedRecovery({ lineIndex: lastAck + 1, lineCount: total });
            }
          }
          setStreaming(false);
          streamActiveRef.current = false;
          void releaseStreamWakeLock();
          setConnected(false);
          setLastError(
            `USB/serial link dropped: ${ev.reason}. The serial port was closed — use Connect again after replugging the machine. If failures only happen with the spindle powered but an air run (spindle unplugged, Z safe) finishes, suspect router EMI or shared power. Download the diagnostic log before retrying. Open “Stops mid-job?” below for a short checklist.`,
          );
          if (
            wasStreamingFile &&
            /device has been lost|Read pump/i.test(ev.reason)
          ) {
            const total = parseGrblGcodeLines(exportedGcode).length;
            /** 1-based line we were most likely waiting on (see `lastAckedIndexRef` updates in stream loop). */
            const oneBased = (lastAckedIndexRef.current ?? -1) + 2;
            if (total > 10 && oneBased >= 1 && oneBased <= total) {
              try {
                const prevRaw = window.sessionStorage.getItem("cnccarve.prevUsbDropLine");
                const prev = prevRaw != null ? parseInt(prevRaw, 10) : NaN;
                window.sessionStorage.setItem("cnccarve.prevUsbDropLine", String(oneBased));
                if (Number.isFinite(prev) && prev >= 1) {
                  const span = Math.abs(oneBased - prev);
                  const loose = Math.max(80, Math.ceil(total * 0.012));
                  if (span <= loose) {
                    appendSerialLog(
                      `(USB dropped near the same stream area again: ~line ${oneBased}/${total}, previous ~${prev}. Often that is coincidence: a long slow cut takes the same wall-clock each pass, so the failure “lines up” with file position. Candle failing too means the Mac or USB path lost the device — not CNCarve timing out from idle. Try: Terminal “caffeinate -dims” for the whole job; different USB port; no hub. Below, set “USB stream polling” to Off to send fewer “?” status bytes.)`,
                    );
                  }
                }
              } catch {
                /* sessionStorage unavailable */
              }
            }
          }
        }
      }
      if (ev.kind === "timeout") {
        setLastError(
          `GRBL did not answer line ${ev.index + 1} for ${Math.round(ev.afterMs / 1000)}s. This is almost always: USB/power glitch, controller crash, or bad cable. Use Resume job after a soft reset; download the diagnostic log below to share with us.`,
        );
      }
    },
    [appendSerialLog, exportedGcode, releaseStreamWakeLock],
  );

  const connect = async () => {
    setLastError(null);
    try {
      const s = serialRef.current;
      s.onLine = wireLog;
      s.onDiagnostic = handleDiag;
      await s.connect();
      setConnected(true);
      appendSerialLog("--- Connected ---");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = async () => {
    setStreaming(false);
    abortRef.current = true;
    if (workZeroBannerClearRef.current != null) {
      window.clearTimeout(workZeroBannerClearRef.current);
      workZeroBannerClearRef.current = null;
    }
    setWorkZeroStatus("idle");
    void releaseStreamWakeLock();
    setLastWorkPos(null);
    await serialRef.current.disconnect();
    setConnected(false);
    appendSerialLog("--- Disconnected ---");
  };

  const jog = async (axis: "X" | "Y" | "Z", dir: 1 | -1) => {
    if (!connected) return;
    const d = jogMm * dir;
    const axisMove =
      axis === "X" ? `X${d}` : axis === "Y" ? `Y${d}` : `Z${d}`;
    try {
      await serialRef.current.sendCommand("G21");
      await serialRef.current.sendCommand("G91");
      await serialRef.current.sendCommand(`G0 ${axisMove} F${JOG_FEED}`);
      await serialRef.current.sendCommand("G90");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const zeroWorkpiece = async () => {
    if (!connected) return;
    setLastError(null);
    if (workZeroBannerClearRef.current != null) {
      window.clearTimeout(workZeroBannerClearRef.current);
      workZeroBannerClearRef.current = null;
    }
    setWorkZeroStatus("pending");
    try {
      await serialRef.current.sendCommand("G10 L20 P1 X0 Y0 Z0");
      appendSerialLog(
        "✓ Work zero — G10 L20 P1 X0 Y0 Z0 sent; GRBL replied ok (this position is now work X0 Y0 Z0).",
      );
      setWorkZeroStatus("done");
      workZeroBannerClearRef.current = window.setTimeout(() => {
        workZeroBannerClearRef.current = null;
        setWorkZeroStatus("idle");
      }, 14_000);
    } catch (e) {
      setWorkZeroStatus("idle");
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const unlockAlarm = async () => {
    if (!connected) return;
    setLastError(null);
    setStreaming(false);
    try {
      await serialRef.current.unlockAlarm();
      appendSerialLog("(Alarm clear: Ctrl+X then $X — watch serial log for ok or error)");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const softReset = async () => {
    if (!connected) return;
    setLastError(null);
    setStreaming(false);
    try {
      await serialRef.current.softReset();
      appendSerialLog("(Soft reset — Ctrl+X / 0x18, same idea as Candle)");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const machineHome = async () => {
    if (!connected || streaming) return;
    setLastError(null);
    try {
      appendSerialLog("--- Homing cycle $H started (driving to limit switches) ---");
      await serialRef.current.sendCommand("$H", HOMING_TIMEOUT_MS);
      appendSerialLog("--- Homing complete — machine coordinates established; G54 work offset restored from EEPROM ---");
      setHasHomed(true);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const goWorkZero = async () => {
    if (!connected || streaming) return;
    setLastError(null);
    try {
      await serialRef.current.sendCommand("G90");
      await serialRef.current.sendCommand("G0 X0 Y0");
      appendSerialLog("(Moved to work X0 Y0)");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  const reportStatus = async () => {
    if (!connected) return;
    setLastError(null);
    try {
      await serialRef.current.sendRealtime("?");
      appendSerialLog("(Status query ?)");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Parse next GRBL `<…>` report for `WPos` (work coordinates vs current G54 origin). */
  const readWorkPosition = async () => {
    if (!connected || streaming) return;
    setLastError(null);
    try {
      const w = await serialRef.current.queryWorkPosition();
      if (w) {
        setLastWorkPos(w);
        appendSerialLog(
          `(Work XYZ from GRBL WPos: X${w.x.toFixed(3)} Y${w.y.toFixed(3)} Z${w.z.toFixed(3)} mm. ` +
            `These are distances from your work zero — the point where you pressed “Set work zero” is X0 Y0 Z0.)`,
        );
      } else {
        setLastWorkPos(null);
        appendSerialLog(
          "(No WPos parsed — timed out or GRBL status mask hides WPos. Try Status (?) and check the raw line; $10 may need WPos enabled.)",
        );
        setLastError(
          "Could not read WPos. Try again, or check GRBL $10 so status reports include work position.",
        );
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Shared run + resume body. {@param startIndex} is 0-based into stripped lines. */
  const streamFromIndex = async (startIndex: number, { skipBuiltinPreamble = false } = {}) => {
    setLastError(null);
    setJobResumeAtIndex(null);
    setSpindleSafetyBlocker(null);
    lastAckedIndexRef.current = null;
    /**
     * Hard pre-flight: never send a file with cutting moves but no `M3`/`M4` spindle-on. This
     * is the exact failure mode of cnc-006.nc: bit drags stationary through wood, ruining the
     * bit and the workpiece. We block the stream and surface a one-click "inject M3 + M5"
     * recovery so the user can either fix the file or regenerate it.
     */
    const preflight = preflightGcode(exportedGcode);
    if (preflight.hasCuttingMoves && !preflight.hasSpindleOn) {
      setSpindleSafetyBlocker({
        hasCutting: preflight.hasCuttingMoves,
        hasSpindleOff: preflight.hasSpindleOff,
        suggestedRpm: preflight.detectedSpindleRpm ?? defaultInjectRpm,
      });
      setLastError(
        "BLOCKED FOR SAFETY: the loaded G-code has cutting moves but no spindle-on command (M3/M4). Running it would drag the bit through wood with the spindle off and damage the bit and machine. Use the yellow recovery panel below to inject a safe M3 / M5, or regenerate the G-code.",
      );
      setStreaming(false);
      if (startIndex > 0) {
        setJobResumeAtIndex(startIndex);
      }
      return;
    }
    abortRef.current = false;
    streamActiveRef.current = false;
    setStreaming(true);
    setElapsedSec(0);
    const lines = parseGrblGcodeLines(exportedGcode);
    const total = lines.length;
    setStreamProgress({ i: startIndex, total });
    /**
     * Surface what the sanitizer removed BEFORE we start the stream. The user sees their gcode
     * "has N lines" in their text editor but we're sending fewer — without this they'd think
     * something was silently wrong (or that progress percentages were lying). This also tells
     * them WHY the previous `error:20` on M6 won't recur.
     */
    if (startIndex === 0) {
      const sanitization = reportGcodeSanitization(exportedGcode);
      if (sanitization.m6Removed + sanitization.toolSelectRemoved > 0) {
        const bits: string[] = [];
        if (sanitization.m6Removed > 0) {
          bits.push(
            `${sanitization.m6Removed} × M6 tool-change line${sanitization.m6Removed === 1 ? "" : "s"}`,
          );
        }
        if (sanitization.toolSelectRemoved > 0) {
          bits.push(
            `${sanitization.toolSelectRemoved} × bare T<n> tool-select line${sanitization.toolSelectRemoved === 1 ? "" : "s"}`,
          );
        }
        appendSerialLog(
          `(Pre-stream sanitize: removed ${bits.join(" + ")} — stock GRBL 1.1 rejects these with error:20. Bit motion is unchanged.)`,
        );
        for (const sample of sanitization.samples) {
          appendSerialLog(`  · ${sample}`);
        }
      }
    }
    /**
     * Resume safety preamble.
     *
     * The bug it prevents: when the stream stopped mid-job the bit could be buried. The **first**
     * resumed line is often a feed move with a new target, which can plow a diagonal through stock.
     *
     * Strategy: send only a **relative Z up** (G91), then **G90**. We do **not** change X/Y — the
     * machine stays at the coordinates where it stopped until the streamed G-code commands motion.
     * That matches “continue from this spot” as long as GRBL’s pose still matches the job (no jog
     * / lost steps after the stop). The next line may still move in X/Y/Z per the file; at least
     * Z is usually a bit higher first so a buried bit is less likely to drag sideways in the cut.
     */
    if (startIndex > 0 && !skipBuiltinPreamble) {
      appendSerialLog(
        `--- Resume job from line ${startIndex + 1}/${total} ` +
          `(preamble: G91 Z+${RESUME_RELATIVE_Z_CLEAR_MM} mm lift only — X/Y unchanged) ---`,
      );
      try {
        await serialRef.current.sendCommand("G21");
        await serialRef.current.sendCommand("G90");
        await serialRef.current.sendCommand("G91");
        await serialRef.current.sendCommand(`G0 Z${RESUME_RELATIVE_Z_CLEAR_MM}`);
        await serialRef.current.sendCommand("G90");
        appendSerialLog(
          "--- Resume preamble done — streaming next; XY still at stop position unless the file moves them ---",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLastError(
          `Resume preamble failed: ${msg}. Streaming was NOT started — fix the controller state (Unlock, Soft reset) and try again.`,
        );
        setStreaming(false);
        /** We cleared `jobResumeAtIndex` at the start of this run; restore so you can retry Resume. */
        if (startIndex > 0) {
          setJobResumeAtIndex(startIndex);
        }
        return;
      }
    }
    await acquireStreamWakeLock();
    let parsedErrorIdx: number | null = null;
    try {
      streamActiveRef.current = true;
      appendSerialLog(
        `(Stream USB polling: ${streamHeartbeatMs === 0 ? "off (quietest)" : `every ${Math.round(streamHeartbeatMs / 1000)} s`} — change under “Send to machine” if drops repeat.)`,
      );
      await serialRef.current.streamGcode(
        exportedGcode,
        (i, t) => {
          lastAckedIndexRef.current = i - 1;
          setStreamProgress({ i, total: t });
          if (i % 50 === 0 && exportedGcode.trim()) {
            saveJobState(exportedGcode, i, t);
          }
          if (i % 100 === 0 || i === t) {
            appendSerialLog(`Stream ${i}/${t}`);
          }
        },
        () => abortRef.current,
        {
          startIndex,
          perLineTimeoutMs: STREAM_PER_LINE_TIMEOUT_MS,
          heartbeatMs: streamHeartbeatMs,
        },
      );
      appendSerialLog("--- Stream finished ---");
      clearJobState();
      setSavedRecovery(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      parsedErrorIdx = parseStreamStoppedLineIndex(msg);
    } finally {
      streamActiveRef.current = false;
      setStreaming(false);
      setStallInfo(null);
      void releaseStreamWakeLock();
    }
    /**
     * Pick a resume point: error line if known, else last ack'd line + 1 (where we'd go next).
     * If neither (e.g. aborted before first ack), fall back to where we started this run.
     */
    const lastAck = lastAckedIndexRef.current;
    let resumeAt: number | null = null;
    if (parsedErrorIdx !== null) {
      resumeAt = parsedErrorIdx;
    } else if (lastAck !== null) {
      /** Next line to send after the last ack'd line (0-based). Do not cap at `length - 1` — that hid Resume when only the final line was left. */
      resumeAt = lastAck + 1;
    } else if (abortRef.current) {
      resumeAt = startIndex;
    }
    if (resumeAt !== null && resumeAt < lines.length) {
      setJobResumeAtIndex(resumeAt);
      setManualResumeInput(String(resumeAt));
      setManualResumeMode("progress");
    } else {
      setJobResumeAtIndex(null);
    }
  };

  /**
   * Apply the safety patch (M3 + M5 injection) and replace the loaded G-code. After this the
   * `exportedGcode` in app state is the corrected file — same flow as if the user had pasted a
   * fixed version. The `useEffect` watching `exportedGcode` clears resume index / progress.
   */
  const applySpindleSafetyInject = (rpm: number) => {
    if (!exportedGcode.trim()) return;
    const patched = injectSpindleCommands(exportedGcode, rpm);
    flushSync(() => {
      setExportedGcode(patched);
    });
    setSpindleSafetyBlocker(null);
    setLastError(null);
    appendSerialLog(
      `(Spindle-safety inject applied: stripped M6 if present, inserted M3 S${rpm} + G4 P2 before first motion, M5 before M30. Loaded G-code updated — click Send again.)`,
    );
  };

  const runJob = async () => {
    if (!exportedGcode.trim()) {
      setLastError(
        "No G-code yet — finish step 1 (Load from Kiri or paste), then come back here.",
      );
      return;
    }
    await streamFromIndex(0);
  };

  const resumeJob = async () => {
    if (!exportedGcode.trim() || jobResumeAtIndex === null) return;
    await streamFromIndex(jobResumeAtIndex);
  };

  /**
   * Full USB-drop recovery:
   *  1. $H — drives machine to limit switches, establishing machine coords;
   *     G54 WCS survives in GRBL EEPROM so work origin is restored automatically.
   *  2. Scan G-code 0..N-1 to reconstruct modal state (units, WCS, feed rate, spindle, position).
   *  3. Send UGS-style preamble: modal codes → safe-Z retract → XY rapid → spindle on → Z plunge.
   *  4. Stream G-code from line N without any additional preamble.
   */
  const recoverJob = async () => {
    if (!exportedGcode.trim() || savedRecovery === null || !connected) return;
    setRecovering(true);
    setLastError(null);
    try {
      appendSerialLog("--- Recovery: $H — driving to limit switches to restore machine coordinates ---");
      await serialRef.current.sendCommand("$H", HOMING_TIMEOUT_MS);
      appendSerialLog("--- Recovery: homing done; G54 work offset restored from EEPROM ---");
      setHasHomed(true);

      const lines = parseGrblGcodeLines(exportedGcode);
      const resumeIdx = Math.min(savedRecovery.lineIndex, lines.length - 1);
      const modalState = scanGcodeModalState(lines, resumeIdx);
      const preamble = buildResumePreamble(modalState);

      appendSerialLog(
        `--- Recovery preamble: ${preamble.length} lines to position tool at resume point (line ${resumeIdx + 1}/${lines.length}) ---`,
      );
      for (const cmd of preamble) {
        await serialRef.current.sendCommand(cmd, 60_000);
      }
      appendSerialLog("--- Recovery preamble done — resuming stream ---");

      setSavedRecovery(null);
      clearJobState();
      await streamFromIndex(resumeIdx, { skipBuiltinPreamble: true });
    } catch (e) {
      setLastError(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecovering(false);
    }
  };

  const strippedLineCount = useMemo(
    () => parseGrblGcodeLines(exportedGcode).length,
    [exportedGcode],
  );

  const setResumeFromProgressLeftNumber = useCallback(() => {
    if (!streamProgress || strippedLineCount <= 0) return;
    const idx = Math.min(Math.max(0, streamProgress.i), strippedLineCount - 1);
    setJobResumeAtIndex(idx);
    setLastError(null);
    appendSerialLog(
      `(Resume point set from progress Line ${streamProgress.i}/${streamProgress.total} → continue from stripped line ${idx + 1}/${strippedLineCount}.)`,
    );
  }, [appendSerialLog, streamProgress, strippedLineCount]);

  const applyManualResumePoint = useCallback(() => {
    if (strippedLineCount <= 0) {
      setLastError("Load G-code first.");
      return;
    }
    let n = parseResumeLineNumberInput(manualResumeInput);
    let usedProgressFallback = false;
    if (n === null && streamProgress != null && streamProgress.i >= 1) {
      n = streamProgress.i;
      usedProgressFallback = true;
    }
    if (n === null || n < 1) {
      const hint = manualResumeInput.trim()
        ? `Could not read a number from “${manualResumeInput.trim().slice(0, 48)}${manualResumeInput.trim().length > 48 ? "…" : ""}”. Use digits (e.g. 15984) or paste 15984/129946.`
        : "Type the left number from Line X/Y (e.g. 15984), or click “Resume = progress” if that row is still visible.";
      setLastError(hint);
      return;
    }
    let idx: number;
    if (manualResumeMode === "progress") {
      idx = Math.min(Math.max(0, n), strippedLineCount - 1);
    } else {
      idx = Math.min(Math.max(0, n - 1), strippedLineCount - 1);
    }
    setJobResumeAtIndex(idx);
    setLastError(null);
    appendSerialLog(
      `(Manual resume: ${manualResumeMode === "progress" ? "progress-style" : "Stopped-near-style"} ${n} → continue from stripped line ${idx + 1}/${strippedLineCount}${usedProgressFallback ? " (number box was empty — used progress Line value)" : ""}.)`,
    );
  }, [appendSerialLog, manualResumeInput, manualResumeMode, streamProgress, strippedLineCount]);

  const stopHold = async () => {
    abortRef.current = true;
    try {
      await serialRef.current.sendRealtime("!");
      appendSerialLog("(Feed hold !)");
    } catch {
      /* ignore */
    }
  };

  /**
   * Save the full structured event buffer as a JSON file. Filename includes the timestamp so
   * multiple downloads from one session don't overwrite each other. This is the artifact you
   * (the user) send to us when something fails — every TX, RX, ack timing, stall warning,
   * timeout, and disconnect reason from the session is in there.
   */
  const downloadDiagLog = useCallback(() => {
    const events = diagEventsRef.current.slice();
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const payload = {
      generatedAt: new Date().toISOString(),
      eventCount: events.length,
      lastError,
      streaming,
      gcodeLines: parseGrblGcodeLines(exportedGcode).length,
      events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cncarve-diag-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    /** Slight delay before revoke so Safari/Firefox finish reading the blob. */
    window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
  }, [exportedGcode, lastError, streaming]);

  /** GRBL cycle-start: clears feed hold from `!` on the controller — does not restart our G-code sender. */
  const cycleStart = async () => {
    if (!connected) return;
    try {
      await serialRef.current.sendRealtime("~");
      appendSerialLog("(Cycle start ~ — unpause GRBL after feed hold)");
    } catch {
      /* ignore */
    }
  };

  if (!supported) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-4 text-sm text-amber-100">
        <p className="font-medium">Machine control needs Chrome or Edge</p>
        <p className="mt-2 text-amber-200/90">
          Safari does not expose USB serial for web pages. Install Chrome or Edge
          on your PC or Mac to connect and run jobs from this tab.
        </p>
      </div>
    );
  }

  return (
    <div
      className={
        /** Compact: do not `flex-1 overflow-hidden` — Machine popout scrolls the panel; that combo clipped the resume UI. */
        compact
          ? `${gap} flex min-h-0 flex-col`
          : gap
      }
    >
      {stallInfo && (
        <div
          className={
            compact
              ? "rounded-md border border-amber-500/60 bg-amber-950/60 px-2 py-1.5 text-[11px] text-amber-100"
              : "rounded-lg border border-amber-500/60 bg-amber-950/60 px-3 py-2 text-sm text-amber-100"
          }
          role="status"
          aria-live="polite"
        >
          <strong className="font-semibold text-amber-50">
            GRBL has not answered for {Math.round(stallInfo.sinceMs / 1000)} s.
          </strong>
          {" "}
          Last sent line {stallInfo.index + 1}/{stallInfo.total}:{" "}
          <span className="font-mono">{stallInfo.line}</span>. We're still
          waiting up to 5 minutes; if nothing comes back, the stream will time
          out and you can use Resume job. Common causes: USB cable, computer
          sleeping, machine controller crash. Download the diagnostic log below
          before retrying.
        </div>
      )}
      {lastError && (
        <div
          className={
            compact
              ? "rounded-md border border-rose-500/40 bg-rose-950/50 px-2 py-1.5 text-[11px] text-rose-100"
              : "rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-100"
          }
        >
          {lastError}
        </div>
      )}

      {spindleSafetyBlocker && (
        <div
          className={
            compact
              ? "rounded-md border border-amber-500/60 bg-amber-950/55 px-2 py-2 text-[11px] text-amber-100"
              : "rounded-lg border border-amber-500/60 bg-amber-950/55 px-3 py-3 text-sm text-amber-100"
          }
          role="alert"
        >
          <p className="font-semibold text-amber-50">
            Spindle-safety check blocked the send
          </p>
          <p className={compact ? "mt-1 leading-snug" : "mt-1.5 leading-relaxed"}>
            The loaded G-code has cutting moves (G1/G2/G3) but no spindle-on command
            (M3/M4). This is exactly what caused the bit to drag through the wood
            with the spindle off. We refuse to send it as-is.
          </p>
          <p className={compact ? "mt-1.5" : "mt-2"}>
            One-click recovery: strips <code className="font-mono text-amber-50">M6</code>, adds{" "}
            <code className="font-mono text-amber-50">
              M3 S{spindleSafetyBlocker.suggestedRpm}
            </code>{" "}
            plus a 2 s <code className="font-mono text-amber-50">G4</code> dwell{" "}
            <strong className="text-amber-50">before the first G0/G1 move</strong>{" "}
            (so the spindle spins before any axis motion), and{" "}
            <code className="font-mono text-amber-50">M5</code> before{" "}
            <code className="font-mono text-amber-50">M30</code>. RPM comes from
            the file header when present; otherwise we use your machine preset
            (capped at 8000 for small routers). After inject, click{" "}
            <strong className="text-amber-50">Send G-code to machine</strong>{" "}
            again. Regenerating from Setup is still best long-term.
          </p>
          <div className={compact ? "mt-2 flex gap-1.5" : "mt-3 flex gap-2"}>
            <button
              type="button"
              onClick={() =>
                applySpindleSafetyInject(spindleSafetyBlocker.suggestedRpm)
              }
              className={
                compact
                  ? "rounded-md bg-amber-500 px-2 py-1.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-400"
                  : "rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-400"
              }
            >
              Inject M3 S{spindleSafetyBlocker.suggestedRpm} + M5
            </button>
            <button
              type="button"
              onClick={() => setSpindleSafetyBlocker(null)}
              className={
                compact
                  ? "rounded-md border border-amber-500/60 bg-transparent px-2 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/40"
                  : "rounded-lg border border-amber-500/60 bg-transparent px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/40"
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!connected ? (
          <button
            type="button"
            onClick={connect}
            className={
              compact
                ? "rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-emerald-500"
                : "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:bg-emerald-500"
            }
          >
            Connect USB machine
          </button>
        ) : (
          <button
            type="button"
            onClick={disconnect}
            className={b}
          >
            Disconnect
          </button>
        )}
      </div>

      {connected && savedRecovery !== null && (
        <div
          className={
            compact
              ? "rounded-lg border border-amber-500/60 bg-amber-950/70 p-2 ring-1 ring-amber-500/30"
              : "rounded-xl border border-amber-500/60 bg-amber-950/70 p-4 ring-1 ring-amber-500/30"
          }
        >
          <p className={compact ? "text-xs font-semibold text-amber-200" : "text-sm font-semibold text-amber-200"}>
            Job interrupted — USB disconnect detected
          </p>
          <p className={compact ? "mt-1 text-[10px] leading-snug text-amber-300/80" : "mt-1 text-xs leading-relaxed text-amber-300/80"}>
            Stopped at line <strong className="text-amber-100">{savedRecovery.lineIndex}</strong> of{" "}
            <strong className="text-amber-100">{savedRecovery.lineCount}</strong>. Click{" "}
            <strong className="text-amber-100">Recover job</strong> to home the machine, restore work coordinates,
            and resume cutting from where it left off.
          </p>
          {!compact && (
            <p className="mt-1.5 text-[11px] text-amber-400/70">
              Requires limit switches. Homing restores G54 work offset from EEPROM — no manual re-zeroing needed.
            </p>
          )}
          <div className={`flex flex-wrap gap-2 ${compact ? "mt-2" : "mt-3"}`}>
            <button
              type="button"
              onClick={recoverJob}
              disabled={streaming || recovering}
              className={
                compact
                  ? "rounded-md bg-amber-500 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-amber-400 disabled:opacity-40"
                  : "rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-40"
              }
            >
              {recovering ? "Recovering…" : "Recover job ($H + resume)"}
            </button>
            <button
              type="button"
              onClick={() => { setSavedRecovery(null); clearJobState(); }}
              disabled={streaming || recovering}
              className={
                compact
                  ? "rounded-md border border-amber-500/50 bg-transparent px-2 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
                  : "rounded-lg border border-amber-500/50 bg-transparent px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {connected && (
        <div className={p}>
          <p
            className={
              compact ? "text-xs font-semibold text-white" : "text-sm font-semibold text-white"
            }
          >
            Alarm & reset (GRBL)
          </p>
          {compact ? (
            <details className="mt-1 text-[10px] leading-snug text-slate-400">
              <summary className="cursor-pointer font-medium text-slate-300 hover:text-slate-200">
                Unlock vs soft reset
              </summary>
              <p className="mt-1">
                In <span className="text-slate-200">Alarm</span>, many boards ignore{" "}
                <code className="text-slate-300">$X</code> until after a{" "}
                <span className="text-slate-200">Ctrl+X</span> soft reset.{" "}
                <strong className="text-slate-200">Unlock</strong> sends both. Fix limits first,
                then clear; re-zero if needed.
              </p>
            </details>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              In <span className="text-slate-200">Alarm</span>, many boards ignore{" "}
              <code className="text-slate-300">$X</code> until after a{" "}
              <span className="text-slate-200">Ctrl+X</span> soft reset.{" "}
              <strong className="text-slate-200">Unlock</strong> sends both (reset, short pause, then{" "}
              <code className="text-slate-300">$X</code>). Use <strong className="text-slate-200">Soft reset</strong> alone if you only want the reset byte.
              Fix the limit/probe issue first, then clear the alarm. Re-zero after recovery if needed.
            </p>
          )}
          <div className={`flex flex-wrap gap-1.5 ${compact ? "mt-1.5" : "mt-3"}`}>
            <button
              type="button"
              onClick={unlockAlarm}
              className={
                compact
                  ? "rounded-md border border-amber-500/50 bg-amber-950/50 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/60"
                  : "rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/60"
              }
            >
              Unlock ($X)
            </button>
            <button
              type="button"
              onClick={softReset}
              className={
                compact
                  ? "rounded-md border border-rose-500/50 bg-rose-950/40 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-900/50"
                  : "rounded-lg border border-rose-500/50 bg-rose-950/40 px-3 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/50"
              }
            >
              Soft reset (Ctrl+X)
            </button>
          </div>
          {!compact && (
            <p className="mt-2 text-[11px] text-slate-500">
              These stay available even if a send was interrupted — they clear a stuck &quot;Sending…&quot;
              state too.
            </p>
          )}
        </div>
      )}

      {connected && !hasHomed && (
        <div
          className={
            compact
              ? "rounded-lg border border-orange-500/70 bg-orange-950/60 p-2.5 ring-1 ring-orange-500/30"
              : "rounded-xl border border-orange-500/70 bg-orange-950/60 p-4 ring-1 ring-orange-500/30"
          }
        >
          <p className={compact ? "text-xs font-bold text-orange-200" : "text-sm font-bold text-orange-200"}>
            Step 1: Home the machine before proceeding
          </p>
          <p className={compact ? "mt-1 text-[10px] leading-snug text-orange-300/80" : "mt-1.5 text-xs leading-relaxed text-orange-300/80"}>
            Drives all axes to their limit switches to establish machine coordinates.
            Required before jogging, zeroing, or running a job.
            {!compact && " If GRBL shows Alarm, click Unlock (above) first, then Home."}
          </p>
          <button
            type="button"
            onClick={machineHome}
            disabled={streaming}
            className={
              compact
                ? "mt-2 w-full rounded-md bg-orange-500 px-3 py-2 text-xs font-bold text-white shadow-md hover:bg-orange-400 disabled:opacity-40"
                : "mt-3 w-full rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-bold text-white shadow-md hover:bg-orange-400 disabled:opacity-40"
            }
          >
            {compact ? "Home ($H)" : "Home machine ($H) — required first"}
          </button>
          {!compact && (
            <p className="mt-2 text-[11px] text-orange-400/60">
              Alarm state? Use <strong className="text-orange-300/80">Unlock ($X)</strong> above, then click Home.
            </p>
          )}
        </div>
      )}

      {connected && hasHomed && (
        <div
          className={
            compact
              ? "flex items-center gap-1.5 rounded-md border border-emerald-600/40 bg-emerald-950/40 px-2 py-1"
              : "flex items-center gap-2 rounded-lg border border-emerald-600/40 bg-emerald-950/40 px-3 py-1.5"
          }
        >
          <span className={compact ? "text-[10px] font-semibold text-emerald-400" : "text-xs font-semibold text-emerald-400"}>
            Machine homed
          </span>
          <span className={compact ? "text-[10px] text-emerald-500/70" : "text-xs text-emerald-500/70"}>
            — machine coordinates established, work zero will persist across reconnects
          </span>
          <button
            type="button"
            onClick={machineHome}
            disabled={streaming}
            className={compact ? "ml-auto text-[10px] text-emerald-500/60 hover:text-emerald-400 disabled:opacity-40" : "ml-auto text-xs text-emerald-500/60 hover:text-emerald-400 disabled:opacity-40"}
            title="Re-home if needed"
          >
            Re-home
          </button>
        </div>
      )}

      {connected && hasHomed && (
      <div className={p}>
        <p
          className={
            compact ? "text-xs font-semibold text-white" : "text-sm font-semibold text-white"
          }
        >
          Jog (move bit slowly)
        </p>
        {!compact && (
          <p className="mt-1 text-xs text-slate-400">
            Use arrows to nudge. Keep hands clear and stay ready for the emergency
            stop on the machine.
          </p>
        )}
        <div className={`flex flex-wrap items-center gap-2 ${compact ? "mt-1.5" : "mt-3"}`}>
          <label className={compact ? "text-[10px] text-slate-400" : "text-xs text-slate-400"}>
            Step mm
            <select
              className={
                compact
                  ? "ml-1.5 rounded-md border border-slate-600 bg-slate-900 px-1.5 py-1 text-xs text-slate-100"
                  : "ml-2 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
              }
              value={jogMm}
              onChange={(e) => setJogMm(Number(e.target.value))}
            >
              <option value={0.1}>0.1</option>
              <option value={1}>1</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
            </select>
          </label>
        </div>
        <div
          className={
            compact
              ? "mt-2 grid max-w-[11rem] grid-cols-3 gap-1 text-center"
              : "mt-4 grid max-w-xs grid-cols-3 gap-2 text-center"
          }
        >
          <span />
          <button
            type="button"
            className={b}
            onClick={() => jog("Y", 1)}
            disabled={!connected || streaming}
          >
            Y+
          </button>
          <span />
          <button
            type="button"
            className={b}
            onClick={() => jog("X", -1)}
            disabled={!connected || streaming}
          >
            X−
          </button>
          <span
            className={
              compact
                ? "flex items-center justify-center text-[10px] font-medium text-slate-500"
                : "flex items-center justify-center text-xs font-medium text-slate-500"
            }
          >
            XY
          </span>
          <button
            type="button"
            className={b}
            onClick={() => jog("X", 1)}
            disabled={!connected || streaming}
          >
            X+
          </button>
          <span />
          <button
            type="button"
            className={b}
            onClick={() => jog("Y", -1)}
            disabled={!connected || streaming}
          >
            Y−
          </button>
          <span />
        </div>
        <div className={compact ? "mt-2 flex gap-1.5" : "mt-4 flex gap-2"}>
          <button
            type="button"
            className={`${b} flex-1`}
            onClick={() => jog("Z", 1)}
            disabled={!connected || streaming}
          >
            Z up
          </button>
          <button
            type="button"
            className={`${b} flex-1`}
            onClick={() => jog("Z", -1)}
            disabled={!connected || streaming}
          >
            Z down
          </button>
        </div>
        <button
          type="button"
          onClick={zeroWorkpiece}
          disabled={!connected || streaming || workZeroStatus === "pending"}
          className={
            compact
              ? "mt-2 w-full rounded-md bg-teal-600 px-2 py-2 text-xs font-semibold text-white shadow-md hover:bg-teal-500 disabled:opacity-40"
              : "mt-4 w-full rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-teal-500 disabled:opacity-40"
          }
        >
          {workZeroStatus === "pending"
            ? "Setting work zero…"
            : "Set X/Y/Z zero here (work zero)"}
        </button>
        {workZeroStatus === "pending" && (
          <p
            className={
              compact
                ? "mt-1.5 flex items-center gap-1.5 text-[11px] text-teal-300"
                : "mt-2 flex items-center gap-2 text-sm text-teal-300"
            }
          >
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />
            Waiting for GRBL…
          </p>
        )}
        {workZeroStatus === "done" && (
          <p
            className={
              compact
                ? "mt-1.5 rounded-md border border-emerald-500/45 bg-emerald-950/55 px-2 py-1.5 text-[11px] leading-snug text-emerald-100 ring-1 ring-emerald-500/25"
                : "mt-2 rounded-lg border border-emerald-500/45 bg-emerald-950/55 px-3 py-2.5 text-sm leading-snug text-emerald-100 ring-1 ring-emerald-500/25"
            }
            role="status"
            aria-live="polite"
          >
            {compact ? (
              <>
                <strong className="font-semibold text-emerald-50">Work zero set</strong> — bit here is{" "}
                <strong className="text-emerald-50">X0 Y0 Z0</strong> (see serial when expanded).
              </>
            ) : (
              <>
                <strong className="font-semibold text-emerald-50">Work zero set.</strong> The controller
                returned <span className="font-mono text-emerald-200/95">ok</span> after{" "}
                <span className="font-mono text-xs text-emerald-200/90">G10 L20 P1</span> — the bit
                position right now is work coordinate <strong className="text-emerald-50">X0 Y0 Z0</strong>.
                Scroll the serial log below to see the line marked with ✓.
              </>
            )}
          </p>
        )}
        {compact ? (
          <details className="mt-1.5 text-[10px] text-slate-500">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-300">Paper trick (Z)</summary>
            <p className="mt-1">
              Lower Z until paper barely drags, then Set zero — that is the top surface.
            </p>
          </details>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Paper trick: lower Z until a sheet of paper barely catches between bit
            and wood, then press &quot;Set zero&quot;. That is your top surface.
          </p>
        )}
        {connected && (
          <div
            className={
              compact
                ? "mt-2 grid grid-cols-2 gap-1"
                : "mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
            }
          >
            <button
              type="button"
              onClick={machineHome}
              disabled={!connected || streaming}
              className={b}
            >
              {compact ? "Home" : "Home ($H)"}
            </button>
            <button
              type="button"
              onClick={goWorkZero}
              disabled={!connected || streaming}
              className={b}
            >
              {compact ? "XY0" : "Go to work XY0"}
            </button>
            <button
              type="button"
              onClick={reportStatus}
              disabled={!connected}
              className={b}
            >
              {compact ? "?" : "Status (?)"}
            </button>
            <button
              type="button"
              onClick={readWorkPosition}
              disabled={!connected || streaming}
              className={b}
              title="Reads work X/Y/Z from the next GRBL status report (WPos)"
            >
              {compact ? "WPos" : "Read work XYZ"}
            </button>
          </div>
        )}
        {lastWorkPos != null && connected && (
          <p
            className={
              compact
                ? "mt-1.5 rounded-md border border-slate-600/50 bg-slate-900/60 px-2 py-1 font-mono text-[10px] text-slate-200"
                : "mt-2 rounded-lg border border-slate-600/50 bg-slate-900/60 px-3 py-2 font-mono text-xs text-slate-200"
            }
          >
            WPos: X{lastWorkPos.x.toFixed(3)} Y{lastWorkPos.y.toFixed(3)} Z{lastWorkPos.z.toFixed(3)}{" "}
            mm
            {!compact && (
              <span className="mt-1 block font-sans text-[11px] leading-snug text-slate-400">
                Work origin (0,0,0) is only where you set it with &quot;Set work zero&quot;.{" "}
                <strong className="text-slate-300">Go to work XY0</strong> rapids to that XY (Z
                unchanged — stay clear of clamps).
              </span>
            )}
          </p>
        )}
      </div>
      )}

      {connected && hasHomed && (
      <div className={p}>
        <p
          className={
            compact ? "text-xs font-semibold text-white" : "text-sm font-semibold text-white"
          }
        >
          Send to machine
        </p>
        <p className={compact ? "mt-0.5 text-[10px] text-slate-400" : "mt-1 text-xs text-slate-400"}>
          USB-streams the G-code{" "}
          {gcodeSourceHint ? `you loaded (${gcodeSourceHint})` : "from the buffer"}.
          {!compact && " Connect and set work zero first; stay with the machine."} The usual stop was
          the PC giving up waiting for an <span className="text-slate-300">ok</span> on a{" "}
          <em>slow</em> move (now a 5-minute wait per line). A screen saver alone rarely kills USB,
          but it can dim the display and some browsers throttle background tabs — we request a{" "}
          <span className="text-slate-300">screen wake lock</span> while sending when Chrome allows it.
          Still keep this tab in front for multi-hour jobs. After a stop, use{" "}
          <span className="text-slate-300">Resume job</span> (not only{" "}
          <span className="text-slate-300">Cycle start</span>) once the machine is idle.
        </p>
        <label
          className={
            compact
              ? "mt-1.5 block text-[10px] text-slate-400"
              : "mt-2 block text-xs text-slate-400"
          }
        >
          USB stream polling (extra <span className="text-slate-300">?</span> while waiting for{" "}
          <span className="text-slate-300">ok</span>) — if USB drops repeat, try Off or 60s.
          <select
            className={
              compact
                ? "mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-1.5 py-1 text-[11px] text-white"
                : "mt-1 w-full max-w-md rounded-lg border border-white/15 bg-slate-900 px-2 py-1.5 text-sm text-white"
            }
            value={String(streamHeartbeatMs)}
            onChange={(e) => persistStreamHeartbeatMs(parseInt(e.target.value, 10))}
            disabled={streaming}
          >
            <option value="14000">Every ~14 s (default)</option>
            <option value="30000">Every ~30 s (quieter)</option>
            <option value="60000">Every ~60 s (minimal)</option>
            <option value="0">Off — quietest USB traffic (slowest disconnect detection)</option>
          </select>
        </label>
        <details
          className={
            compact
              ? "mt-1.5 rounded-md border border-amber-500/25 bg-amber-950/15 px-2 py-1 text-[10px] text-amber-100/95"
              : "mt-2 rounded-lg border border-amber-500/25 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/95"
          }
        >
          <summary className="cursor-pointer font-medium text-amber-50/95 hover:text-amber-50">
            Stops mid-job? (EMI · GRBL · USB checklist)
          </summary>
          <ul
            className={
              compact
                ? "mt-1.5 list-inside list-disc space-y-1 pl-0.5 text-[10px] leading-snug text-amber-100/85"
                : "mt-2 list-inside list-disc space-y-1.5 pl-1 text-xs leading-relaxed text-amber-100/85"
            }
          >
            <li>
              <strong className="text-amber-50">Air run (EMI test):</strong> raise Z safely above the stock, unplug{" "}
              <strong className="text-amber-50">spindle/router power</strong> (motor only), run the same file. If it
              finishes but real jobs fail at a similar spot, noise or load from the router is the lead suspect — separate
              wall circuits, route cables away from USB, try ferrites if you want to go further.
            </li>
            <li>
              <strong className="text-amber-50">Offline controller:</strong> if your 3018 has the handheld offline
              module plugged into the mainboard, unplug it while sending from the Mac — it can contend on the same
              serial path.
            </li>
            <li>
              <strong className="text-amber-50">GRBL vs “bad line”:</strong> CNCarve already strips{" "}
              <span className="font-mono">M6</span> and bare <span className="font-mono">T&lt;n&gt;</span> lines that
              stock GRBL rejects. A true unsupported command usually shows <span className="font-mono">error:</span> in
              the log before a stop. “Device has been lost” is almost always the USB link or the controller resetting.
            </li>
            <li>
              <strong className="text-amber-50">Buffer / streaming:</strong> CNCarve sends <strong>one line, waits for</strong>{" "}
              <span className="font-mono">ok</span>, then the next — it does not blast the whole file into the serial
              buffer. That is the same safety idea as “character counting” senders (e.g. UGS), adapted for Web Serial.
            </li>
            <li>
              <strong className="text-amber-50">Same line number again:</strong> often a long slow cut — the machine
              sits in one region for many minutes each run, so a USB glitch “lines up” with the same G-code index without
              being a timer bug.
            </li>
          </ul>
        </details>
        <div
          className={
            compact
              ? "mt-1.5 rounded-md border border-sky-500/30 bg-sky-950/30 px-2 py-1 text-[10px] text-slate-200"
              : "mt-3 rounded-lg border border-sky-500/30 bg-sky-950/30 px-3 py-2 text-xs text-slate-200"
          }
        >
          <p>
            Est. <strong className="text-sky-300">{formatDuration(parsed.totalDurationSec)}</strong>
            {" · "}
            Elapsed <strong className="text-emerald-300">{formatDuration(elapsedSec)}</strong>
            {streaming ? (
              <>
                {" · "}
                <strong className="text-amber-300">
                  {formatDuration(Math.max(0, parsed.totalDurationSec - elapsedSec))} left
                </strong>
              </>
            ) : null}
          </p>
          {streamProgress && (
            <p className="mt-0.5">
              Line{" "}
              <strong className="text-sky-200">
                {streamProgress.i}/{streamProgress.total}
              </strong>{" "}
              ({Math.floor((streamProgress.i / Math.max(1, streamProgress.total)) * 100)}%)
            </p>
          )}
        </div>
        <div className={compact ? "mt-1.5 flex flex-wrap gap-1.5" : "mt-3 flex flex-wrap gap-2"}>
          <button
            type="button"
            onClick={runJob}
            disabled={!connected || streaming || !exportedGcode.trim()}
            className={
              compact
                ? "rounded-md bg-emerald-600 px-2 py-2 text-xs font-semibold text-white shadow-md hover:bg-emerald-500 disabled:opacity-40"
                : "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:bg-emerald-500 disabled:opacity-40"
            }
          >
            {streaming ? "Sending…" : compact ? "Send G-code" : "Send G-code to machine"}
          </button>
          <button
            type="button"
            onClick={resumeJob}
            disabled={
              !connected ||
              streaming ||
              jobResumeAtIndex === null ||
              !exportedGcode.trim()
            }
            className={
              compact
                ? "rounded-md border border-sky-500/70 bg-sky-950/60 px-2 py-2 text-xs font-semibold text-sky-100 hover:bg-sky-900/70 disabled:opacity-40"
                : "rounded-lg border border-sky-500/70 bg-sky-950/60 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-900/70 disabled:opacity-40"
            }
            title="Continue from the line where sending stopped (same G-code buffer)"
          >
            {compact
              ? "Resume job"
              : jobResumeAtIndex !== null
                ? `Resume job (line ${jobResumeAtIndex + 1})`
                : "Resume job"}
          </button>
          <button
            type="button"
            onClick={stopHold}
            disabled={!connected || !streaming}
            className={
              compact
                ? "rounded-md border border-amber-500/60 bg-amber-950/50 px-2 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-900/60 disabled:opacity-40"
                : "rounded-lg border border-amber-500/60 bg-amber-950/50 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/60 disabled:opacity-40"
            }
          >
            Pause (!)
          </button>
          <button
            type="button"
            onClick={cycleStart}
            disabled={!connected}
            className={b}
            title="GRBL feed-hold release only — use Resume job after a send error"
          >
            {compact ? "Cycle ~" : "Cycle start (~)"}
          </button>
        </div>
        <div
          className={
            compact
              ? "mt-1.5 space-y-1 rounded-md border border-teal-500/25 bg-teal-950/20 px-2 py-1.5"
              : "mt-3 space-y-2 rounded-lg border border-teal-500/25 bg-teal-950/20 px-3 py-2"
          }
        >
          <p className={compact ? "text-[10px] font-medium text-teal-100/90" : "text-xs font-medium text-teal-100/90"}>
            Lost the resume pointer after USB drop? Set it again.
          </p>
          <div className={compact ? "flex flex-wrap gap-1" : "flex flex-wrap gap-2"}>
            <button
              type="button"
              onClick={() => {
                setResumeFromProgressLeftNumber();
                if (streamProgress) {
                  setManualResumeInput(String(streamProgress.i));
                  setManualResumeMode("progress");
                }
              }}
              disabled={!exportedGcode.trim() || streaming || !streamProgress}
              className={
                compact
                  ? "rounded-md bg-teal-700/80 px-2 py-1 text-[10px] font-semibold text-white hover:bg-teal-600 disabled:opacity-40"
                  : "rounded-lg bg-teal-700/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-600 disabled:opacity-40"
              }
              title="Uses the left number from Line X/Y above (next line CNCarve will send)"
            >
              {compact ? "Resume = progress" : `Use progress (line ${streamProgress?.i ?? "—"}/…)`}
            </button>
          </div>
          <div className={compact ? "flex flex-col gap-1" : "flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-end"}>
            <label className={compact ? "flex flex-col gap-0.5 text-[10px] text-slate-400" : "flex flex-col gap-0.5 text-xs text-slate-400"}>
              <span>Number</span>
              <input
                type="text"
                inputMode="numeric"
                value={manualResumeInput}
                onChange={(e) => setManualResumeInput(e.target.value)}
                placeholder={compact ? "15984" : "e.g. 15984"}
                className={
                  compact
                    ? "w-full rounded border border-white/15 bg-slate-900 px-1.5 py-1 text-[11px] text-white"
                    : "w-32 rounded border border-white/15 bg-slate-900 px-2 py-1.5 text-sm text-white"
                }
              />
            </label>
            <fieldset
              className={
                compact ? "flex flex-wrap gap-2 text-[10px] text-slate-300" : "flex flex-wrap gap-3 text-xs text-slate-300"
              }
            >
              <label className="inline-flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  name="manualResumeMode"
                  checked={manualResumeMode === "progress"}
                  onChange={() => setManualResumeMode("progress")}
                />
                From <strong className="text-slate-200">Line X/Y</strong> (left X)
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  name="manualResumeMode"
                  checked={manualResumeMode === "error"}
                  onChange={() => setManualResumeMode("error")}
                />
                From <strong className="text-slate-200">Stopped near line N</strong>
              </label>
            </fieldset>
            <button
              type="button"
              onClick={applyManualResumePoint}
              disabled={!exportedGcode.trim() || streaming}
              className={
                compact
                  ? "rounded-md border border-teal-500/60 bg-teal-950/50 px-2 py-1 text-[10px] font-semibold text-teal-100 hover:bg-teal-900/60 disabled:opacity-40"
                  : "rounded-lg border border-teal-500/60 bg-teal-950/50 px-3 py-1.5 text-xs font-semibold text-teal-100 hover:bg-teal-900/60 disabled:opacity-40"
              }
            >
              Set resume point
            </button>
          </div>
          {!compact && (
            <p className="text-[11px] leading-snug text-slate-500">
              Example: progress <strong className="text-slate-400">Line 15984/129946</strong> → choose{" "}
              <strong className="text-slate-400">Line X/Y</strong> and enter <strong className="text-slate-400">15984</strong>
              , then <strong className="text-slate-400">Set resume point</strong> → <strong className="text-slate-400">Resume job</strong>.
            </p>
          )}
        </div>
        {jobResumeAtIndex !== null && !streaming && (
          <p className={compact ? "mt-1 text-[10px] text-slate-500" : "mt-2 text-xs text-slate-500"}>
            Resume point: line {jobResumeAtIndex + 1} of {parseGrblGcodeLines(exportedGcode).length}.
            Reloading G-code clears this.{" "}
            <button
              type="button"
              className="text-teal-400 underline hover:text-teal-300"
              onClick={() => setJobResumeAtIndex(null)}
            >
              Clear
            </button>
          </p>
        )}
      </div>
      )}

      {compact ? (
        <details className="shrink-0 rounded-lg border border-white/10 bg-black/30">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-medium text-slate-300 marker:content-none [&::-webkit-details-marker]:hidden">
            <span>Serial ({serialLog.length})</span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  downloadDiagLog();
                }}
                disabled={diagEventsRef.current.length === 0}
                className="text-[10px] text-teal-400 hover:text-teal-300 disabled:opacity-40"
                title="Download every send/receive/ack/stall/timeout/disconnect event from this session as JSON. Share when reporting a 'machine stopped' issue."
              >
                Download log
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearSerialLog();
                }}
                className="text-[10px] text-slate-500 hover:text-teal-400"
              >
                Clear
              </button>
            </span>
          </summary>
          <pre className="max-h-[min(28vh,12rem)] overflow-y-auto rounded-md border border-white/10 bg-black/90 p-2 font-mono text-[10px] leading-tight text-emerald-400/95">
            {serialLog.length === 0 ? "…" : serialLog.join("\n")}
          </pre>
        </details>
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-300">
              Serial log{" "}
              <span className="ml-1 text-xs font-normal text-slate-500">
                ({diagEventsRef.current.length} events buffered for download)
              </span>
            </p>
            <span className="flex items-center gap-3">
              <button
                type="button"
                onClick={downloadDiagLog}
                disabled={diagEventsRef.current.length === 0}
                className="text-xs text-teal-400 hover:text-teal-300 disabled:opacity-40"
                title="Download every send/receive/ack/stall/timeout/disconnect event from this session as JSON. Share when reporting a 'machine stopped' issue."
              >
                Download log
              </button>
              <button
                type="button"
                onClick={clearSerialLog}
                className="text-xs text-slate-500 hover:text-teal-400"
              >
                Clear
              </button>
            </span>
          </div>
          <pre className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/90 p-3 font-mono text-xs text-emerald-400/95">
            {serialLog.length === 0 ? "…" : serialLog.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}
