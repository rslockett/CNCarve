"use client";

import { useAppState } from "@/context/AppState";
import { XyTouchOffGuidanceText } from "@/lib/touchOffGuidance";
import { RunPanel } from "./RunPanel";

type Props = {
  onBackToGcode: () => void;
  onCloseDock: () => void;
};

/** Fixed bottom-right machine controls; compact RunPanel folds tall blocks into collapsible sections. */
export function MachinePopout({ onBackToGcode, onCloseDock }: Props) {
  const { answers } = useAppState();

  return (
    <div
      className="pointer-events-auto fixed bottom-4 right-4 z-[60] flex w-[min(92vw,19.5rem)] max-w-[19.5rem] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-900/98 text-slate-100 shadow-2xl backdrop-blur-md"
      style={{ maxHeight: "calc(100dvh - 2rem)" }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2 py-2">
        <span className="text-xs font-semibold text-white">Machine</span>
        <div className="flex min-w-0 flex-1 justify-end gap-1">
          <button
            type="button"
            onClick={onBackToGcode}
            className="max-w-[11rem] shrink rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-center text-[10px] font-medium leading-tight text-slate-200 hover:bg-white/10 sm:max-w-none sm:px-2 sm:text-[11px]"
          >
            Back to G-code companion
          </button>
          <button
            type="button"
            onClick={onCloseDock}
            className="rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden p-2">
        <details className="shrink-0 rounded-lg border border-white/10 bg-slate-950/50 text-[10px] leading-snug text-slate-400">
          <summary className="cursor-pointer px-2 py-1.5 font-medium text-slate-300 hover:bg-white/5">
            Touch-off (XY / Z)
          </summary>
          <div className="border-t border-white/10 px-2 py-1.5">
            <p className="font-semibold text-teal-200/90">XY</p>
            <p className="mt-0.5">
              {XyTouchOffGuidanceText(answers.stockOnBed, answers.patternPlacement)}
            </p>
            <p className="mt-1.5 font-semibold text-teal-200/90">Z</p>
            <p className="mt-0.5">
              Paper trick, then <strong className="text-slate-200">Set X/Y/Z zero</strong> below.
            </p>
          </div>
        </details>
        {/** `overflow-y-auto`: compact RunPanel is tall; without scroll the resume row is clipped below the fold. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]">
          <RunPanel compact gcodeSourceHint="companion" />
        </div>
      </div>
    </div>
  );
}
