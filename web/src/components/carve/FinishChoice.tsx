"use client";

import { bitProfile, cleanupOffsets, finishRowPx, type BitShape, type FinishMode } from "@/lib/relief/reliefCam";
import type { ReliefCamParams } from "@/lib/relief/reliefCam";

export type SpeedChoice = "fast" | "original";

/** The three levels shown as cards, quickest to smoothest. */
export const FINISHES: { id: FinishMode; title: string; detail: string }[] = [
  { id: "quick", title: "Quick", detail: "Fastest. No clean-up: lines are likely" },
  { id: "standard", title: "Standard", detail: "2 clean-up rows before the detail pass" },
  { id: "smoothest", title: "Smoothest", detail: "Clean-up all the way across: an even skin" },
];

/** Name of any finish, including the original program (not shown as a card). */
export const finishTitle = (id: FinishMode) =>
  id === "asBefore" ? "Original program" : (FINISHES.find((f) => f.id === id)?.title ?? id);

/** Wood left above the finished surface across two roughing rows, for the little picture. */
function profile(mode: FinishMode, bit: BitShape, P: ReliefCamParams) {
  const res = P.resMm;
  const roughPx = Math.max(1, Math.round(P.roughStepMm / res));
  const finishPx = finishRowPx(mode, P.finishStepMm, res);
  const rows = [0, roughPx, 2 * roughPx, ...cleanupOffsets(mode, roughPx, finishPx).flatMap((o) => [o, o + roughPx])];
  const span = 2 * roughPx * res;
  const pts: [number, number][] = [];
  const N = 120;
  for (let q = 0; q <= N; q++) {
    const x = (q / N) * span;
    let h = 2;
    for (const r of rows) h = Math.min(h, P.leaveMm + bitProfile(bit, Math.abs(x - r * res)));
    pts.push([x, h]);
  }
  return { pts, span, peak: Math.max(...pts.map((p) => p[1])) };
}

export function FinishPreview({ mode, bit, params }: { mode: FinishMode; bit: BitShape; params: ReliefCamParams }) {
  if (bit.type !== "vee") return null;
  const { pts, span, peak } = profile(mode, bit, params);
  const W = 150, H = 54, top = 1.4, sx = W / span, sz = (H - 8) / top;
  const y = (h: number) => H - 4 - Math.min(h, top) * sz;
  const d = `M0 ${H} ` + pts.map(([x, h]) => `L${(x * sx).toFixed(1)} ${y(h).toFixed(1)}`).join(" ") + ` L${W} ${H} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-md bg-slate-950/60" aria-hidden="true">
        <path d={d} fill="#BA7517" />
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#378ADD" strokeWidth={1.5} />
      </svg>
      <p className="mt-1 text-[11px] text-slate-400">
        Left for the detail pass: up to {peak.toFixed(2)} mm
      </p>
    </div>
  );
}
