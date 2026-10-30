"use client";

import { summarizeMachineCheck, type MachineCheckItem } from "@/lib/machineCheck";

export type MachineCheckState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "error"; message: string }
  | { kind: "done"; items: MachineCheckItem[] };

type Props = {
  state: MachineCheckState;
  compact?: boolean;
  disabled?: boolean;
  onRecheck: () => void;
  /** Send a one-line setting fix (only offered for safe ones like laser mode off). */
  onApplyFix: (command: string) => void;
};

/** Fixes that can't hurt a stock 3018. Homing is left to the user: it needs working switches. */
const SAFE_FIXES = new Set(["$32=0", "$13=0"]);

const ICON = { ok: "✓", warn: "!", problem: "✕" } as const;
const TONE = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  problem: "text-rose-300",
} as const;

export function MachineCheckCard({ state, compact, disabled, onRecheck, onApplyFix }: Props) {
  const box = compact
    ? "rounded-lg border border-white/10 bg-slate-950/50 p-2.5"
    : "rounded-xl border border-white/10 bg-slate-950/50 p-4";
  const overall = state.kind === "done" ? summarizeMachineCheck(state.items) : null;

  const headline =
    state.kind === "reading"
      ? "Checking machine settings…"
      : state.kind === "error"
        ? "Couldn't read machine settings"
        : overall === "ok"
          ? "Machine settings look right"
          : overall === "warn"
            ? "Machine settings: worth a look"
            : overall === "problem"
              ? "Machine settings: fix before carving"
              : "Machine settings";

  return (
    <div className={box}>
      <div className="flex items-center justify-between gap-2">
        <p
          className={`${compact ? "text-xs" : "text-sm"} font-semibold ${overall ? TONE[overall] : "text-white"}`}
        >
          {headline}
        </p>
        <button
          type="button"
          onClick={onRecheck}
          disabled={disabled || state.kind === "reading"}
          className="rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-40"
        >
          {state.kind === "done" ? "Check again" : "Check"}
        </button>
      </div>
      {state.kind === "error" && (
        <p className="mt-1 text-[11px] text-slate-400">
          {state.message} Wait a few seconds after connecting, then press Check.
        </p>
      )}
      {state.kind === "done" && (
        <details className="mt-1.5" open={overall !== "ok"}>
          <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-300">
            {state.items.length} settings checked
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {state.items.map((it) => (
              <li key={it.id} className="text-[11px] leading-snug">
                <span className={`mr-1 font-bold ${TONE[it.status]}`}>{ICON[it.status]}</span>
                <span className="font-medium text-slate-200">{it.title}.</span>{" "}
                <span className="text-slate-400">{it.detail}</span>
                {it.fix && it.status !== "ok" && (
                  <span className="mt-0.5 block text-slate-400">
                    Fix: <code className="text-slate-200">{it.fix}</code>
                    {SAFE_FIXES.has(it.fix) ? (
                      <button
                        type="button"
                        onClick={() => onApplyFix(it.fix!)}
                        disabled={disabled}
                        className="ml-2 rounded border border-teal-500/50 px-1.5 py-0.5 text-[10px] text-teal-200 hover:bg-teal-900/40 disabled:opacity-40"
                      >
                        Apply
                      </button>
                    ) : (
                      <span className="text-slate-500">
                        {" "}
                        — test with Home first; only turn on if your limit switches work.
                      </span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
