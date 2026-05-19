import type { JsonObject } from "./presets/types";

/** Wizard quality ids that drive relief CAM derivation */
export type ReliefCamQualityId = "fast" | "balanced" | "fine" | "replica";

/**
 * **Constant cusp height** (scallop) proxy for 3D contour **step** (pass spacing × flute ø): treat
 * local curvature like a ball of radius **R = flute_diam / 2** so **h ≈ s² / (8R)** (standard
 * ball-mill identity). V-bits vary with depth; **R = D/2** stays a conservative proxy.
 *
 * **Tolerance / flatness** are **not** scaled off step spacing: in Kiri topo, `tolerance` is the XY
 * slice grid pitch — tying it to `step×D` drove values ~0.2 mm on Balanced and made Preview/Animate
 * look voxelized. Those stay on explicit per-tier tables; we only **cap** tolerance so it never
 * exceeds ~half a pass width (avoids paying for a grid finer than the toolpath without going coarse).
 *
 * **Sharper (`fine`)** is still tighter than Balanced, but no longer uses an ultra-tight scallop
 * that made small plaques take many hours — pass count scales roughly with (1/h)² on shallow
 * relief. **Showpiece (`replica`)** stays the tightest tier for when time is secondary.
 */
const TARGET_CUSP_MM: Record<ReliefCamQualityId, number> = {
  fast: 0.070,
  balanced: 0.056,
  fine: 0.040,
  replica: 0.019,
};

/**
 * Kiri topo XY slice pitch (mm). Keep Balanced/Fine **below ~0.14** so Preview does not voxelize;
 * Replica stays tight for “best quality / I’ll wait.”
 */
const TIER_TOLERANCE_MM: Record<ReliefCamQualityId, number> = {
  fast: 0.13,
  balanced: 0.11,
  fine: 0.082,
  replica: 0.056,
};

const TIER_FLATNESS: Record<ReliefCamQualityId, number> = {
  fast: 0.0035,
  balanced: 0.0025,
  fine: 0.00185,
  replica: 0.00112,
};

const REDUCTION: Record<ReliefCamQualityId, number> = {
  fast: 5,
  balanced: 4,
  fine: 3,
  replica: 2,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Read `flute_diam` from a Kiri tool row; inch rows use `metric: false`. */
export function fluteDiameterMmFromPresetTool(tool: JsonObject | undefined): number {
  if (!tool) return 3.175;
  const raw = Number(tool.flute_diam ?? 0.125);
  const metric = Boolean(tool.metric);
  const mm = metric ? raw : raw * 25.4;
  if (!Number.isFinite(mm) || mm < 0.25) return 3.175;
  return mm;
}

export type ReliefContourDerivation = {
  contourStep: number;
  tolerance: number;
  flatness: number;
  reduction: number;
  outlineOver: number;
};

/**
 * Derive Kiri contour/outline spacing for one-bit (or finish) relief from tool diameter, part
 * span, carve depth, and quality tier.
 */
export function deriveReliefContourParams(args: {
  qualityId: ReliefCamQualityId;
  fluteDiameterMm: number;
  /** Max XY extent of the carved pattern (mm); used for span-aware cusp tweak. */
  patternSpanMm: number;
  patternDepthMm: number;
}): ReliefContourDerivation {
  const D = clamp(args.fluteDiameterMm, 0.5, 25);
  const R = D / 2;

  let h = TARGET_CUSP_MM[args.qualityId];
  const span = clamp(args.patternSpanMm, 6, 500);
  const depth = Math.max(0, args.patternDepthMm);

  // Large boards: relax scallop target slightly.
  if (span > 210) h *= 1.08;
  /**
   * Small plaques / jewelry-scale: the same cusp target as on a 200 mm wide carve forces far
   * more passes than the eye can resolve on a ~60 mm part — relax h so Sharper stays “sharp”
   * without multi-hour runtimes.
   */
  if (span < 95) {
    const relax = span < 48 ? 1.2 : span < 72 ? 1.12 : 1.06;
    h *= relax;
  }
  h = clamp(h, 0.012, 0.15);

  // s = sqrt(8 R h); step_frac = s / D = sqrt(4 h / D)
  let stepFrac = Math.sqrt(Math.max(1e-12, (8 * R * h) / (D * D)));
  const aspect = depth / span;
  // Deeper reliefs vs footprint: tighten lateral spacing modestly (walls show ridges more).
  if (aspect > 0.07) {
    const bump = 1 + Math.min(0.18, (aspect - 0.07) * 0.55);
    stepFrac /= bump;
  }
  stepFrac = clamp(stepFrac, 0.048, 0.62);

  const toolStepMm = stepFrac * D;

  let tolerance = TIER_TOLERANCE_MM[args.qualityId];
  const flatnessBase = TIER_FLATNESS[args.qualityId];
  // Never set slice pitch much wider than lateral pass spacing (Kiri looks “cubed” if violated).
  const tolCeil = Math.max(0.04, 0.52 * toolStepMm);
  tolerance = clamp(Math.min(tolerance, tolCeil), 0.018, 0.22);
  const flatness = clamp(flatnessBase, 0.00028, 0.0048);

  const reduction = REDUCTION[args.qualityId];

  // Outline step-over (fraction of tool): correlate with contour aggressiveness; cap for Kiri UI
  const outlineOver = clamp(0.28 + stepFrac * 0.62, 0.08, 0.6);

  return {
    contourStep: Number(stepFrac.toFixed(4)),
    tolerance: Number(tolerance.toFixed(5)),
    flatness: Number(flatness.toFixed(6)),
    reduction,
    outlineOver: Number(outlineOver.toFixed(3)),
  };
}
