"use client";

import type { CarveMachine, MachineState } from "@/lib/carveMachine";
import { buildLineTest, gentleSettings, speedOf } from "@/lib/lineTest";
import { motionFromGrbl } from "@/lib/relief/motionTime";
import type { ReliefSettings } from "@/lib/relief/settings";
import { useMemo } from "react";
import { StopButton } from "./MachineStep";

const minText = (m: number) => `${Math.max(1, Math.round(m))} min`;

/**
 * Line test: two small strips cut like a detail pass, the left at the current speed settings and
 * the right gentler, to see which one leaves lines.
 */
export function LineTest({
  machine,
  s,
  settings,
  onClose,
}: {
  machine: CarveMachine;
  s: MachineState;
  settings: ReliefSettings;
  onClose: () => void;
}) {
  const g = s.grbl;
  const test = useMemo(() => {
    if (!g) return null;
    const fast = speedOf(g);
    const gentle = gentleSettings(g);
    const m = s.motion ?? motionFromGrbl(g);
    return { fast, gentle, ...buildLineTest(settings, m, fast, gentle) };
  }, [g, s.motion, settings]);
  const lt = s.lineTest;
  const ready = s.homed && s.xyZeroSet && s.zZeroSet;
  const running = s.busy === "linetest";
  const btn = "rounded-xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
  const primary = `${btn} bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-lg`;
  const secondary = `${btn} border border-white/15 text-slate-100 hover:bg-white/5`;
  const accel = (x: Record<number, number>) => Math.min(x[120], x[121]);

  return (
    <div className="space-y-3 rounded-xl border border-teal-500/30 bg-teal-950/20 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-white">Line test</p>
          <p className="text-xs text-slate-400">
            Two small strips cut like a real carving — roughing, then the detail pass. The left is all at your
            current settings; the right roughs at your original settings. Which one has lines?
          </p>
        </div>
        {!running && (
          <button
            type="button"
            className="text-xs text-slate-400 underline"
            onClick={() => {
              machine.closeLineTest();
              onClose();
            }}
          >
            Close
          </button>
        )}
      </div>

      {!test ? (
        <p className="text-slate-300">Reading the machine&apos;s settings…</p>
      ) : running && lt ? (
        <div className="space-y-3">
          <p className="text-slate-200">
            Cutting the {lt.strip === 1 ? "left strip (all at your current settings)" : "right strip (roughing at your original settings)"}…{" "}
            {lt.pct}%
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-gradient-to-r from-teal-500 to-emerald-500"
              style={{ width: `${lt.pct}%` }}
            />
          </div>
          <StopButton machine={machine} s={s} big={false} />
          <p className="text-xs text-slate-500">STOP puts your speed settings back.</p>
        </div>
      ) : lt?.phase === "done" ? (
        <div className="space-y-2">
          <p className="text-emerald-200">✓ Done. Your speed settings are back to how they were.</p>
          <p className="text-slate-300">
            Vacuum the dust and look at the two strips with a light low from the side. Do you see the lines on
            the left strip and not on the right?
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-400">
            <li>
              Left: roughing and detail at {accel(lt.fast)} mm/s², corner {lt.fast[11]}
              {lt.minutes[0] !== null && ` — took ${lt.minutes[0].toFixed(1)} min`}
            </li>
            <li>
              Right: roughing at {accel(lt.gentle)} mm/s², corner {lt.gentle[11]}; detail at {accel(lt.fast)} mm/s²
              {lt.minutes[1] !== null && ` — took ${lt.minutes[1].toFixed(1)} min`}
            </li>
          </ul>
          <p className="text-xs text-slate-500">Take a close photo of both strips to compare.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-slate-300">
            <li>
              Clamp a flat piece of scrap, at least <strong>1¼ × ½ in</strong>, the same kind of wood you carve.
            </li>
            <li>Use steps 2 and 3 below to home and to find the centre and top of the scrap.</li>
            <li>Turn on dust collection and press Cut. It takes about {minText(test.minutes[0] + test.minutes[1])}.</li>
          </ol>
          <p className="text-xs text-slate-400">
            Left strip: roughing and detail at {accel(test.fast)} mm/s² (about {minText(test.minutes[0])}).
            Right strip: roughing at {accel(test.gentle)} mm/s², detail at {accel(test.fast)} mm/s² (about{" "}
            {minText(test.minutes[1])}). Each strip is about ½ × ¼ in and 1.1 mm deep.
          </p>
          <button
            type="button"
            className={primary}
            disabled={!ready || s.busy !== null}
            onClick={() => void machine.runLineTest(test.parts, test.gentle)}
          >
            Cut the line test
          </button>
          {!ready && <p className="text-xs text-amber-200">Home and set the zero on the scrap first (steps 2 and 3).</p>}
          {lt?.phase === "stopped" && (
            <button type="button" className={secondary} onClick={() => machine.closeLineTest()}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
