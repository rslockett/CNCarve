"use client";

import type { PatternPlacement, StockOnBed } from "@/lib/presets/types";
import type React from "react";

/** Shared copy for where to set XY work zero vs Setup / Kiri placement. */
export function XyTouchOffGuidanceText(
  stockOnBed: StockOnBed,
  patternPlacement: PatternPlacement,
): React.ReactNode {
  if (patternPlacement === "center") {
    return (
      <>
        <strong className="text-slate-200">Yes — that’s fine.</strong>{" "}
        <strong className="text-slate-200">Work zero</strong> means “this spot on the wood is X0 Y0.”
        You chose <strong className="text-slate-200">Center</strong> placement, so the job is
        centered in the stock box in Kiri —{" "}
        <strong className="text-slate-200">
          jog to about the middle of your real board (middle-ish is OK) and set XY zero there
        </strong>
        . Relief carving doesn’t need sub-millimeter XY touch-off; close is usually fine.
      </>
    );
  }

  if (stockOnBed === "centered") {
    return (
      <>
        Your <strong className="text-slate-200">board is centered</strong> on the table in Setup,
        but the carve is <strong className="text-slate-200">not</strong> in the middle of the stock
        in Kiri (you picked another placement). XY zero should be the{" "}
        <strong className="text-slate-200">same corner or edge</strong> on real wood as in the
        preview — usually <strong className="text-slate-200">not</strong> the geographic center of
        the block unless that happens to match the toolpath origin.
      </>
    );
  }

  return (
    <>
      You chose a <strong className="text-slate-200">corner / edge</strong> placement and stock
      anchored at the <strong className="text-slate-200">front-left</strong> of the bed. Jog so the
      bit is over the <strong className="text-slate-200">matching point</strong> on your board (often
      the front-left corner of the wood aligned with how you pictured the stock box in Kiri), then
      set XY zero there.
    </>
  );
}
