"use client";

import { useAppState } from "@/context/AppState";
import { formatDuration, parseGcodeStats } from "@/lib/gcodeStats";
import { GrblSerial } from "@/lib/grblSerial";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GcodeLivePreviewModal } from "./GcodeLivePreviewModal";

const JOG_FEED = 800;

/** Dark-panel controls: readable on CNCarve’s slate sidebar (avoids white-on-white). */
const btnSecondary =
  "rounded-lg border border-slate-500/90 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 shadow-sm hover:bg-slate-700 hover:border-teal-500/60 disabled:pointer-events-none disabled:opacity-40";
const panelBox =
  "rounded-xl border border-white/10 bg-slate-950/80 p-4 shadow-inner ring-1 ring-white/5";

export function RunPanel({ gcodeSourceHint }: { gcodeSourceHint?: string }) {
  const { exportedGcode, appendSerialLog, serialLog, clearSerialLog } =
    useAppState();
  const serialRef = useRef(new GrblSerial());
  const abortRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showLivePreview, setShowLivePreview] = useState(false);
  const [streamLine, setStreamLine] = useState(0);
  const [streamTotal, setStreamTotal] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [simulating, setSimulating] = useState(false);
  const simTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const [jogMm, setJogMm] = useState(1);
  const [lastError, setLastError] = useState<string | null>(null);
  /** After G10 L20, GRBL must return `ok` before we show success — gives visible confidence. */
  const [workZeroStatus, setWorkZeroStatus] = useState<"idle" | "pending" | "done">(
    "idle",
  );
  const workZeroBannerClearRef = useRef<number | null>(null);
  const parsed = useMemo(() => parseGcodeStats(exportedGcode), [exportedGcode]);

  useEffect(
    () => () => {
      if (workZeroBannerClearRef.current != null) {
        window.clearTimeout(workZeroBannerClearRef.current);
      }
      if (simTimerRef.current != null) {
        window.clearInterval(simTimerRef.current);
      }
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!(streaming || simulating)) {
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
  }, [streaming, simulating]);

  const supported =
    typeof navigator !== "undefined" && !!navigator.serial;

  const wireLog = useCallback(
    (line: string) => {
      appendSerialLog(line);
    },
    [appendSerialLog],
  );

  const connect = async () => {
    setLastError(null);
    try {
      const s = serialRef.current;
      s.onLine = wireLog;
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
      await serialRef.current.sendCommand("$H");
      appendSerialLog("(Homing cycle $H complete)");
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

  const runJob = async () => {
    if (!exportedGcode.trim()) {
      setLastError(
        "No G-code yet — finish step 1 (Load from Kiri or paste), then come back here.",
      );
      return;
    }
    setLastError(null);
    abortRef.current = false;
    setStreaming(true);
    setShowLivePreview(true);
    setElapsedSec(0);
    setStreamLine(0);
    setStreamTotal(0);
    try {
      await serialRef.current.streamGcode(
        exportedGcode,
        (i, t) => {
          setStreamLine(i);
          setStreamTotal(t);
          if (i % 100 === 0 || i === t) {
            appendSerialLog(`Stream ${i}/${t}`);
          }
        },
        () => abortRef.current,
      );
      appendSerialLog("--- Stream finished ---");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  };

  const startSimulation = () => {
    const total = parsed.streamableLines;
    if (total <= 0) {
      setLastError("Load G-code first to simulate preview.");
      return;
    }
    if (simTimerRef.current != null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    setLastError(null);
    setSimulating(true);
    setShowLivePreview(true);
    setElapsedSec(0);
    setStreamLine(0);
    setStreamTotal(total);
    const simDurationMs = Math.max(12_000, Math.round(parsed.totalDurationSec * 1000));
    const lineStepPerTick = Math.max(1, Math.ceil((total * 40) / simDurationMs));
    simTimerRef.current = window.setInterval(() => {
      setStreamLine((prev) => {
        if (prev >= total) {
          if (simTimerRef.current != null) {
            window.clearInterval(simTimerRef.current);
            simTimerRef.current = null;
          }
          setSimulating(false);
          appendSerialLog("(Simulation complete)");
          return total;
        }
        return Math.min(total, prev + lineStepPerTick);
      });
    }, 40);
    appendSerialLog("(Simulation started — preview only, no machine movement)");
  };

  const stopSimulation = () => {
    if (simTimerRef.current != null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    setSimulating(false);
    appendSerialLog("(Simulation stopped)");
  };

  const stopHold = async () => {
    abortRef.current = true;
    try {
      await serialRef.current.sendRealtime("!");
      appendSerialLog("(Feed hold !)");
    } catch {
      /* ignore */
    }
  };

  const resume = async () => {
    try {
      await serialRef.current.sendRealtime("~");
      appendSerialLog("(Cycle start ~)");
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
    <div className="space-y-4">
      {lastError && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-100">
          {lastError}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!connected ? (
          <button
            type="button"
            onClick={connect}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:bg-emerald-500"
          >
            Connect USB machine
          </button>
        ) : (
          <button
            type="button"
            onClick={disconnect}
            className={btnSecondary}
          >
            Disconnect
          </button>
        )}
      </div>

      {connected && (
        <div className={panelBox}>
          <p className="text-sm font-semibold text-white">Alarm & reset (GRBL)</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            In <span className="text-slate-200">Alarm</span>, many boards ignore <code className="text-slate-300">$X</code> until after a{" "}
            <span className="text-slate-200">Ctrl+X</span> soft reset.{" "}
            <strong className="text-slate-200">Unlock</strong> sends both (reset, short pause, then{" "}
            <code className="text-slate-300">$X</code>). Use <strong className="text-slate-200">Soft reset</strong> alone if you only want the reset byte.
            Fix the limit/probe issue first, then clear the alarm. Re-zero after recovery if needed.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={unlockAlarm}
              className="rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/60"
            >
              Unlock ($X)
            </button>
            <button
              type="button"
              onClick={softReset}
              className="rounded-lg border border-rose-500/50 bg-rose-950/40 px-3 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/50"
            >
              Soft reset (Ctrl+X)
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            These stay available even if a send was interrupted — they clear a stuck &quot;Sending…&quot;
            state too.
          </p>
        </div>
      )}

      <div className={panelBox}>
        <p className="text-sm font-semibold text-white">Jog (move bit slowly)</p>
        <p className="mt-1 text-xs text-slate-400">
          Use arrows to nudge. Keep hands clear and stay ready for the emergency
          stop on the machine.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-400">
            Step mm
            <select
              className="ml-2 rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
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
        <div className="mt-4 grid max-w-xs grid-cols-3 gap-2 text-center">
          <span />
          <button
            type="button"
            className={btnSecondary}
            onClick={() => jog("Y", 1)}
            disabled={!connected || streaming}
          >
            Y+
          </button>
          <span />
          <button
            type="button"
            className={btnSecondary}
            onClick={() => jog("X", -1)}
            disabled={!connected || streaming}
          >
            X−
          </button>
          <span className="flex items-center justify-center text-xs font-medium text-slate-500">
            XY
          </span>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => jog("X", 1)}
            disabled={!connected || streaming}
          >
            X+
          </button>
          <span />
          <button
            type="button"
            className={btnSecondary}
            onClick={() => jog("Y", -1)}
            disabled={!connected || streaming}
          >
            Y−
          </button>
          <span />
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className={`${btnSecondary} flex-1`}
            onClick={() => jog("Z", 1)}
            disabled={!connected || streaming}
          >
            Z up
          </button>
          <button
            type="button"
            className={`${btnSecondary} flex-1`}
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
          className="mt-4 w-full rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-teal-500 disabled:opacity-40"
        >
          {workZeroStatus === "pending"
            ? "Setting work zero…"
            : "Set X/Y/Z zero here (work zero)"}
        </button>
        {workZeroStatus === "pending" && (
          <p className="mt-2 flex items-center gap-2 text-sm text-teal-300">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />
            Waiting for GRBL to acknowledge…
          </p>
        )}
        {workZeroStatus === "done" && (
          <p
            className="mt-2 rounded-lg border border-emerald-500/45 bg-emerald-950/55 px-3 py-2.5 text-sm leading-snug text-emerald-100 ring-1 ring-emerald-500/25"
            role="status"
            aria-live="polite"
          >
            <strong className="font-semibold text-emerald-50">Work zero set.</strong> The controller
            returned <span className="font-mono text-emerald-200/95">ok</span> after{" "}
            <span className="font-mono text-xs text-emerald-200/90">G10 L20 P1</span> — the bit
            position right now is work coordinate <strong className="text-emerald-50">X0 Y0 Z0</strong>.
            Scroll the serial log below to see the line marked with ✓.
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Paper trick: lower Z until a sheet of paper barely catches between bit
          and wood, then press &quot;Set zero&quot;. That is your top surface.
        </p>
        {connected && (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={machineHome}
              disabled={!connected || streaming}
              className={btnSecondary}
            >
              Home ($H)
            </button>
            <button
              type="button"
              onClick={goWorkZero}
              disabled={!connected || streaming}
              className={btnSecondary}
            >
              Go to work XY0
            </button>
            <button
              type="button"
              onClick={reportStatus}
              disabled={!connected}
              className={btnSecondary}
            >
              Status (?)
            </button>
          </div>
        )}
      </div>

      <div className={panelBox}>
        <p className="text-sm font-semibold text-white">Send to machine</p>
        <p className="mt-1 text-xs text-slate-400">
          USB-streams the G-code{" "}
          {gcodeSourceHint ? `you loaded (${gcodeSourceHint})` : "from the buffer"}.
          Connect and set work zero first; stay with the machine.
        </p>
        <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-950/30 px-3 py-2 text-xs text-slate-200">
          <p>
            Estimated carve time: <strong className="text-sky-300">{formatDuration(parsed.totalDurationSec)}</strong>
          </p>
          <p>
            Elapsed: <strong className="text-emerald-300">{formatDuration(elapsedSec)}</strong>{" "}
            {streaming || simulating ? (
              <>
                • Remaining:{" "}
                <strong className="text-amber-300">
                  {formatDuration(Math.max(0, parsed.totalDurationSec - elapsedSec))}
                </strong>
              </>
            ) : null}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runJob}
            disabled={!connected || streaming || !exportedGcode.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:bg-emerald-500 disabled:opacity-40"
          >
            {streaming ? "Sending…" : "Send G-code to machine"}
          </button>
          <button
            type="button"
            onClick={stopHold}
            disabled={!connected || !streaming}
            className="rounded-lg border border-amber-500/60 bg-amber-950/50 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/60 disabled:opacity-40"
          >
            Pause (!)
          </button>
          <button
            type="button"
            onClick={resume}
            disabled={!connected}
            className={btnSecondary}
          >
            Resume (~)
          </button>
          <button
            type="button"
            onClick={() => setShowLivePreview((v) => !v)}
            disabled={!exportedGcode.trim()}
            className={btnSecondary}
          >
            {showLivePreview ? "Hide live preview" : "Show live preview"}
          </button>
          <button
            type="button"
            onClick={simulating ? stopSimulation : startSimulation}
            disabled={!exportedGcode.trim() || streaming}
            className={btnSecondary}
          >
            {simulating ? "Stop simulation" : "Simulate preview"}
          </button>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-slate-300">Serial log</p>
          <button
            type="button"
            onClick={clearSerialLog}
            className="text-xs text-slate-500 hover:text-teal-400"
          >
            Clear
          </button>
        </div>
        <pre className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/90 p-3 font-mono text-xs text-emerald-400/95">
          {serialLog.length === 0 ? "…" : serialLog.join("\n")}
        </pre>
      </div>

      <GcodeLivePreviewModal
        open={showLivePreview}
        gcode={exportedGcode}
        sentLine={streamLine}
        totalLines={streamTotal}
        estimatedTotalSec={parsed.totalDurationSec}
        elapsedSec={elapsedSec}
        onClose={() => setShowLivePreview(false)}
      />
    </div>
  );
}
