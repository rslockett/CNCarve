"use client";

import { useAppState } from "@/context/AppState";
import { XyTouchOffGuidanceText } from "@/lib/touchOffGuidance";
import { GcodeFromKiriPanel } from "./GcodeFromKiriPanel";
import { RunPanel } from "./RunPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Props = {
  /** Stop waiting for iframe `export.done` when the user loads a file or replaces G-code. */
  onCancelPendingKiriFetch: () => void;
  /** Kick off the automatic slice → prepare → export pipeline. */
  onFetchGcodeFromKiri: () => void;
  /** Current state of the automatic G-code fetch pipeline. */
  gcodeFetchStatus: "idle" | "loading" | "ready" | "error";
  /** When set, "Machine" opens the bottom-right popout instead of inline step 2. */
  onEnterMachine?: () => void;
};

export function SendToMachineWizard({
  onCancelPendingKiriFetch,
  onFetchGcodeFromKiri,
  gcodeFetchStatus,
  onEnterMachine,
}: Props) {
  const { answers, exportedGcode, setExportedGcode } = useAppState();
  const hasGcode = exportedGcode.trim().length > 0;

  const [step, setStep] = useState(1);

  const externalMachine = onEnterMachine != null;

  const goMachine = useCallback(() => {
    if (externalMachine) {
      onEnterMachine();
      return;
    }
    setStep(2);
  }, [externalMachine, onEnterMachine]);

  // Auto-advance to machine the moment G-code finishes generating.
  const prevFetchStatus = useRef(gcodeFetchStatus);
  useEffect(() => {
    const prev = prevFetchStatus.current;
    prevFetchStatus.current = gcodeFetchStatus;
    if (prev === "loading" && gcodeFetchStatus === "ready") {
      const id = setTimeout(goMachine, 400);
      return () => clearTimeout(id);
    }
  }, [gcodeFetchStatus, goMachine]);

  const downloadLoadedGcode = useCallback(() => {
    const text = exportedGcode.trim();
    if (!text) return;
    const blob = new Blob([exportedGcode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cncarve-job-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.nc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [exportedGcode]);

  const steps = useMemo(
    () => [
      { n: 1, label: "G-code" },
      { n: 2, label: "Machine" },
    ],
    [],
  );

  const isLoading = gcodeFetchStatus === "loading";

  const generateLabel = isLoading
    ? "Generating G-code…"
    : gcodeFetchStatus === "error"
      ? "Retry — slice & generate G-code"
      : hasGcode
        ? "Re-slice & regenerate G-code"
        : "Slice & generate G-code";

  return (
    <div className="space-y-4">
      {/* Step tabs */}
      {externalMachine ? (
        <div className="flex gap-1 rounded-xl bg-slate-950/80 p-1 ring-1 ring-white/10">
          <div className="flex-1 rounded-lg bg-teal-600 px-2 py-2 text-center text-xs font-medium text-white">
            <span className="block text-[10px] font-normal opacity-90">Step 1</span>
            G-code
          </div>
          <button
            type="button"
            onClick={goMachine}
            disabled={!hasGcode}
            className="flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
          >
            <span className="block text-[10px] font-normal opacity-80">Step 2</span>
            Machine
          </button>
        </div>
      ) : (
        <div className="flex gap-1 rounded-xl bg-slate-950/80 p-1 ring-1 ring-white/10">
          {steps.map((s) => (
            <button
              key={s.n}
              type="button"
              onClick={() => setStep(s.n)}
              className={`flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition ${
                step === s.n
                  ? "bg-teal-600 text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <span className="block text-[10px] font-normal opacity-80">Step {s.n}</span>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Step 1 — G-code */}
      {(externalMachine || step === 1) && (
        <section className="space-y-3 rounded-xl border border-white/10 bg-slate-950/60 p-4">
          <div>
            <h3 className="text-base font-semibold text-white">Generate G-code</h3>
            <p className="mt-1 text-sm text-slate-400">
              One button runs slice, prepare, and export automatically.
            </p>
          </div>

          {/* Primary action */}
          <button
            type="button"
            onClick={onFetchGcodeFromKiri}
            disabled={isLoading}
            className={`flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold text-white transition
              ${isLoading ? "cursor-wait bg-slate-700" : gcodeFetchStatus === "error" ? "bg-amber-700 hover:bg-amber-600" : "bg-teal-600 hover:bg-teal-500"}`}
          >
            {isLoading && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            )}
            {generateLabel}
          </button>

          {isLoading && (
            <p className="text-center text-xs text-slate-400">
              Large meshes can take a minute — watch the status bar below.
            </p>
          )}

          {/* G-code ready: show download link */}
          {hasGcode && !isLoading && (
            <button
              type="button"
              onClick={downloadLoadedGcode}
              className="w-full text-center text-sm font-medium text-teal-400 underline decoration-teal-500/50 underline-offset-2 hover:text-teal-300"
            >
              Download G-code copy (.nc)
            </button>
          )}

          {/* Fallback: load from file */}
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-300">
              Load from file instead (if you exported manually in Kiri)
            </summary>
            <div className="mt-3">
              <GcodeFromKiriPanel onCancelPendingKiriFetch={onCancelPendingKiriFetch} />
            </div>
          </details>

          {/* Fallback: paste */}
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-300">
              Paste or edit G-code manually
            </summary>
            <textarea
              className="mt-2 min-h-[120px] w-full rounded-lg border border-white/10 bg-slate-950/80 p-2 font-mono text-xs text-slate-200"
              placeholder=";(Paste G-code here)"
              value={exportedGcode}
              onChange={(e) => {
                onCancelPendingKiriFetch();
                setExportedGcode(e.target.value);
              }}
            />
          </details>

          {/* Proceed button — shown when g-code is available but auto-advance didn't fire */}
          {hasGcode && !isLoading && (
            <button
              type="button"
              onClick={goMachine}
              className="w-full rounded-xl bg-teal-600 py-3 text-sm font-semibold text-white hover:bg-teal-500"
            >
              Go to machine →
            </button>
          )}
        </section>
      )}

      {/* Step 2 — Machine (inline, non-external case) */}
      {!externalMachine && step === 2 && (
        <section className="space-y-3">
          <details className="rounded-xl border border-white/10 bg-slate-950/50 text-xs leading-relaxed text-slate-400">
            <summary className="cursor-pointer px-3 py-2.5 font-semibold text-slate-300 hover:bg-white/5">
              Touch-off notes (XY / Z) — tap to expand
            </summary>
            <div className="border-t border-white/10 px-3 py-3">
              <p className="font-semibold text-teal-200/90">XY zero</p>
              <p className="mt-1">
                {XyTouchOffGuidanceText(answers.stockOnBed, answers.patternPlacement)}
              </p>
              <p className="mt-2 font-semibold text-teal-200/90">Z zero</p>
              <p className="mt-1">
                Use the paper trick, then <strong className="text-slate-200">Set X/Y/Z zero</strong>{" "}
                in the controls below.
              </p>
            </div>
          </details>
          <RunPanel gcodeSourceHint="step 1" />
          <button
            type="button"
            onClick={() => setStep(1)}
            className="w-full rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:bg-white/5"
          >
            ← Back to G-code
          </button>
        </section>
      )}
    </div>
  );
}
