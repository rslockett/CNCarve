"use client";

import { canJogIn, type CarveMachine, type MachineState } from "@/lib/carveMachine";
import { useState, useSyncExternalStore } from "react";
import { CarveControls, JogPad } from "./MachineStep";

const noopSubscribe = () => () => {};

/**
 * Always-visible machine controls along the bottom of the screen: status and position, connect,
 * home, move (arrow pad), pause / resume while carving, and the emergency STOP.
 */
export function MachineBar({ machine }: { machine: CarveMachine }) {
  const s: MachineState = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
  const supported = useSyncExternalStore(noopSubscribe, () => machine.isSupported(), () => true);
  const [moveOpen, setMoveOpen] = useState(false);
  const [step, setStep] = useState(1);
  if (!supported) return null;

  const carving = s.busy === "carving";
  const pct = s.progress ? Math.min(100, (100 * s.progress.line) / Math.max(1, s.progress.total)) : 0;
  const statusText = !s.connected
    ? "Not connected"
    : s.busy === "stopping"
      ? "Stopping…"
      : carving
        ? s.paused
          ? `Paused · ${pct.toFixed(0)}%`
          : s.pausing
            ? `Pausing… · ${pct.toFixed(0)}%`
            : `Carving · ${pct.toFixed(0)}%`
        : s.busy === "homing"
          ? "Homing…"
          : s.busy === "tracing"
            ? "Tracing the outline"
            : s.busy === "restarting"
              ? "Getting ready to continue…"
              : s.status === "Alarm"
                ? "Alarm — press Home"
                : s.status || "Connected";
  const dot = !s.connected
    ? "bg-slate-500"
    : s.status === "Alarm"
      ? "bg-rose-500"
      : carving && !s.paused
        ? "bg-emerald-400 animate-pulse"
        : s.paused
          ? "bg-amber-400"
          : "bg-teal-400";

  const small = "rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40";
  const canMove = canJogIn(s);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-slate-950/95 backdrop-blur-md">
      {moveOpen && s.connected && (
        <div className="mx-auto max-w-2xl border-b border-white/10 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {canMove ? "Move the bit" : carving ? "You can move the bit while the carve is paused." : "The machine is busy."}
            </span>
            <button type="button" className="text-xs text-slate-400 underline" onClick={() => setMoveOpen(false)}>
              Close
            </button>
          </div>
          <JogPad machine={machine} disabled={!canMove} step={step} setStep={setStep} />
        </div>
      )}
      <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">{statusText}</p>
            {s.connected && s.wpos && (
              <p className="font-mono text-[10px] text-slate-500">
                X {s.wpos.x.toFixed(2)} Y {s.wpos.y.toFixed(2)} Z {s.wpos.z.toFixed(2)}
              </p>
            )}
          </div>
        </div>
        {!s.connected ? (
          <button
            type="button"
            className={`${small} bg-teal-600 text-white`}
            disabled={s.busy === "connecting"}
            onClick={() => void machine.connect()}
          >
            {s.busy === "connecting" ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <>
            {!carving && (
              <button
                type="button"
                className={`${small} border border-white/15 text-slate-100`}
                disabled={s.busy !== null}
                onClick={() => void machine.home()}
              >
                Home
              </button>
            )}
            {(!carving || s.paused) && (
              <button
                type="button"
                className={`${small} border border-white/15 text-slate-100`}
                onClick={() => setMoveOpen((o) => !o)}
              >
                Move
              </button>
            )}
            <CarveControls machine={machine} s={s} size="small" />
          </>
        )}
      </div>
    </div>
  );
}
