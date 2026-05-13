"use client";

import { useAppState } from "@/context/AppState";
import { XyTouchOffGuidanceText } from "@/lib/touchOffGuidance";
import { GcodeFromKiriPanel } from "./GcodeFromKiriPanel";
import { RunPanel } from "./RunPanel";
import { useCallback, useMemo, useState } from "react";

type Props = {
  /** Stop waiting for iframe `export.done` when the user loads a file or replaces G-code. */
  onCancelPendingKiriFetch: () => void;
  /** When set, “Machine” opens the bottom-right popout instead of inline step 2. */
  onEnterMachine?: () => void;
};

export function SendToMachineWizard({
  onCancelPendingKiriFetch,
  onEnterMachine,
}: Props) {
  const { answers, exportedGcode, setExportedGcode } = useAppState();
  const hasGcode = exportedGcode.trim().length > 0;

  const [step, setStep] = useState(1);

  const canGoMachine = hasGcode;
  const externalMachine = onEnterMachine != null;

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

  const goMachine = () => {
    if (externalMachine) {
      onEnterMachine();
      return;
    }
    setStep(2);
  };

  return (
    <div className="space-y-4">
      {externalMachine ? (
        <div className="flex gap-1 rounded-xl bg-slate-950/80 p-1 ring-1 ring-white/10">
          <div className="flex-1 rounded-lg bg-teal-600 px-2 py-2 text-center text-xs font-medium text-white">
            <span className="block text-[10px] font-normal opacity-90">Step 1</span>
            G-code
          </div>
          <button
            type="button"
            onClick={goMachine}
            className="flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
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

      {(externalMachine || step === 1) && (
        <section className="rounded-xl border border-white/10 bg-slate-950/60 p-4">
          <h3 className="text-base font-semibold text-white">Load toolpath into CNCarve</h3>
          <p className="mt-2 text-sm text-slate-400">
            In Kiri use <strong className="text-slate-300">Export</strong>, then load that file here
            (drop or click the area in the box below).
          </p>

          <div className="mt-4">
            <GcodeFromKiriPanel onCancelPendingKiriFetch={onCancelPendingKiriFetch} />
          </div>

          {hasGcode && (
            <button
              type="button"
              onClick={downloadLoadedGcode}
              className="mt-3 text-sm font-medium text-teal-400 underline decoration-teal-500/50 underline-offset-2 hover:text-teal-300"
            >
              Download copy (.nc)
            </button>
          )}

          <details className="mt-4 text-sm text-slate-500">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-300">
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
            <p className="mt-1 text-xs">
              Use this if you already have G-code in the clipboard or need to tweak a few lines.
            </p>
          </details>

          <button
            type="button"
            disabled={!canGoMachine}
            onClick={goMachine}
            className="mt-5 w-full rounded-xl bg-teal-600 py-3 text-sm font-semibold text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next: machine controls
          </button>
        </section>
      )}

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
            Back to G-code
          </button>
        </section>
      )}
    </div>
  );
}
