/**
 * Carving time: predicted from GRBL's motion rules (motionTime.ts) with the machine's own
 * settings, then corrected by what real carves on this machine actually took.
 *
 * - `timeline` stores predicted cumulative seconds every TIMELINE_STEP lines, so the time for any
 *   range of lines can be looked up cheaply while carving.
 * - The learned factor = actual seconds ÷ predicted seconds, measured while carving (paused time
 *   excluded) and saved on this device, so every later estimate starts from reality.
 */

import { PROVER_MOTION, type MotionSettings } from "./relief/motionTime";

export const TIMELINE_STEP = 100;

export function buildTimeline(lineSec: Float64Array): number[] {
  const out: number[] = [0];
  let acc = 0;
  for (let i = 0; i < lineSec.length; i++) {
    acc += lineSec[i];
    if ((i + 1) % TIMELINE_STEP === 0) out.push(acc);
  }
  if (lineSec.length % TIMELINE_STEP !== 0) out.push(acc);
  return out;
}

/** Predicted seconds from the start of the program to `line`. */
export function predictedAt(timeline: number[], line: number, lineCount: number): number {
  if (!timeline.length) return 0;
  const l = Math.max(0, Math.min(lineCount, line));
  const k = Math.floor(l / TIMELINE_STEP);
  if (k >= timeline.length - 1) return timeline[timeline.length - 1];
  const t = (l - k * TIMELINE_STEP) / Math.min(TIMELINE_STEP, lineCount - k * TIMELINE_STEP || TIMELINE_STEP);
  return timeline[k] + (timeline[k + 1] - timeline[k]) * Math.min(1, t);
}

// ---- learned correction ----
const FACTOR_KEY = "cncarve:timeFactor";
export type LearnedFactor = { factor: number; minutesMeasured: number; updatedAt: number };

export function loadFactor(): LearnedFactor | null {
  try {
    const f = JSON.parse(localStorage.getItem(FACTOR_KEY) ?? "null") as LearnedFactor | null;
    return f && Number.isFinite(f.factor) && f.factor > 0.2 && f.factor < 10 ? f : null;
  } catch {
    return null;
  }
}

/**
 * Blend a new measurement into the saved factor, weighted by how long each was measured
 * (capped so a fresh carve can still move it).
 */
export function recordFactor(measured: number, minutes: number): LearnedFactor | null {
  if (!Number.isFinite(measured) || measured <= 0.2 || measured >= 10 || minutes < 5) return loadFactor();
  const old = loadFactor();
  const wOld = old ? Math.min(old.minutesMeasured, 240) : 0;
  const f = old ? (old.factor * wOld + measured * minutes) / (wOld + minutes) : measured;
  const next = { factor: f, minutesMeasured: wOld + minutes, updatedAt: Date.now() };
  try {
    localStorage.setItem(FACTOR_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

// ---- machine motion settings (remembered between visits) ----
const MOTION_KEY = "cncarve:motion";

export function loadMotion(): { motion: MotionSettings; fromMachine: boolean } {
  try {
    const m = JSON.parse(localStorage.getItem(MOTION_KEY) ?? "null") as MotionSettings | null;
    if (m && m.maxRate?.length === 3 && m.accel?.length === 3 && m.junctionDeviation > 0)
      return { motion: m, fromMachine: true };
  } catch {
    /* ignore */
  }
  return { motion: PROVER_MOTION, fromMachine: false };
}

export function saveMotion(m: MotionSettings) {
  try {
    localStorage.setItem(MOTION_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export function sameMotion(a: MotionSettings, b: MotionSettings) {
  return (
    a.junctionDeviation === b.junctionDeviation &&
    a.maxRate.every((v, i) => v === b.maxRate[i]) &&
    a.accel.every((v, i) => v === b.accel[i])
  );
}
