"use client";

import type { CarveMachine } from "@/lib/carveMachine";

/** Arrow pad for moving the bit, with step sizes. */
export function JogPad({
  machine,
  disabled,
  step,
  setStep,
}: {
  machine: CarveMachine;
  disabled: boolean;
  step: number;
  setStep: (n: number) => void;
}) {
  const b =
    "h-11 w-11 rounded-lg border border-white/15 bg-slate-800 text-lg text-white hover:bg-slate-700 active:bg-slate-600 disabled:opacity-40";
  const j = (axis: "X" | "Y" | "Z", dir: 1 | -1) => () => void machine.jog(axis, dir * step);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="grid grid-cols-3 gap-1.5">
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("Y", 1)} aria-label="Move away from you">
          ↑
        </button>
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("X", -1)} aria-label="Move left">
          ←
        </button>
        <span className="flex items-center justify-center text-[10px] text-slate-500">bit</span>
        <button type="button" className={b} disabled={disabled} onClick={j("X", 1)} aria-label="Move right">
          →
        </button>
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("Y", -1)} aria-label="Move toward you">
          ↓
        </button>
        <span />
      </div>
      <div className="flex flex-col gap-1.5">
        <button type="button" className={`${b} w-16 text-sm`} disabled={disabled} onClick={j("Z", 1)}>
          Up
        </button>
        <button type="button" className={`${b} w-16 text-sm`} disabled={disabled} onClick={j("Z", -1)}>
          Down
        </button>
      </div>
      <div className="flex flex-col gap-1 text-xs text-slate-300">
        <span className="text-slate-500">Step</span>
        {[10, 1, 0.1].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setStep(v)}
            className={`rounded-md px-2 py-1 ${step === v ? "bg-teal-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            {v} mm
          </button>
        ))}
      </div>
    </div>
  );
}
