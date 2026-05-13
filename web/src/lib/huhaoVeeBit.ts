import type { JsonObject } from "./presets/types";

const MM_PER_IN = 25.4;

/** Nominal ⅛″ shank / flute body (inches → mm). */
const EIGHTH_MM = 0.125 * MM_PER_IN;

/**
 * HUHAO-style ⅛″ shank V-bit: **20° included** angle, **0.1 mm** flat tip (diameter).
 *
 * Kiri’s {@link https://github.com/GridSpace/grid-apps/blob/master/src/kiri/mode/cam/core/tool.js Tool}
 * uses `metric: false` as **inches × 25.4** and `metric: true` as **raw millimeters**. This helper
 * emits **`metric: true`** only, so nothing is double-converted.
 *
 * `flute_len` is the axial length (mm) of the tapered section used for the cone profile, derived
 * from the tip flat and half-angle so the silhouette is consistent with the stated geometry.
 */
export function huhaoTapermill1003ForKiri(): JsonObject {
  const halfAngleDeg = 10; // 20° included, from tool axis
  const tipFlatMm = 0.1;
  const R = EIGHTH_MM / 2;
  const r = tipFlatMm / 2;
  const tan = Math.tan((halfAngleDeg * Math.PI) / 180);
  const fluteLenMm = Math.min(12, Math.max(4, (R - r) / tan));

  return {
    id: 1003,
    number: 4,
    type: "tapermill",
    name: 'HUHAO 20° V (⅛" shank, 0.1 mm tip)',
    metric: true,
    shaft_diam: EIGHTH_MM,
    shaft_len: 25.4,
    flute_diam: EIGHTH_MM,
    flute_len: Number(fluteLenMm.toFixed(2)),
    taper_angle: halfAngleDeg,
    taper_tip: tipFlatMm,
    /** Used only by CNCarve `outlineSilhouetteExpandMm` (extra mm outside silhouette). */
    outlineSilhouetteBonusMm: 0.12,
  };
}

/**
 * **Genmitsu / ProVER box kit** small ⅛″ engraving vee (the short bit with a sharp tip line, not a
 * wide 60° profile). SainSmart does **not** publish an included angle for these; they read visually
 * like a **narrow PCB-style vee** (similar cone to the HUHAO row), so we use the **same 20° included**
 * cone math for CAM silhouette — **measure yours** and edit `taper_angle` / `taper_tip` in Kiri if
 * your bit differs. Shank is shorter than the HUHAO spec row.
 *
 * Kiri still models this as a revolving `tapermill` (it has no “single split edge” tool type); the
 * envelope is close enough for outline expand and contour depth.
 */
export function proverKitEngraveVeeTapermill1007ForKiri(): JsonObject {
  const halfAngleDeg = 10; // 20° included — narrow kit vee, not 60°
  const tipFlatMm = 0.1;
  const R = EIGHTH_MM / 2;
  const r = tipFlatMm / 2;
  const tan = Math.tan((halfAngleDeg * Math.PI) / 180);
  const fluteLenMm = Math.min(12, Math.max(4, (R - r) / tan));

  return {
    id: 1007,
    number: 8,
    type: "tapermill",
    name: '⅛" ProVER kit engraving V (narrow, short shank)',
    metric: true,
    shaft_diam: EIGHTH_MM,
    /** Shorter than typical aftermarket vee bits; kit cutters are stubby. */
    shaft_len: 14,
    flute_diam: EIGHTH_MM,
    flute_len: Number(fluteLenMm.toFixed(2)),
    taper_angle: halfAngleDeg,
    taper_tip: tipFlatMm,
    outlineSilhouetteBonusMm: 0.10,
  };
}

/** @deprecated Use {@link proverKitEngraveVeeTapermill1007ForKiri}. Kept so old imports keep working. */
export const bundleVeeTapermill1007ForKiri = proverKitEngraveVeeTapermill1007ForKiri;
