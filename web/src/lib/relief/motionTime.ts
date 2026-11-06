/**
 * How long a program really takes on a GRBL machine.
 *
 * Path length ÷ feed badly underestimates relief carving: the program is thousands of tiny moves
 * that change direction constantly (the V-bit rides up and down the surface), and a 3018 has
 * modest acceleration. GRBL slows at every corner and rarely reaches the set feed on short moves.
 *
 * This follows GRBL 1.1's planner rules:
 *  - each move's top speed is the feed, capped per axis by $110–$112 (max rate);
 *  - acceleration is capped per axis by $120–$122;
 *  - the speed through a corner is limited by junction deviation ($11);
 *  - the planner only looks ~15 moves ahead, so it must always be able to stop within them;
 *  - each move is a trapezoid (accelerate, cruise, decelerate).
 */

export type MotionSettings = {
  /** mm/min */
  maxRate: [number, number, number];
  /** mm/s² */
  accel: [number, number, number];
  /** $11, mm */
  junctionDeviation: number;
};

/**
 * Defaults typical of a SainSmart / Genmitsu 3018-PROVer. The real values are read from the
 * machine ($$) when it is connected, and the estimate is refined with them.
 */
export const PROVER_MOTION: MotionSettings = {
  maxRate: [1000, 1000, 600],
  accel: [30, 30, 30],
  junctionDeviation: 0.01,
};

/** Read the motion settings out of a `$$` dump; anything missing keeps the default. */
export function motionFromGrbl(s: Record<number, number>, base = PROVER_MOTION): MotionSettings {
  const pick = (k: number, d: number) => (Number.isFinite(s[k]) && s[k] > 0 ? s[k] : d);
  return {
    maxRate: [pick(110, base.maxRate[0]), pick(111, base.maxRate[1]), pick(112, base.maxRate[2])],
    accel: [pick(120, base.accel[0]), pick(121, base.accel[1]), pick(122, base.accel[2])],
    junctionDeviation: pick(11, base.junctionDeviation),
  };
}

const PLANNER_BLOCKS = 15;

type Block = { len: number; vNom: number; acc: number; vJunc: number };

/**
 * Estimated seconds per GRBL line (comments removed, same numbering the sender uses). Lines that
 * don't move get 0 except dwells (G4 P…), which count their seconds.
 */
export function lineSeconds(gcode: string, m: MotionSettings = PROVER_MOTION): Float64Array {
  const lines: string[] = [];
  for (const raw of gcode.split(/\r?\n/)) {
    const noParen = raw.replace(/\([^)]*\)/g, "");
    const semi = noParen.indexOf(";");
    const code = (semi >= 0 ? noParen.slice(0, semi) : noParen).trim();
    if (code && code !== "%") lines.push(code.toUpperCase());
  }
  const out = new Float64Array(lines.length);
  const blocks: Block[] = [];
  const blockLine: number[] = [];
  const rapid = Math.min(...m.maxRate) > 0 ? m.maxRate : [1000, 1000, 600];
  let pos = [0, 0, 0];
  let feed = 500,
    motion = 0;
  let prevU: number[] | null = null;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const g4 = /G4\s*P(\d*\.?\d+)/.exec(l);
    if (g4) {
      out[li] += Number(g4[1]);
      prevU = null; // the machine comes to a stop for a dwell
      continue;
    }
    for (const g of l.matchAll(/G(\d+)/g)) if (g[1] === "0" || g[1] === "1") motion = Number(g[1]);
    const f = /F(\d*\.?\d+)/.exec(l);
    if (f) feed = Number(f[1]);
    const next = pos.slice();
    let moved = false;
    for (const a of l.matchAll(/([XYZ])\s*(-?\d*\.?\d+)/g)) {
      next["XYZ".indexOf(a[1])] = Number(a[2]);
      moved = true;
    }
    if (!moved) continue;
    const d = [next[0] - pos[0], next[1] - pos[1], next[2] - pos[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    pos = next;
    if (len < 1e-6) continue;
    const u = d.map((v) => v / len);
    // Feed (mm/s), capped so no axis exceeds its own max rate.
    let vNom = (motion === 0 ? Infinity : feed) / 60;
    let acc = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = Math.abs(u[k]);
      if (c < 1e-9) continue;
      vNom = Math.min(vNom, rapid[k] / 60 / c);
      acc = Math.min(acc, m.accel[k] / c);
    }
    // Corner speed (GRBL junction deviation formula).
    let vJunc = 0;
    if (prevU) {
      const cos = -(prevU[0] * u[0] + prevU[1] * u[1] + prevU[2] * u[2]);
      if (cos < -0.999999) vJunc = Infinity; // straight on
      else if (cos < 0.999999) {
        const s2 = Math.sqrt(0.5 * (1 - cos));
        vJunc = Math.sqrt((acc * m.junctionDeviation * s2) / (1 - s2));
      }
    }
    blocks.push({ len, vNom, acc, vJunc });
    blockLine.push(li);
    prevU = u;
    // A dwell or the end of the program means a full stop (handled by vJunc = 0 next time).
  }

  const n = blocks.length;
  // Entry speed limits: corner, own top speed, previous top speed.
  const vMaxEntry = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = blocks[i];
    vMaxEntry[i] = i === 0 ? 0 : Math.min(b.vJunc, b.vNom, blocks[i - 1].vNom);
  }
  // Lookahead limit: must always be able to stop within the next PLANNER_BLOCKS moves.
  let window = 0;
  for (let i = n - 1, j = n - 1; i >= 0; i--) {
    window += blocks[i].len;
    while (j - i + 1 > PLANNER_BLOCKS) window -= blocks[j--].len;
    vMaxEntry[i] = Math.min(vMaxEntry[i], Math.sqrt(2 * blocks[i].acc * window));
  }
  // Backward pass (can we slow down in time?) then forward pass (can we speed up in time?).
  const entry = new Float64Array(n + 1); // entry[n] = 0: stop at the end
  for (let i = n - 1; i >= 0; i--) {
    entry[i] = Math.min(vMaxEntry[i], Math.sqrt(entry[i + 1] ** 2 + 2 * blocks[i].acc * blocks[i].len));
  }
  for (let i = 0; i < n; i++) {
    const reach = Math.sqrt(entry[i] ** 2 + 2 * blocks[i].acc * blocks[i].len);
    if (entry[i + 1] > reach) entry[i + 1] = reach;
  }
  // Time for each trapezoid.
  for (let i = 0; i < n; i++) {
    const { len, vNom, acc } = blocks[i];
    const v0 = entry[i],
      v1 = entry[i + 1];
    let t: number;
    // Peak speed if it never cruised.
    const vPeak = Math.sqrt((2 * acc * len + v0 * v0 + v1 * v1) / 2);
    if (vPeak <= vNom) t = (vPeak - v0) / acc + (vPeak - v1) / acc;
    else {
      const dAcc = (vNom * vNom - v0 * v0) / (2 * acc);
      const dDec = (vNom * vNom - v1 * v1) / (2 * acc);
      t = (vNom - v0) / acc + (vNom - v1) / acc + (len - dAcc - dDec) / vNom;
    }
    out[blockLine[i]] += Math.max(0, t);
  }
  return out;
}

export function totalMinutes(sec: Float64Array): number {
  let s = 0;
  for (let i = 0; i < sec.length; i++) s += sec[i];
  return s / 60;
}
