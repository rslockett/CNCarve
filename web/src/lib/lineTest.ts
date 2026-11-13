/**
 * Line test (about 8 minutes): find out whether the faster acceleration from the speed check is
 * what leaves lines in carvings.
 *
 * Two small strips side by side on scrap, cut exactly like the detail pass of a real carving —
 * the user's bit, wood feed and row spacing, back-and-forth rows, and tiny up-and-down moves
 * every half row-spacing — but shallow (0.1–0.3 mm), so no roughing is needed.
 *
 *  - Left strip: the machine's current settings (how carvings run now).
 *  - Right strip: gentler acceleration.
 *
 * The relief engine is not used or changed.
 */

import { lineSeconds, type MotionSettings } from "./relief/motionTime";
import type { ReliefSettings } from "./relief/settings";
import { loadOriginal, type SpeedSettings } from "./speedCheck";

/** Strip size and gap (mm). Together about 1.2 × 0.25 in. */
export const STRIP_W = 14;
export const STRIP_H = 6;
const GAP = 3;

/** Surface below the board top (mm): gentle waves, so the bit rises and falls like on a relief. */
function depthAt(x: number, y: number) {
  return -0.12 - 0.18 * (0.5 + 0.5 * Math.cos((2 * Math.PI * x) / 6 + y * 0.4));
}

const f3 = (v: number) => v.toFixed(3);

/** One strip centred at X = cx, cut like the relief engine's detail pass. */
function strip(cx: number, s: ReliefSettings): string {
  const P = s.params;
  const step = P.finishStepMm;
  const res = P.resMm;
  const L: string[] = [
    "(CNCarve line test - one strip, detail pass only)",
    "G21 G90 G17 G94",
    `G0 Z${f3(P.safeZ)}`,
    `M3 S${P.spindleS}`,
    "G4 P4",
  ];
  const rows = Math.round(STRIP_H / step);
  const cols = Math.round(STRIP_W / res);
  let flip = false;
  for (let r = 0; r <= rows; r++) {
    const y = -STRIP_H / 2 + r * step;
    const xs: number[] = [];
    for (let c = 0; c <= cols; c++) xs.push(-STRIP_W / 2 + c * res);
    if (flip) xs.reverse();
    flip = !flip;
    // Same as every engine segment: lift, move over, drop to just above the wood, plunge, cut.
    L.push(`G0 Z${f3(P.clearZ)}`);
    L.push(`G0 X${f3(cx + xs[0])} Y${f3(y)}`);
    L.push("G0 Z0.3");
    L.push(`G1 Z${f3(depthAt(xs[0], y))} F${P.feedPlunge}`);
    for (let k = 1; k < xs.length; k++)
      L.push(`G1 X${f3(cx + xs[k])} Y${f3(y)} Z${f3(depthAt(xs[k], y))} F${P.feedFinish}`);
  }
  L.push(`G0 Z${f3(P.safeZ)}`, "M5");
  return L.join("\n") + "\n";
}

/**
 * The gentler settings for the right strip: the settings from before the first speed check when
 * they are known and slower, otherwise 40% of the current acceleration with a tighter corner setting (never below 10 mm/s²).
 */
export function gentleSettings(g: Record<number, number>): SpeedSettings {
  const o = loadOriginal();
  const now = Math.min(g[120], g[121]);
  // Never below 10 mm/s², so the right strip stays quick (the whole test under 10 minutes).
  const floor = (a: number) => Math.max(10, a);
  if (o && Math.min(o[120], o[121]) < now)
    return { 120: floor(o[120]), 121: floor(o[121]), 122: floor(o[122]), 11: o[11] };
  const a = floor(Math.round(now * 0.4));
  return { 120: a, 121: a, 122: Math.min(g[122], a), 11: Math.min(g[11], 0.01) };
}

export function speedOf(g: Record<number, number>): SpeedSettings {
  return { 120: g[120], 121: g[121], 122: g[122], 11: g[11] };
}

export function motionWith(base: MotionSettings, s: SpeedSettings): MotionSettings {
  return { ...base, accel: [s[120], s[121], s[122]], junctionDeviation: s[11] };
}

export type LineTestProgram = { left: string; right: string; minutes: [number, number] };

const minutesOf = (g: string, m: MotionSettings) => lineSeconds(g, m).reduce((a, b) => a + b, 0) / 60;

export function buildLineTest(s: ReliefSettings, fast: MotionSettings, gentle: MotionSettings): LineTestProgram {
  const dx = STRIP_W / 2 + GAP / 2;
  const left = strip(-dx, s);
  const right = strip(dx, s);
  return { left, right, minutes: [minutesOf(left, fast), minutesOf(right, gentle)] };
}
