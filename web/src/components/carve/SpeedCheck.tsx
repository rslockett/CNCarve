"use client";

import type { CarveMachine, MachineState } from "@/lib/carveMachine";
import { FASTER, loadOriginal, RECOMMENDED } from "@/lib/speedCheck";
import { useState, useSyncExternalStore } from "react";
import { JogPad } from "./JogPad";

const noopSubscribe = () => () => {};

/**
 * Guided speed check: put the bit just above a pencil dot, run a hard test pattern in the air,
 * and keep the faster setting only if the bit comes back exactly over the dot.
 */
export function SpeedCheck({ machine, s }: { machine: CarveMachine; s: MachineState }) {
  const [step, setStep] = useState(1);
  const hasOriginal = useSyncExternalStore(noopSubscribe, () => !!loadOriginal(), () => false);
  const sc = s.speedCheck;
  const g = s.grbl;
  const accelNow = g ? Math.min(g[120] ?? 0, g[121] ?? 0) : null;
  const btn = "rounded-xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
  const primary = `${btn} bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-lg`;
  const secondary = `${btn} border border-white/15 text-slate-100 hover:bg-white/5`;

  return (
    <div className="space-y-3 rounded-xl border border-teal-500/30 bg-teal-950/20 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-white">Speed check</p>
          <p className="text-xs text-slate-400">
            Now: left-right and front-back acceleration {accelNow ?? "?"} mm/s². The up-and-down motor keeps
            its own setting. No cutting — the spindle stays off.
          </p>
        </div>
        {sc.phase !== "testing" && (
          <button type="button" className="text-xs text-slate-400 underline" onClick={() => machine.closeSpeedCheck()}>
            Close
          </button>
        )}
      </div>

      {sc.phase === "marking" &&
        (!s.homed ? (
          <div className="space-y-2">
            <p className="text-slate-300">Home the machine first, so it knows exactly where it is.</p>
            <button type="button" className={primary} disabled={s.busy !== null} onClick={() => void machine.home()}>
              {s.busy === "homing" ? "Homing…" : "Home"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-slate-300">
              <li>Make a small, sharp pencil dot on scrap wood or the spoilboard, near the middle of the bed.</li>
              <li>
                Move the bit over the dot and lower it until the tip is <strong>just above</strong> it — about
                a sheet of paper&apos;s gap. Don&apos;t touch the wood.
              </li>
              <li>Press Start. The machine runs a hard pattern in the air for about two minutes, then comes back.</li>
            </ol>
            <JogPad machine={machine} disabled={s.busy !== null} step={step} setStep={setStep} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={s.busy !== null || !g}
                onClick={() => void machine.runSpeedTest(sc.target ?? RECOMMENDED)}
              >
                Start the test at {(sc.target ?? RECOMMENDED).accel} mm/s²
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {(sc.target ?? RECOMMENDED).accel === RECOMMENDED.accel
                ? `${RECOMMENDED.accel} mm/s² left-right and front-back is a common, conservative setting for 3018 machines. The up-and-down motor is left at your machine's own setting.`
                : `${FASTER.accel} mm/s² is the faster setting. If the bit isn't exactly on the dot afterwards, your previous settings go back.`}
            </p>
          </div>
        ))}

      {sc.phase === "testing" && (
        <p className="text-slate-300">
          Testing at {sc.target?.accel} mm/s²… keep hands clear. Press STOP if anything looks wrong — your
          previous settings will go back.
        </p>
      )}

      {sc.phase === "check" && (
        <div className="space-y-3">
          <p className="text-slate-200">
            Look closely at the bit tip. <strong>Is it exactly over the pencil dot</strong>, the same as before
            the test?
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => void machine.answerSpeedTest(true)}>
              Yes — exactly on the dot
            </button>
            <button type="button" className={secondary} onClick={() => void machine.answerSpeedTest(false)}>
              No — it moved
            </button>
          </div>
          <p className="text-xs text-slate-500">
            If you&apos;re not sure, choose No. Your previous settings go back and nothing is lost.
          </p>
        </div>
      )}

      {sc.phase === "kept" && (
        <div className="space-y-3">
          <p className="text-emerald-200">
            ✓ Passed. The machine now uses {sc.target?.accel} mm/s², and carving times have been updated.
          </p>
          <div className="flex flex-wrap gap-2">
            {sc.target?.accel === RECOMMENDED.accel && (
              <button
                type="button"
                className={secondary}
                disabled={s.busy !== null}
                onClick={() => machine.openSpeedCheck(FASTER)}
                title="Run the test again at the faster setting"
              >
                Try even faster ({FASTER.accel} mm/s²)…
              </button>
            )}
            <button type="button" className={primary} onClick={() => machine.closeSpeedCheck()}>
              Done
            </button>
          </div>
          {sc.target?.accel === RECOMMENDED.accel && (
            <p className="text-xs text-slate-500">
              Going faster saves less each time, and a light 3018 frame shakes more. {RECOMMENDED.accel} mm/s² is a
              good place to stop.
            </p>
          )}
        </div>
      )}

      {sc.phase === "restored" && (
        <div className="space-y-2">
          <p className="text-slate-200">Your previous settings are back — the last ones that passed.</p>
          <button type="button" className={primary} onClick={() => machine.closeSpeedCheck()}>
            Done
          </button>
        </div>
      )}

      {hasOriginal && sc.phase !== "testing" && (
        <button
          type="button"
          className="text-xs text-slate-400 underline"
          disabled={s.busy !== null}
          onClick={() => void machine.restoreOriginalSpeed()}
        >
          Restore my original speed settings
        </button>
      )}
    </div>
  );
}
