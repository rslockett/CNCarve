/**
 * Guided speed check: find out whether the machine can safely use a higher acceleration.
 *
 * How it works (no cutting, spindle off):
 *  1. The bit is placed just above a pencil dot and that spot is remembered (machine coordinates).
 *  2. The new acceleration / junction settings are written, and the machine runs a hard test
 *     pattern in the air near the dot: short zig-zags, quick direction changes, Z hops, circles.
 *  3. It returns to exactly the remembered spot. If the tip is still right over the dot, no
 *     steps were lost and the new settings are kept. If not, the original settings go back.
 *
 * The pattern uses machine coordinates (G53), so it never depends on — or changes — the
 * carving zero, and it is kept inside the machine's travel and above the dot.
 */

import type { Pos } from "./carveMachine";

export type SpeedTarget = { accel: number; junction: number };

/** A common, conservative setting for 3018-class machines. */
export const RECOMMENDED: SpeedTarget = { accel: 30, junction: 0.02 };
/** One step further, only offered after the recommended setting passes. */
export const FASTER: SpeedTarget = { accel: 50, junction: 0.02 };

/** The settings the check changes. */
export const SPEED_KEYS = [120, 121, 122, 11] as const;
export type SpeedSettings = Record<(typeof SPEED_KEYS)[number], number>;

const ORIGINAL_KEY = "cncarve:originalSpeedSettings";

/** Remember the machine's settings from before the first change (never overwritten after). */
export function rememberOriginal(s: Record<number, number>) {
  try {
    if (localStorage.getItem(ORIGINAL_KEY)) return;
    const o: Partial<SpeedSettings> = {};
    for (const k of SPEED_KEYS) if (Number.isFinite(s[k])) o[k] = s[k];
    if (Object.keys(o).length === SPEED_KEYS.length) localStorage.setItem(ORIGINAL_KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

export function loadOriginal(): SpeedSettings | null {
  try {
    const o = JSON.parse(localStorage.getItem(ORIGINAL_KEY) ?? "null") as SpeedSettings | null;
    return o && SPEED_KEYS.every((k) => Number.isFinite(o[k])) ? o : null;
  } catch {
    return null;
  }
}

export function forgetOriginal() {
  try {
    localStorage.removeItem(ORIGINAL_KEY);
  } catch {
    /* ignore */
  }
}

export function settingCommands(t: SpeedTarget): string[] {
  return [`$120=${t.accel}`, `$121=${t.accel}`, `$122=${t.accel}`, `$11=${t.junction}`];
}

export function originalCommands(o: SpeedSettings): string[] {
  return SPEED_KEYS.map((k) => `$${k}=${o[k]}`);
}

/**
 * The test pattern in machine coordinates. `travel` comes from $130–$132; GRBL homes to the top
 * corner so machine positions run from 0 down to −travel. Everything stays 3 mm inside that,
 * and never lower than 2 mm above the remembered spot.
 */
export function testPattern(mark: Pos, travel: { x: number; y: number; z: number }): string[] {
  const xMin = -travel.x + 3,
    xMax = -3,
    yMin = -travel.y + 3,
    yMax = -3;
  const zLow = mark.z + 2;
  const zHigh = Math.min(mark.z + 10, -1);
  if (zHigh <= zLow) throw new Error("There isn't room to lift the bit. Move it lower, then try again.");
  const cx = (v: number) => Math.min(xMax, Math.max(xMin, v));
  const cy = (v: number) => Math.min(yMax, Math.max(yMin, v));
  const f = (v: number) => v.toFixed(3);
  const L: string[] = ["G21", "G90", "M5", `G53 G0 Z${f(zHigh)}`];
  for (let round = 0; round < 3; round++) {
    // Short zig-zags: constant hard direction changes, like a detail pass.
    for (let k = 0; k < 14; k++) {
      const x = cx(mark.x + (k % 2 === 0 ? -6 : 6));
      const y = cy(mark.y - 7 + k);
      L.push(`G53 G1 X${f(x)} Y${f(y)} F1000`);
    }
    // Quick Z hops with small sideways steps, like a V-bit riding a relief.
    for (let k = 0; k < 10; k++) {
      L.push(`G53 G1 X${f(cx(mark.x + (k % 2 ? 1.5 : -1.5)))} Z${f(k % 2 ? zLow : zHigh)} F600`);
    }
    L.push(`G53 G0 Z${f(zHigh)}`);
    // Long rapid diagonals across the area.
    L.push(`G53 G0 X${f(cx(mark.x - 15))} Y${f(cy(mark.y - 15))}`);
    L.push(`G53 G0 X${f(cx(mark.x + 15))} Y${f(cy(mark.y + 15))}`);
    L.push(`G53 G0 X${f(cx(mark.x + 15))} Y${f(cy(mark.y - 15))}`);
    L.push(`G53 G0 X${f(cx(mark.x - 15))} Y${f(cy(mark.y + 15))}`);
    // A circle made of short moves.
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      L.push(`G53 G1 X${f(cx(mark.x + 8 * Math.cos(a)))} Y${f(cy(mark.y + 8 * Math.sin(a)))} F1000`);
    }
  }
  // Back to exactly the remembered spot: over it high, then down slowly to the same height.
  L.push(`G53 G0 Z${f(zHigh)}`);
  L.push(`G53 G0 X${f(mark.x)} Y${f(mark.y)}`);
  L.push(`G53 G1 Z${f(mark.z)} F200`);
  return L;
}
