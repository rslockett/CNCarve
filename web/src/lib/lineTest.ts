/**
 * Line test (under 10 minutes): find out whether the faster acceleration from the speed check is
 * what leaves lines in carvings.
 *
 * Carvings were clean at the machine's original settings and show lines since the speed check
 * raised acceleration to 30. A first test that cut only the detail pass showed no difference, so
 * this one cuts like a whole carving on a flat area (like the arms of a cross): roughing layers,
 * then the detail pass — the user's bit, feeds, row spacing, layer depth and the wood left for
 * the detail pass, with every row started the way the relief engine starts it.
 *
 *  - Left strip: roughing and detail at the current settings (how carvings run now).
 *  - Right strip: roughing at the original settings, detail at the current settings.
 *
 * The relief engine is not used or changed.
 */

import { lineSeconds, type MotionSettings } from "./relief/motionTime";
import type { ReliefSettings } from "./relief/settings";
import { loadOriginal, type SpeedSettings } from "./speedCheck";

/** Strip size, gap and depth (mm). Together about 1 × 0.2 in. */
export const STRIP_W = 12;
export const STRIP_H = 5;
const GAP = 3;
const DEPTH = 1.1;

const f3 = (v: number) => v.toFixed(3);

/**
 * One pass over the strip at depth z: rows `step` apart, back and forth, each row started like the
 * engine starts a segment (lift, move over, drop to just above the wood, plunge, cut).
 */
function pass(L: string[], cx: number, step: number, z: number, woodTop: number, feed: number, P: ReliefSettings["params"]) {
  const rows = Math.round(STRIP_H / step);
  let flip = false;
  for (let r = 0; r <= rows; r++) {
    const y = -STRIP_H / 2 + Math.min(r * step, STRIP_H);
    const a = flip ? STRIP_W / 2 : -STRIP_W / 2;
    flip = !flip;
    L.push(`G0 Z${f3(P.clearZ)}`);
    L.push(`G0 X${f3(cx + a)} Y${f3(y)}`);
    L.push(`G0 Z${f3(Math.min(P.clearZ, woodTop + 0.3))}`);
    L.push(`G1 Z${f3(z)} F${P.feedPlunge}`);
    L.push(`G1 X${f3(cx - a)} Y${f3(y)} F${feed}`);
  }
}

/** A strip centred at X = cx: roughing (with spindle start) and detail pass as separate programs. */
function strip(cx: number, s: ReliefSettings) {
  const P = s.params;
  const rough: string[] = ["(CNCarve line test - roughing)", "G21 G90 G17 G94", `G0 Z${f3(P.safeZ)}`, `M3 S${P.spindleS}`, "G4 P4"];
  const roughTo = -(DEPTH - P.leaveMm);
  let top = 0;
  for (let level = 0; level > roughTo + 1e-6; ) {
    level = Math.max(level - P.roughLayerMm, roughTo);
    pass(rough, cx, P.roughStepMm, level, top, P.feedRough, P);
    top = level;
  }
  rough.push(`G0 Z${f3(P.clearZ)}`);
  const detail: string[] = ["(CNCarve line test - detail pass)"];
  pass(detail, cx, P.finishStepMm, -DEPTH, 0, P.feedFinish, P);
  detail.push(`G0 Z${f3(P.safeZ)}`, "M5");
  return { rough: rough.join("\n") + "\n", detail: detail.join("\n") + "\n" };
}

/**
 * The settings for the right strip's roughing: the original ones from before the first speed
 * check (carvings were clean with those), otherwise 40% of the current acceleration.
 */
export function gentleSettings(g: Record<number, number>): SpeedSettings {
  const o = loadOriginal();
  const now = Math.min(g[120], g[121]);
  if (o && Math.min(o[120], o[121]) < now) return o;
  const a = Math.max(5, Math.round(now * 0.4));
  return { 120: a, 121: a, 122: Math.min(g[122], a), 11: Math.min(g[11], 0.01) };
}

export function speedOf(g: Record<number, number>): SpeedSettings {
  return { 120: g[120], 121: g[121], 122: g[122], 11: g[11] };
}

export function motionWith(base: MotionSettings, s: SpeedSettings): MotionSettings {
  return { ...base, accel: [s[120], s[121], s[122]], junctionDeviation: s[11] };
}

/** One piece of the test, run with these speed settings. */
export type LineTestPart = { strip: 1 | 2; gcode: string; speed: SpeedSettings };

export type LineTestProgram = { parts: LineTestPart[]; minutes: [number, number] };

const minutesOf = (g: string, m: MotionSettings) => lineSeconds(g, m).reduce((a, b) => a + b, 0) / 60;

export function buildLineTest(
  s: ReliefSettings,
  base: MotionSettings,
  current: SpeedSettings,
  gentle: SpeedSettings,
): LineTestProgram {
  const dx = STRIP_W / 2 + GAP / 2;
  const left = strip(-dx, s);
  const right = strip(dx, s);
  const fast = motionWith(base, current);
  const slow = motionWith(base, gentle);
  return {
    parts: [
      { strip: 1, gcode: left.rough + left.detail, speed: current },
      { strip: 2, gcode: right.rough, speed: gentle },
      { strip: 2, gcode: right.detail, speed: current },
    ],
    minutes: [
      minutesOf(left.rough + left.detail, fast),
      minutesOf(right.rough, slow) + minutesOf(right.detail, fast),
    ],
  };
}
