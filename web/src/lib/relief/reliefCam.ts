/**
 * CNCarve relief engine: one bit, layered roughing + detail passes, short restartable jobs.
 *
 * Why this exists: Kiri's single-bit relief path makes one contour pass at full depth. With a
 * narrow V-bit in hardwood that buries the cone 3–5 mm deep at once, which stalls the 3018,
 * skips steps and snaps tips. Here the bit removes wood in shallow layers first and then
 * follows the surface, and every toolpath accounts for the bit's real shape so the side of the
 * cone never cuts into neighbouring detail.
 *
 * Coordinates: Z0 = top of the board. XY zero follows the Setup placement — centre of the board
 * for "Center", otherwise the front-left corner of the board (same convention as the Kiri path).
 */

import { dilate4, rasterizeRelief, type HeightMap } from "./heightmap";

export type BitShape =
  | { type: "vee"; halfAngleDeg: number; tipDiameterMm: number; diameterMm: number }
  | { type: "ball"; diameterMm: number }
  | { type: "flat"; diameterMm: number };

export type ReliefCamParams = {
  /** Finish pass spacing (mm) */
  finishStepMm: number;
  /** Rough pass spacing (mm) */
  roughStepMm: number;
  /** Depth of each roughing layer (mm) */
  roughLayerMm: number;
  /** Wood left on the surface by roughing for the detail pass to remove (mm) */
  leaveMm: number;
  /** How far below the board top the highest point of the design sits (mm) */
  topSkimMm: number;
  /** Width of the cleared groove around the design that you saw along (mm) */
  bandMm: number;
  /** How far the groove goes below the lowest point of the design (mm) */
  floorBelowMm: number;
  feedRough: number;
  feedFinish: number;
  feedPlunge: number;
  spindleS: number;
  safeZ: number;
  clearZ: number;
  /** Number of pieces each stage is split into (by height on the board). */
  regions: number;
  /** Grid resolution (mm per pixel). */
  resMm: number;
};

export type ReliefJob = {
  fileName: string;
  title: string;
  kind: "dry_run" | "rough" | "finish";
  gcode: string;
  estMinutes: number;
  lines: number;
};

export type ReliefPreview = {
  width: number;
  height: number;
  /** Target surface and simulated carved surface, machine Z (mm), row 0 = front of board. */
  target: Float32Array;
  carved: Float32Array;
  /** 1 = inside the area that gets machined */
  work: Uint8Array;
  res: number;
};

export type ReliefResult = {
  jobs: ReliefJob[];
  preview: ReliefPreview;
  summary: {
    designWidthMm: number;
    designDepthMm: number;
    reliefDepthMm: number;
    cutDepthMm: number;
    workMinX: number;
    workMaxX: number;
    workMinY: number;
    workMaxY: number;
    totalMinutes: number;
    /** Worst place the simulated cut goes below the design (mm). */
    maxGougeMm: number;
    /** Share of the design within 0.15 mm of the target after carving. */
    accuracyPct: number;
    problems: string[];
  };
};

export type ReliefInput = {
  /** Scaled mesh, mm, relief facing +Z */
  vertices: Float32Array;
  bit: BitShape;
  params: ReliefCamParams;
  placement: ReliefPlacement;
  onProgress?: (fraction: number, label: string) => void;
};

/**
 * Where XY zero is and where the design sits on the board.
 * - `center`: XY zero = centre of the board = centre of the design.
 * - otherwise: XY zero = front-left corner of the board; the design is pushed toward the chosen
 *   side, `marginMm` in from the edges (the same placements Setup offers for Kiri).
 */
export type ReliefPlacement = {
  where:
    | "center"
    | "front_left"
    | "front_right"
    | "back_left"
    | "back_right"
    | "left"
    | "right"
    | "front"
    | "back";
  stockWidthMm: number;
  stockDepthMm: number;
  marginMm: number;
};

export function designCenterForPlacement(
  pl: ReliefPlacement,
  halfW: number,
  halfD: number,
): { x: number; y: number } {
  if (pl.where === "center") return { x: 0, y: 0 };
  const m = Math.max(0, pl.marginMm);
  const left = m + halfW,
    right = pl.stockWidthMm - m - halfW,
    midX = pl.stockWidthMm / 2;
  const front = m + halfD,
    back = pl.stockDepthMm - m - halfD,
    midY = pl.stockDepthMm / 2;
  const x = pl.where.includes("left") ? left : pl.where.includes("right") ? right : midX;
  const y = pl.where.startsWith("front") ? front : pl.where.startsWith("back") ? back : midY;
  return { x, y };
}

/** Height of the bit's cutting surface above its tip at distance r from the centre. */
export function bitProfile(bit: BitShape, r: number): number {
  const R = bit.diameterMm / 2;
  if (r > R + 1e-9) return Infinity;
  if (bit.type === "flat") return 0;
  if (bit.type === "ball") return R - Math.sqrt(Math.max(0, R * R - r * r));
  const tipR = bit.tipDiameterMm / 2;
  if (r <= tipR) return 0;
  return (r - tipR) / Math.tan((bit.halfAngleDeg * Math.PI) / 180);
}

type Offset = { dx: number; dy: number; p: number };

function bitOffsets(bit: BitShape, res: number, depthRange: number): Offset[] {
  let rMax = bit.diameterMm / 2;
  if (bit.type === "vee") {
    const t = Math.tan((bit.halfAngleDeg * Math.PI) / 180);
    rMax = Math.min(rMax, bit.tipDiameterMm / 2 + (depthRange + 1) * t);
  }
  const k = Math.ceil(rMax / res);
  const out: Offset[] = [];
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) {
      const r = Math.hypot(dx, dy) * res;
      if (r > rMax + 1e-9) continue;
      const p = bitProfile(bit, r);
      if (Number.isFinite(p)) out.push({ dx, dy, p });
    }
  }
  // Nearest / lowest-profile points first, so per-pixel loops can stop early.
  out.sort((a, b) => a.p - b.p || Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  return out;
}

const NO_LIMIT = -1e6;

/** Max (or min) over a (2k+1)² square window — two O(n) sliding passes. */
function squareFilter(src: Float32Array, w: number, h: number, k: number, max: boolean): Float32Array {
  const pass = (a: Float32Array, len: number, count: number, stride: number, step: number) => {
    const out = new Float32Array(a.length);
    const dq = new Int32Array(len);
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      let head = 0,
        tail = 0;
      for (let i = 0; i < len + k; i++) {
        if (i < len) {
          const v = a[base + i * step];
          while (tail > head && (max ? a[base + dq[tail - 1] * step] <= v : a[base + dq[tail - 1] * step] >= v))
            tail--;
          dq[tail++] = i;
        }
        const o = i - k;
        if (o >= 0) {
          while (dq[head] < o - k) head++;
          out[base + o * step] = a[base + dq[head] * step];
        }
      }
    }
    return out;
  };
  const rows = pass(src, w, h, w, 1);
  return pass(rows, h, w, 1, w);
}

/**
 * "Drop cutter": for each pixel, the lowest the bit tip can go without any part of the bit
 * cutting below the target surface. Offsets are sorted by profile height, so a pixel stops
 * as soon as nothing in reach is tall enough to lift the bit further.
 */
function dropCutter(
  T: Float32Array,
  w: number,
  h: number,
  offsets: Offset[],
  work: Uint8Array,
): Float32Array {
  const k = offsets.reduce((a, o) => Math.max(a, Math.abs(o.dx), Math.abs(o.dy)), 0);
  const localMax = squareFilter(T, w, h, k, true);
  const out = new Float32Array(w * h).fill(NO_LIMIT);
  const m = offsets.length;
  const odx = Int32Array.from(offsets, (o) => o.dx);
  const ody = Int32Array.from(offsets, (o) => o.dy);
  const op = Float64Array.from(offsets, (o) => o.p);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      if (!work[idx]) continue;
      const cap = localMax[idx];
      let best = NO_LIMIT;
      for (let q = 0; q < m; q++) {
        const p = op[q];
        if (cap - p <= best) break;
        const si = i + odx[q],
          sj = j + ody[q];
        if (si < 0 || sj < 0 || si >= w || sj >= h) continue;
        const v = T[sj * w + si] - p;
        if (v > best) best = v;
      }
      out[idx] = best;
    }
  }
  return out;
}

/** Keep only points where Z bends; rows are straight lines in X. */
function compress(pts: [number, number, number][], tol = 0.004): [number, number, number][] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let a = 1; a < pts.length - 1; a++) {
    const p0 = out[out.length - 1],
      p1 = pts[a],
      p2 = pts[a + 1];
    const t = p2[0] !== p0[0] ? (p1[0] - p0[0]) / (p2[0] - p0[0]) : 0;
    if (Math.abs(p0[2] + t * (p2[2] - p0[2]) - p1[2]) > tol) out.push(p1);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const f3 = (v: number) => (Math.abs(v) < 0.0005 ? 0 : v).toFixed(3);

class GcodeWriter {
  lines: string[];
  cutMin = 0;
  rapidMm = 0;
  pos: [number, number, number];
  private feed: number | null = null;
  constructor(
    titleLines: string[],
    private P: ReliefCamParams,
  ) {
    this.lines = [
      ...titleLines.map((t) => `(${t.replace(/[()]/g, "-")})`),
      "(Zero - Z0 is the top of the board)",
      "G21 G90 G17 G94",
      `G0 Z${f3(P.safeZ)}`,
      `M3 S${P.spindleS}`,
      "G4 P4",
    ];
    this.pos = [0, 0, P.safeZ];
  }
  g0(x?: number, y?: number, z?: number) {
    const n: [number, number, number] = [x ?? this.pos[0], y ?? this.pos[1], z ?? this.pos[2]];
    this.rapidMm += Math.hypot(n[0] - this.pos[0], n[1] - this.pos[1], n[2] - this.pos[2]);
    this.pos = n;
    this.lines.push(
      "G0" +
        (x !== undefined ? ` X${f3(x)}` : "") +
        (y !== undefined ? ` Y${f3(y)}` : "") +
        (z !== undefined ? ` Z${f3(z)}` : ""),
    );
  }
  g1(x: number, y: number, z: number, f: number) {
    const d = Math.hypot(x - this.pos[0], y - this.pos[1], z - this.pos[2]);
    this.cutMin += d / f;
    this.pos = [x, y, z];
    this.lines.push(`G1 X${f3(x)} Y${f3(y)} Z${f3(z)}` + (f !== this.feed ? ` F${f}` : ""));
    this.feed = f;
  }
  plunge(z: number) {
    this.cutMin += Math.abs(this.pos[2] - z) / this.P.feedPlunge;
    this.pos = [this.pos[0], this.pos[1], z];
    this.lines.push(`G1 Z${f3(z)} F${this.P.feedPlunge}`);
    this.feed = this.P.feedPlunge;
  }
  finish(): { gcode: string; estMinutes: number; lines: number } {
    this.g0(undefined, undefined, this.P.safeZ);
    this.lines.push("M5", "G0 X0 Y0", "M30");
    // +25% for acceleration on a small hobby machine
    const estMinutes = (this.cutMin + this.rapidMm / 1500) * 1.25;
    return { gcode: this.lines.join("\n") + "\n", estMinutes, lines: this.lines.length };
  }
}

export function generateReliefJobs(input: ReliefInput): ReliefResult {
  const { bit, params: P } = input;
  const progress = input.onProgress ?? (() => {});
  const problems: string[] = [];

  progress(0.02, "Reading the model");
  const hm: HeightMap = rasterizeRelief(input.vertices, P.resMm, P.bandMm + 3);
  const { width: W, height: H, res: R } = hm;
  const n = W * H;
  const top = hm.zMax;
  const reliefDepth = hm.zMax - hm.zMin;

  // Target surface in machine Z.
  const bandPx = Math.max(1, Math.round(P.bandMm / R));
  const grown = dilate4(hm.mask, W, H, bandPx);
  const work = new Uint8Array(n);
  const T = new Float32Array(n).fill(NO_LIMIT);
  const floor = hm.zMin - top - P.topSkimMm - P.floorBelowMm;
  for (let k = 0; k < n; k++) {
    if (hm.mask[k]) {
      T[k] = hm.z[k] - top - P.topSkimMm;
      work[k] = 1;
    } else if (grown[k]) {
      T[k] = floor;
      work[k] = 1;
    }
  }

  progress(0.12, "Fitting the bit shape to the surface");
  const offsets = bitOffsets(bit, R, top - floor);
  const Zf = dropCutter(T, W, H, offsets, work);
  const Zr = new Float32Array(n);
  for (let k = 0; k < n; k++) Zr[k] = Zf[k] + P.leaveMm;
  let lowest = 0;
  for (let k = 0; k < n; k++) if (work[k] && Zf[k] < lowest) lowest = Zf[k];

  // Design centre → XY zero mapping.
  let mi0 = W,
    mi1 = 0,
    mj0 = H,
    mj1 = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++)
      if (hm.mask[j * W + i]) {
        if (i < mi0) mi0 = i;
        if (i > mi1) mi1 = i;
        if (j < mj0) mj0 = j;
        if (j > mj1) mj1 = j;
      }
  const cxPx = (mi0 + mi1) / 2,
    cyPx = (mj0 + mj1) / 2;

  let wi0 = W,
    wi1 = 0,
    wj0 = H,
    wj1 = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++)
      if (work[j * W + i]) {
        if (i < wi0) wi0 = i;
        if (i > wi1) wi1 = i;
        if (j < wj0) wj0 = j;
        if (j > wj1) wj1 = j;
      }
  // Place using the full machined area (design + saw groove) so the groove stays on the board.
  const halfW = Math.max(cxPx - wi0, wi1 - cxPx) * R;
  const halfD = Math.max(cyPx - wj0, wj1 - cyPx) * R;
  const centre = designCenterForPlacement(input.placement, halfW, halfD);
  const X = (i: number) => (i - cxPx) * R + centre.x;
  const Y = (j: number) => (j - cyPx) * R + centre.y;
  {
    const pl = input.placement;
    const ox = pl.where === "center" ? pl.stockWidthMm / 2 : 0;
    const oy = pl.where === "center" ? pl.stockDepthMm / 2 : 0;
    if (
      X(wi0) + ox < -0.01 ||
      X(wi1) + ox > pl.stockWidthMm + 0.01 ||
      Y(wj0) + oy < -0.01 ||
      Y(wj1) + oy > pl.stockDepthMm + 0.01
    )
      problems.push(
        `The carving area (${((wi1 - wi0) * R).toFixed(1)} × ${((wj1 - wj0) * R).toFixed(1)} mm with its saw groove) is bigger than the board in Setup (${pl.stockWidthMm.toFixed(1)} × ${pl.stockDepthMm.toFixed(1)} mm).`,
      );
  }

  /** Cut one set of rows; `surfaceTop` = Z of wood still above each pixel. */
  const raster = (
    g: GcodeWriter,
    Z: Float32Array,
    rows: number[],
    feed: number,
    surfaceTop: Float32Array | null,
  ) => {
    let flip = false;
    for (const j of rows) {
      const segs: number[][] = [];
      let cur: number[] | null = null;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const top0 = surfaceTop ? surfaceTop[k] : 0;
        const need = work[k] === 1 && Z[k] < top0 - 1e-3;
        if (need) {
          if (!cur) {
            cur = [];
            segs.push(cur);
          }
          cur.push(i);
        } else cur = null;
      }
      if (!segs.length) continue;
      if (flip) {
        segs.reverse();
        for (const s of segs) s.reverse();
      }
      flip = !flip;
      for (const s of segs) {
        const pts = compress(s.map((i) => [X(i), Y(j), Z[j * W + i]] as [number, number, number]));
        if (g.pos[2] < P.clearZ) g.g0(undefined, undefined, P.clearZ);
        g.g0(pts[0][0], pts[0][1]);
        const startTop = surfaceTop ? surfaceTop[j * W + s[0]] : 0;
        const above = Math.min(P.clearZ, startTop + 0.3);
        if (above < P.clearZ) g.g0(undefined, undefined, above);
        g.plunge(pts[0][2]);
        for (let a = 1; a < pts.length; a++) g.g1(pts[a][0], pts[a][1], pts[a][2], feed);
        g.g0(undefined, undefined, P.clearZ);
      }
    }
  };

  const jobs: ReliefJob[] = [];
  const regionNames =
    P.regions === 3 ? ["bottom", "middle", "top"] : Array.from({ length: P.regions }, (_, i) => `part ${i + 1}`);
  const cuts = Array.from({ length: P.regions + 1 }, (_, i) =>
    Math.floor(wj0 + ((wj1 + 1 - wj0) * i) / P.regions),
  );
  const rowsFor = (p: number, stepPx: number) => {
    const out: number[] = [];
    for (let j = Math.ceil(cuts[p] / stepPx) * stepPx; j < cuts[p + 1]; j += stepPx) out.push(j);
    return out;
  };

  // Step 0: dry run, spindle off, 2 mm above the board. Rapid (G0) moves only: the Run panel
  // blocks files that feed-move (G1) without a spindle-on, which is right for real cuts.
  {
    const x0 = X(wi0),
      x1 = X(wi1),
      y0 = Y(wj0),
      y1 = Y(wj1);
    const L = [
      "(Step 0 - DRY RUN - traces the carving area 2mm above the board - spindle stays OFF)",
      "G21 G90 G17 G94",
      "G0 Z5",
      "G0 X0 Y0",
      "G0 Z2",
      `G0 X${f3(x0)} Y${f3(y0)}`,
      `G0 X${f3(x1)} Y${f3(y0)}`,
      `G0 X${f3(x1)} Y${f3(y1)}`,
      `G0 X${f3(x0)} Y${f3(y1)}`,
      `G0 X${f3(x0)} Y${f3(y0)}`,
      "G0 Z5",
      "G0 X0 Y0",
      "M30",
    ];
    jobs.push({
      fileName: "0_dry_run_no_cutting.nc",
      title: "Dry run — spindle off, traces the area 2 mm above the board",
      kind: "dry_run",
      gcode: L.join("\n") + "\n",
      estMinutes: 1,
      lines: L.length,
    });
  }

  const bitLabel =
    bit.type === "vee"
      ? `${bit.halfAngleDeg * 2} deg V-bit ${bit.tipDiameterMm}mm tip`
      : `${bit.type} ${bit.diameterMm}mm`;

  // Roughing, layer by layer, region by region.
  const roughPx = Math.max(1, Math.round(P.roughStepMm / R));
  for (let p = 0; p < P.regions; p++) {
    progress(0.25 + (0.35 * p) / P.regions, `Planning roughing (${regionNames[p]})`);
    const g = new GcodeWriter(
      [
        `Step ${p + 1} - ROUGHING ${p + 1} of ${P.regions} - ${regionNames[p]} - removes wood in ${P.roughLayerMm}mm layers`,
        `CNCarve relief engine - ${bitLabel}`,
      ],
      P,
    );
    const rows = rowsFor(p, roughPx);
    let lo = 0;
    for (let j = cuts[p]; j < cuts[p + 1]; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (work[k] && Zr[k] < lo) lo = Zr[k];
      }
    const cur = new Float32Array(n);
    let level = 0;
    const Zl = new Float32Array(n);
    while (level > lo + 1e-6) {
      level = Math.max(level - P.roughLayerMm, lo);
      for (let k = 0; k < n; k++) Zl[k] = Math.max(Zr[k], level);
      raster(g, Zl, rows, P.feedRough, cur);
      for (let k = 0; k < n; k++) if (work[k] && Zl[k] < cur[k]) cur[k] = Zl[k];
    }
    const r = g.finish();
    jobs.push({
      fileName: `${p + 1}_roughing_${regionNames[p].replace(/\s+/g, "_")}.nc`,
      title: `Roughing ${p + 1} of ${P.regions} — ${regionNames[p]}`,
      kind: "rough",
      ...r,
    });
  }

  // Detail passes.
  const finishPx = Math.max(1, Math.round(P.finishStepMm / R));
  for (let p = 0; p < P.regions; p++) {
    progress(0.6 + (0.2 * p) / P.regions, `Planning detail passes (${regionNames[p]})`);
    const g = new GcodeWriter(
      [
        `Step ${P.regions + p + 1} - DETAIL ${p + 1} of ${P.regions} - ${regionNames[p]}`,
        `CNCarve relief engine - ${bitLabel}`,
      ],
      P,
    );
    raster(g, Zf, rowsFor(p, finishPx), P.feedFinish, null);
    const r = g.finish();
    jobs.push({
      fileName: `${P.regions + p + 1}_detail_${regionNames[p].replace(/\s+/g, "_")}.nc`,
      title: `Detail ${p + 1} of ${P.regions} — ${regionNames[p]}`,
      kind: "finish",
      ...r,
    });
  }

  // Simulate the detail passes: sweep the bit along every finishing row.
  progress(0.82, "Simulating the carve");
  // Tip height wherever the bit actually travels (finishing rows inside the work area).
  const tip = new Float32Array(n).fill(1e6);
  for (let p = 0; p < P.regions; p++)
    for (const j of rowsFor(p, finishPx))
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (work[k] && Zf[k] < 0) tip[k] = Zf[k];
      }
  // carved(x) = min over nearby tip positions of (tip + bit profile). Sorted offsets let each
  // pixel stop once even the lowest tip in reach could not cut deeper.
  const kWin = offsets.reduce((a, o) => Math.max(a, Math.abs(o.dx), Math.abs(o.dy)), 0);
  const localMin = squareFilter(tip, W, H, kWin, false);
  const carved = new Float32Array(n).fill(0);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      if (!work[idx]) continue;
      const floorHere = localMin[idx];
      let best = 0;
      for (const o of offsets) {
        if (floorHere + o.p >= best) break;
        const si = i + o.dx,
          sj = j + o.dy;
        if (si < 0 || sj < 0 || si >= W || sj >= H) continue;
        const v = tip[sj * W + si] + o.p;
        if (v < best) best = v;
      }
      carved[idx] = best;
    }
  }
  let maxGouge = 0,
    good = 0,
    total = 0;
  for (let k = 0; k < n; k++) {
    if (!hm.mask[k]) continue;
    total++;
    const d = T[k] - carved[k];
    if (d > maxGouge) maxGouge = d;
    if (Math.abs(carved[k] - T[k]) <= 0.15) good++;
  }

  // Self-check every file the way GRBL will read it.
  progress(0.95, "Checking every line for GRBL");
  for (const job of jobs) problems.push(...validateGrblGcode(job.gcode, job.fileName, P.clearZ));
  if (maxGouge > 0.1)
    problems.push(`Simulation shows the bit cutting ${maxGouge.toFixed(2)} mm into the design.`);

  const target = new Float32Array(n);
  for (let k = 0; k < n; k++) target[k] = work[k] ? T[k] : 0;

  progress(1, "Done");
  return {
    jobs,
    preview: { width: W, height: H, target, carved, work, res: R },
    summary: {
      designWidthMm: (mi1 - mi0) * R,
      designDepthMm: (mj1 - mj0) * R,
      reliefDepthMm: reliefDepth,
      cutDepthMm: -lowest,
      workMinX: X(wi0),
      workMaxX: X(wi1),
      workMinY: Y(wj0),
      workMaxY: Y(wj1),
      totalMinutes: jobs.reduce((a, j) => a + j.estMinutes, 0),
      maxGougeMm: maxGouge,
      accuracyPct: total ? (100 * good) / total : 0,
      problems,
    },
  };
}

const GRBL_OK = new Set(["G0", "G1", "G4", "G17", "G21", "G90", "G94", "M3", "M5", "M30"]);

/**
 * Check a file the way stock GRBL 1.1 will read it: only supported commands, comments that
 * close properly (GRBL ends a comment at the first ")"), short lines, and no fast sideways
 * moves while the bit is below `clearZ`.
 */
export function validateGrblGcode(gcode: string, label: string, clearZ = 1): string[] {
  const out: string[] = [];
  let z: number | null = null;
  let motion = -1;
  const lines = gcode.split("\n");
  for (let ln = 0; ln < lines.length && out.length < 10; ln++) {
    const raw = lines[ln].trim();
    if (!raw) continue;
    if (raw.length > 70 && !raw.startsWith("(")) out.push(`${label}:${ln + 1} line too long`);
    const code = raw.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
    if (!code) continue;
    if (!/^([A-Z][-+]?\d*\.?\d+)+$/.test(code)) {
      out.push(`${label}:${ln + 1} GRBL cannot read: ${raw}`);
      continue;
    }
    const words = code.match(/[A-Z][-+]?\d*\.?\d+/g) ?? [];
    let hasXY = false;
    let newZ: number | null = null;
    for (const w of words) {
      const letter = w[0],
        num = Number(w.slice(1));
      if ((letter === "G" || letter === "M") && !GRBL_OK.has(`${letter}${Math.trunc(num)}`))
        out.push(`${label}:${ln + 1} unsupported command ${w}`);
      if (letter === "G" && (num === 0 || num === 1)) motion = num;
      if (letter === "X" || letter === "Y") hasXY = true;
      if (letter === "Z") newZ = num;
    }
    if (motion === 0 && hasXY) {
      const zz = Math.min(newZ ?? z ?? 99, z ?? 99);
      if (zz < clearZ - 1e-3) out.push(`${label}:${ln + 1} fast sideways move with the bit low`);
    }
    if (newZ !== null) z = newZ;
  }
  return out;
}
