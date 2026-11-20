/**
 * CNCarve relief engine: one bit, layered roughing + detail pass, as ONE continuous program.
 *
 * Why this exists: Kiri's single-bit relief path makes one contour pass at full depth. With a
 * narrow V-bit in hardwood that buries the cone 3–5 mm deep at once, which stalls the 3018,
 * skips steps and snaps tips. Here the bit removes wood in shallow layers first and then
 * follows the surface, and every toolpath accounts for the bit's real shape so the side of the
 * cone never cuts into neighbouring detail.
 *
 * Coordinates: X0 Y0 = centre of the board (the design is centred on it), Z0 = top of the board.
 *
 * Recovery: every cutting segment starts the same way — rapid over at a safe height, rapid down
 * to just above the wood, then plunge. Those are "restart points". After any stop the carve can
 * restart at the beginning of a segment with nothing but "spindle on"; re-cut moves only cut air.
 */

import { dilate4, rasterizeRelief, type HeightMap } from "./heightmap";

export type BitShape =
  | { type: "vee"; halfAngleDeg: number; tipDiameterMm: number; diameterMm: number }
  | { type: "ball"; diameterMm: number }
  | { type: "flat"; diameterMm: number };

export type ReliefCamParams = {
  /** Detail pass spacing (mm) */
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
  /** Grid resolution (mm per pixel). */
  resMm: number;
  /** How the wood between roughing rows is handled before the detail pass (default "asBefore"). */
  finish?: FinishMode;
};

/**
 * - asBefore: exactly the program this engine made before the fin clean-up (no clean-up, the bit
 *   lifts above the board between cuts). Kept so carvings can always go back to it.
 * - quick: no clean-up (fins stay for the detail pass), with the short, checked moves.
 * - standard: two clean-up rows between each pair of roughing rows (fins about 0.35 mm), and
 *   short, checked moves between cuts.
 * - smoothest: clean-up rows all the way across at the detail spacing, leaving an even skin.
 */
export type FinishMode = "asBefore" | "quick" | "standard" | "smoothest";

/**
 * Detail rows are this many grid pixels apart. "asBefore" rounds (so some sizes ended up with
 * rows ~0.13 mm apart, leaving small ridges with a 0.1 mm tip); the new modes are never wider
 * apart than the detail step.
 */
export function finishRowPx(finish: FinishMode, finishStepMm: number, res: number): number {
  const r = finishStepMm / res;
  return Math.max(1, finish === "asBefore" ? Math.round(r) : Math.floor(r + 1e-6));
}

/** Clean-up rows between two roughing rows, in grid pixels from the lower one (ascending). */
export function cleanupOffsets(finish: FinishMode, roughPx: number, finishPx: number): number[] {
  const offs: number[] = [];
  if (finish === "asBefore" || finish === "quick" || roughPx < 3) return offs;
  if (finish === "smoothest") for (let o = finishPx; o < roughPx; o += finishPx) offs.push(o);
  else
    for (const o of [Math.round(roughPx / 3), Math.round((2 * roughPx) / 3)])
      if (o > 0 && o < roughPx && !offs.includes(o)) offs.push(o);
  return offs;
}

/** A labelled stretch of the program, by index into the GRBL lines (comments removed). */
export type CarveSection = { label: string; start: number };

export type CarveProgram = {
  /** The whole carve, start to finish. */
  gcode: string;
  /** Number of lines GRBL will receive (comments removed). */
  lineCount: number;
  /** Line indices (comments removed) where a segment starts at a safe height. Ascending. */
  restartPoints: number[];
  sections: CarveSection[];
  /** Spindle-off trace of the carving area, 2 mm above the board. */
  traceGcode: string;
  estMinutes: number;
  /** Rough share of the time spent in each section (same order as `sections`). */
  sectionMinutes: number[];
};

export type ReliefPreview = {
  width: number;
  height: number;
  /** Target surface and simulated carved surface, machine Z (mm), row 0 = front of board. */
  target: Float32Array;
  carved: Float32Array;
  /** 1 = inside the area that gets machined */
  work: Uint8Array;
  /** The wood the detail pass meets (after roughing and clean-up), machine Z (mm). */
  beforeDetail: Float32Array;
  res: number;
};

export type ReliefResult = {
  program: CarveProgram;
  preview: ReliefPreview;
  summary: {
    designWidthMm: number;
    designDepthMm: number;
    reliefDepthMm: number;
    cutDepthMm: number;
    /** Machined area including the saw groove (mm, relative to board centre). */
    workMinX: number;
    workMaxX: number;
    workMinY: number;
    workMaxY: number;
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
  board: { widthMm: number; depthMm: number; thicknessMm: number };
  /** Label written into the file header */
  name?: string;
  onProgress?: (fraction: number, label: string) => void;
};

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
/** Feed for sideways moves below the clearance height (mm/min; GRBL caps it at $110/$111). */
const TRAVEL_FEED = 1000;
/** How far above the highest wood in reach the bit travels. */
const TRAVEL_MARGIN = 0.5;

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

/** Builds one program and keeps track of GRBL line numbers (comments don't count). */
class ProgramWriter {
  lines: string[] = [];
  codeLines = 0;
  cutMin = 0;
  rapidMm = 0;
  pos: [number, number, number];
  restartPoints: number[] = [];
  sections: CarveSection[] = [];
  sectionStartMin: number[] = [];
  private feed: number | null = null;
  constructor(private P: ReliefCamParams) {
    this.pos = [0, 0, P.safeZ];
  }
  comment(text: string) {
    this.lines.push(`(${text.replace(/[()]/g, "-")})`);
  }
  code(line: string) {
    this.lines.push(line);
    this.codeLines++;
  }
  section(label: string) {
    this.comment(`SECTION ${label}`);
    this.sections.push({ label, start: this.codeLines });
    this.sectionStartMin.push(this.minutes());
  }
  /** Mark the next code line as a safe place to restart after a stop. */
  restartHere() {
    this.restartPoints.push(this.codeLines);
  }
  g0(x?: number, y?: number, z?: number) {
    const n: [number, number, number] = [x ?? this.pos[0], y ?? this.pos[1], z ?? this.pos[2]];
    this.rapidMm += Math.hypot(n[0] - this.pos[0], n[1] - this.pos[1], n[2] - this.pos[2]);
    this.pos = n;
    this.code(
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
    this.code(`G1 X${f3(x)} Y${f3(y)} Z${f3(z)}` + (f !== this.feed ? ` F${f}` : ""));
    this.feed = f;
  }
  /**
   * Sideways move at rapid speed while the bit is below the clearance height (only where it
   * stays clear of the wood). Written as G1 so a "fast sideways move with the bit low" can only
   * ever come from a move that was checked.
   */
  travel(x: number, y: number) {
    this.rapidMm += Math.hypot(x - this.pos[0], y - this.pos[1]);
    this.pos = [x, y, this.pos[2]];
    this.code(`G1 X${f3(x)} Y${f3(y)} F${TRAVEL_FEED}`);
    this.feed = TRAVEL_FEED;
  }
  plunge(z: number) {
    this.cutMin += Math.abs(this.pos[2] - z) / this.P.feedPlunge;
    this.pos = [this.pos[0], this.pos[1], z];
    // Always state the feed: after a restart the controller may not remember it.
    this.code(`G1 Z${f3(z)} F${this.P.feedPlunge}`);
    this.feed = this.P.feedPlunge;
  }
  /** Feed must be restated on the first cut after a restart point. */
  forgetFeed() {
    this.feed = null;
  }
  /** Minutes so far, +25% for acceleration on a small hobby machine. */
  minutes() {
    return (this.cutMin + this.rapidMm / 1500) * 1.25;
  }
}

export function generateCarve(input: ReliefInput): ReliefResult {
  const { bit, params: P, board } = input;
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

  // Bounding boxes of the design and of everything machined.
  let mi0 = W, mi1 = 0, mj0 = H, mj1 = 0;
  let wi0 = W, wi1 = 0, wj0 = H, wj1 = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (hm.mask[k]) {
        if (i < mi0) mi0 = i;
        if (i > mi1) mi1 = i;
        if (j < mj0) mj0 = j;
        if (j > mj1) mj1 = j;
      }
      if (work[k]) {
        if (i < wi0) wi0 = i;
        if (i > wi1) wi1 = i;
        if (j < wj0) wj0 = j;
        if (j > wj1) wj1 = j;
      }
    }
  // Centre the machined area (design + groove) on the board centre = X0 Y0.
  const cxPx = (wi0 + wi1) / 2,
    cyPx = (wj0 + wj1) / 2;
  const X = (i: number) => (i - cxPx) * R;
  const Y = (j: number) => (j - cyPx) * R;

  // ---- where the wood is, for short, safe moves between cuts ----
  /** Beyond this many pixels the bit's cone is higher than any wood can be. */
  /**
   * The bit's footprint for safe moves: like `offsets`, plus a ring one pixel wide around the
   * edge. Wood between grid points just inside the edge would otherwise be missed, and at the
   * edge of a deep cut that is the straight shank, where a tiny miss sideways is a big miss in
   * height. Each ring pixel stands for wood up to half a pixel diagonal nearer the bit's axis.
   */
  const ring = R * Math.SQRT1_2;
  const reach = offsets.reduce((a, o) => Math.max(a, Math.hypot(o.dx, o.dy) * R), 0);
  const safeOffsets: { dx: number; dy: number; p: number }[] = [];
  {
    const kk = Math.ceil((reach + ring) / R);
    for (let dy = -kk; dy <= kk; dy++)
      for (let dx = -kk; dx <= kk; dx++) {
        const r = Math.hypot(dx, dy) * R;
        if (r > reach + ring + 1e-9) continue;
        const p = r > reach - ring ? bitProfile(bit, Math.max(0, Math.min(reach, r) - ring)) : bitProfile(bit, r);
        if (Number.isFinite(p)) safeOffsets.push({ dx, dy, p });
      }
    safeOffsets.sort((a, b) => a.p - b.p);
  }
  const kTravel = safeOffsets.reduce((a, o) => Math.max(a, Math.abs(o.dx), Math.abs(o.dy)), 0);
  /**
   * Highest the wood can be over each pixel (inside the carving or around it) when only `rows`
   * have been cut, each to `cur`: the lowest cone of any cut point on the nearest cut row on
   * either side, never above the board. A safe upper bound (cuts further away only lower it).
   */
  const coneTabs = new Map<number, Float32Array>(); // rows away -> cone height by columns away
  const coneTab = (dRows: number) => {
    let t = coneTabs.get(dRows);
    if (!t) {
      t = new Float32Array(kTravel + 1);
      for (let di = 0; di <= kTravel; di++) {
        // Near the edge of the bit's reach, the wood next to this pixel may be out of reach.
        const d = Math.hypot(di, dRows) * R;
        t[di] = d > reach - ring ? Infinity : bitProfile(bit, d);
      }
      coneTabs.set(dRows, t);
    }
    return t;
  };
  const woodAbove = (rows: number[]) => {
    const out = new Float32Array(n);
    const sorted = [...new Set(rows)].sort((a, b) => a - b);
    let p = 0;
    for (let j = 0; j < H; j++) {
      while (p < sorted.length && sorted[p] < j) p++;
      const near = [p > 0 ? sorted[p - 1] : -1, p < sorted.length ? sorted[p] : -1].filter((r) => r >= 0);
      const tabs = near.map((r) => coneTab(Math.abs(j - r)));
      for (let i = 0; i < W; i++) {
        let top = 0;
        near.forEach((r, q) => {
          const tab = tabs[q];
          if (tab[0] === Infinity) return; // too far away to have cut anything here
          const base = r * W;
          for (let di = -kTravel; di <= kTravel; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= W || !work[base + ii]) continue;
            const v = cur[base + ii] + tab[di < 0 ? -di : di];
            if (v < top) top = v;
          }
        });
        // 0.03 mm slack for the straight-line moves between planned points.
        out[j * W + i] = Math.min(0, top + 0.03);
      }
    }
    return out;
  };
  /**
   * Lowest the tip can be at pixel (i, j) without any part of the bit touching `wood`. `cap` is
   * a max-filtered copy of `wood` (an upper bound in reach), so the search can stop early.
   */
  const coneClear = (wood: Float32Array, cap: Float32Array, i: number, j: number) => {
    const top = cap[j * W + i];
    let best = -1e9;
    for (const o of safeOffsets) {
      if (top - o.p <= best) break;
      const si = i + o.dx, sj = j + o.dy;
      if (si < 0 || sj < 0 || si >= W || sj >= H) continue;
      const v = wood[sj * W + si] - o.p;
      if (v > best) best = v;
    }
    return best;
  };
  /** Lowest safe tip height over each pixel: the highest wood anywhere the bit could touch. */
  const safeOver = (woodTop: Float32Array) => squareFilter(woodTop, W, H, kTravel, true);
  /** Highest value of `map` along a straight move (mm). Outside the grid: the board top. */
  const pathMax = (map: Float32Array, x0: number, y0: number, x1: number, y1: number) => {
    const i0 = x0 / R + cxPx, j0 = y0 / R + cyPx, i1 = x1 / R + cxPx, j1 = y1 / R + cyPx;
    const steps = Math.ceil(Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0)) * 2) + 1;
    let hi = -1e9;
    for (let q = 0; q <= steps; q++) {
      const f = q / steps;
      const i = Math.round(i0 + (i1 - i0) * f), j = Math.round(j0 + (j1 - j0) * f);
      const v = i < 0 || j < 0 || i >= W || j >= H ? 0 : map[j * W + i];
      if (v > hi) hi = v;
    }
    return hi;
  };

  const areaW = (wi1 - wi0) * R,
    areaD = (wj1 - wj0) * R;
  if (areaW > board.widthMm + 0.01 || areaD > board.depthMm + 0.01)
    problems.push(
      `The carving with its saw groove (${areaW.toFixed(1)} × ${areaD.toFixed(1)} mm) is bigger than the board (${board.widthMm.toFixed(1)} × ${board.depthMm.toFixed(1)} mm).`,
    );
  if (-lowest > board.thicknessMm - 1)
    problems.push(
      `The deepest cut is ${(-lowest).toFixed(1)} mm but the board is only ${board.thicknessMm.toFixed(1)} mm thick.`,
    );

  const w = new ProgramWriter(P);
  const bitLabel =
    bit.type === "vee"
      ? `${Math.round(bit.halfAngleDeg * 2)} deg V-bit ${bit.tipDiameterMm}mm tip`
      : `${bit.type} ${bit.diameterMm}mm`;
  w.comment(`CNCarve relief engine - ${input.name ?? "carving"} - ${bitLabel}`);
  w.comment("Zero - X0 Y0 is the centre of the board, Z0 is the top of the board");
  w.code("G21 G90 G17 G94");
  w.g0(undefined, undefined, P.safeZ);
  w.code(`M3 S${P.spindleS}`);
  w.code("G4 P4");

  /** Cut one set of rows; `surfaceTop` = Z of wood still above each pixel (null = board top). */
  /**
   * `surfaceTop` decides where there is wood to cut (unchanged behaviour). Options:
   *  - dropTop: highest the wood can be at a segment start; the fast drop stops `dropMargin`
   *    (default 0.3 mm) above it (default: surfaceTop, or the board top).
   *  - dropWood (with safe): highest the wood can be anywhere; the drop then also clears the
   *    bit's whole cone over the wood beside the start, not just the wood under the tip.
   *  - safe: lowest safe height for the bit's tip over each pixel. With it, the bit no longer
   *    lifts above the board between segments; it lifts only to 0.5 mm above the wood in reach
   *    along the way (never higher than the clearance height).
   */
  const raster = (
    Z: Float32Array,
    rows: number[],
    feed: number,
    surfaceTop: Float32Array | null,
    opts: {
      dropTop?: Float32Array;
      safe?: Float32Array;
      dropMargin?: number;
      dropWood?: Float32Array;
      bridgeMm?: number;
    } = {},
  ) => {
    // Segments to cut, in order: back and forth, row by row. Each is a row and its pixels in
    // cutting direction.
    const rowSegs = (j: number) => {
      const segs: number[][] = [];
      let cur: number[] | null = null;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const top0 = surfaceTop ? surfaceTop[k] : 0;
        if (work[k] === 1 && Z[k] < top0 - 1e-3) {
          if (!cur) {
            cur = [];
            segs.push(cur);
          }
          cur.push(i);
        } else cur = null;
      }
      if (!opts.bridgeMm || segs.length < 2) return segs;
      // Join two cuts on the same row across a short gap instead of lifting over it: the gap is
      // inside the carving and already cut to (or below) this pass's depth there, so following
      // it at that depth removes nothing and never goes below the allowed surface. Only across
      // nearly level gaps: within 0.1 mm of a straight line between the two cuts and never more
      // than 0.05 mm from one pixel to the next, so the straight moves between pixels can't clip
      // a corner the separate cuts wouldn't have.
      const maxGap = Math.round(opts.bridgeMm / R);
      const out: number[][] = [segs[0]];
      for (let q = 1; q < segs.length; q++) {
        const a = out[out.length - 1], b = segs[q];
        const i0 = a[a.length - 1] + 1, i1 = b[0] - 1;
        let ok = i1 - i0 + 1 <= maxGap;
        const za = Z[j * W + a[a.length - 1]], zb = Z[j * W + b[0]];
        let prev = za;
        for (let i = i0; ok && i <= i1 + 1; i++) {
          const k = j * W + i;
          const line = za + ((zb - za) * (i - i0 + 1)) / (i1 - i0 + 2);
          if ((i <= i1 && !work[k]) || Math.abs(Z[k] - line) > 0.1 || Math.abs(Z[k] - prev) > 0.05) ok = false;
          prev = Z[k];
        }
        if (ok) for (let i = i0; i <= b[b.length - 1]; i++) a.push(i);
        else out.push(b);
      }
      return out;
    };
    const order: { j: number; s: number[] }[] = [];
    let flip = false;
    for (const j of rows) {
      const segs = rowSegs(j);
      if (!segs.length) continue;
      if (flip) {
        segs.reverse();
        for (const sg of segs) sg.reverse();
      }
      flip = !flip;
      for (const sg of segs) order.push({ j, s: sg });
    }
    for (const { j, s } of order) {
      const pts = compress(s.map((i) => [X(i), Y(j), Z[j * W + i]] as [number, number, number]));
      let travelZ = P.clearZ;
      if (opts.safe) {
        const hi = pathMax(opts.safe, w.pos[0], w.pos[1], pts[0][0], pts[0][1]) + TRAVEL_MARGIN;
        // Near the board top, use the normal clearance height.
        if (hi < 0) travelZ = hi;
      }
      if (w.pos[2] < travelZ) w.g0(undefined, undefined, travelZ);
      // Restart point: from here the segment needs nothing but a spinning bit.
      w.restartHere();
      w.forgetFeed();
      if (w.pos[2] >= P.clearZ - 1e-6) w.g0(pts[0][0], pts[0][1]);
      else w.travel(pts[0][0], pts[0][1]);
      const dropTop = opts.dropTop ?? surfaceTop;
      let startTop = dropTop ? dropTop[j * W + s[0]] : 0;
      if (opts.dropWood && opts.safe) startTop = Math.max(startTop, coneClear(opts.dropWood, opts.safe, s[0], j));
      const dropZ = Math.min(P.clearZ, startTop + (opts.dropMargin ?? 0.3));
      if (dropZ < w.pos[2]) w.g0(undefined, undefined, dropZ);
      w.plunge(pts[0][2]);
      for (let a = 1; a < pts.length; a++) w.g1(pts[a][0], pts[a][1], pts[a][2], feed);
      if (!opts.safe) w.g0(undefined, undefined, P.clearZ);
    }
  };

  const finish: FinishMode = P.finish ?? "asBefore";
  const asBefore = finish === "asBefore";
  const finishPx = finishRowPx(finish, P.finishStepMm, R);

  // Roughing: layer by layer over the whole piece.
  const roughPx = Math.max(1, Math.round(P.roughStepMm / R));
  const roughRows: number[] = [];
  for (let j = Math.ceil(wj0 / roughPx) * roughPx; j <= wj1; j += roughPx) roughRows.push(j);
  let lo = 0;
  for (let k = 0; k < n; k++) if (work[k] && Zr[k] < lo) lo = Zr[k];
  const layers: number[] = [];
  for (let level = 0; level > lo + 1e-6; ) {
    level = Math.max(level - P.roughLayerMm, lo);
    layers.push(level);
  }
  const cur = new Float32Array(n);
  const Zl = new Float32Array(n);
  layers.forEach((level, li) => {
    progress(0.25 + (0.35 * li) / layers.length, `Planning roughing layer ${li + 1} of ${layers.length}`);
    w.section(`Roughing - layer ${li + 1} of ${layers.length}`);
    for (let k = 0; k < n; k++) Zl[k] = Math.max(Zr[k], level);
    if (asBefore) raster(Zl, roughRows, P.feedRough, cur);
    else {
      const wood = woodAbove(li > 0 ? roughRows : []);
      raster(Zl, roughRows, P.feedRough, cur, { safe: safeOver(wood), dropWood: wood, bridgeMm: 5 });
    }
    for (let k = 0; k < n; k++) if (work[k] && Zl[k] < cur[k]) cur[k] = Zl[k];
  });

  // Fin clean-up (V-bits). Every roughing layer cuts its grooves on the same rows, so a thin fin
  // of wood is left standing between each pair of grooves, up to ~1.3 mm above the finished
  // surface instead of the planned skin. The detail pass then has to shave each fin away from one
  // side; in hardwood the last sliver bends or tears instead of cutting, and the bit takes bites
  // several times bigger than planned. That leaves lines along the rows. Clean-up rows at the
  // roughing depth between the roughing rows cut the fins down first: two rows (standard) leave
  // fins about a quarter as tall; rows all the way across (smoothest) leave an even skin.
  const cutRows = [...roughRows];
  if (!asBefore && bit.type === "vee" && roughPx >= 3) {
    const t = Math.tan((bit.halfAngleDeg * Math.PI) / 180);
    const offs = cleanupOffsets(finish, roughPx, finishPx);
    const cleanRows: { j: number; below: number; above: number }[] = [];
    for (const j0 of roughRows)
      offs.forEach((o, idx) => {
        const j = j0 + o;
        // Nearest rows already cut when this one runs: the clean-up row before it (or the
        // roughing row) below, and the next roughing row above.
        if (j <= wj1) cleanRows.push({ j, below: idx === 0 ? o : o - offs[idx - 1], above: roughPx - o });
      });
    // Where the wood really is on each clean-up row: the top of the fin, set by the bit's cone on
    // the rows either side (never above the board). -1e9 = nothing to cut there.
    const coneAt = (j: number, i: number, dPx: number) => {
      if (j < 0 || j >= H) return 0;
      const k = j * W + i;
      return work[k] ? cur[k] + Math.max(0, dPx * R - bit.tipDiameterMm / 2) / t : 0;
    };
    const woodTop = new Float32Array(n).fill(-1e9);
    for (const { j, below, above } of cleanRows)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!work[k]) continue;
        const top = Math.min(0, coneAt(j - below, i, below), coneAt(j + above, i, above));
        if (top > Zr[k] + 0.02) woodTop[k] = top;
      }
    progress(0.6, "Planning the fin clean-up");
    w.section("Roughing - fin clean-up");
    const roughWood = woodAbove(roughRows);
    raster(Zr, cleanRows.map((r) => r.j), P.feedRough, woodTop, {
      safe: safeOver(roughWood),
      dropWood: roughWood,
      dropMargin: 0.5,
      bridgeMm: 3,
    });
    for (const r of cleanRows) cutRows.push(r.j);
  }
  // Before the detail pass: the wood left by roughing and clean-up, for short drops and moves.
  const detailWood = asBefore ? new Float32Array(0) : woodAbove(cutRows);
  const detailSafe = asBefore ? detailWood : safeOver(detailWood);

  // Detail pass, in three parts so progress reads naturally.
  progress(0.62, "Planning the detail pass");
  const finishRows: number[] = [];
  for (let j = Math.ceil(wj0 / finishPx) * finishPx; j <= wj1; j += finishPx) finishRows.push(j);
  const parts = 3;
  for (let p = 0; p < parts; p++) {
    w.section(`Detail pass - part ${p + 1} of ${parts}`);
    const a = Math.floor((finishRows.length * p) / parts),
      b = Math.floor((finishRows.length * (p + 1)) / parts);
    raster(
      Zf,
      finishRows.slice(a, b),
      P.feedFinish,
      null,
      asBefore ? {} : { dropTop: detailWood, safe: detailSafe, dropWood: detailWood, dropMargin: 0.5 },
    );
  }
  w.g0(undefined, undefined, P.safeZ);
  w.code("M5");
  w.code("G0 X0 Y0");
  w.code("M30");
  const totalMin = w.minutes();
  const sectionMinutes = w.sectionStartMin.map((s, i) => (w.sectionStartMin[i + 1] ?? totalMin) - s);

  // Spindle-off trace, rapid moves only (the machine panel blocks feed moves without a spindle).
  const x0 = X(wi0), x1 = X(wi1), y0 = Y(wj0), y1 = Y(wj1);
  const traceGcode =
    [
      "(Trace - spindle OFF - follows the edge of the carving area 2mm above the board)",
      "G21 G90 G17 G94",
      "M5",
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
    ].join("\n") + "\n";

  // Simulate the detail pass: sweep the bit along every finishing row.
  progress(0.82, "Simulating the carve");
  const tip = new Float32Array(n).fill(1e6);
  for (const j of finishRows)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (work[k] && Zf[k] < 0) tip[k] = Zf[k];
    }
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
  let maxGouge = 0, good = 0, total = 0;
  for (let k = 0; k < n; k++) {
    if (!hm.mask[k]) continue;
    total++;
    const d = T[k] - carved[k];
    if (d > maxGouge) maxGouge = d;
    if (Math.abs(carved[k] - T[k]) <= 0.15) good++;
  }

  progress(0.95, "Checking every line for GRBL");
  const gcode = w.lines.join("\n") + "\n";
  problems.push(...validateGrblGcode(gcode, "carve", P.clearZ));
  problems.push(...validateGrblGcode(traceGcode, "trace", 1.5));
  if (maxGouge > 0.1)
    problems.push(`Simulation shows the bit cutting ${maxGouge.toFixed(2)} mm into the design.`);

  // For the picture of what the detail bit meets (doesn't change the program).
  const beforeDetail = asBefore ? woodAbove(roughRows) : detailWood;
  for (let k = 0; k < n; k++) if (!work[k]) beforeDetail[k] = 0;

  const target = new Float32Array(n);
  for (let k = 0; k < n; k++) target[k] = work[k] ? T[k] : 0;

  progress(1, "Done");
  return {
    program: {
      gcode,
      lineCount: w.codeLines,
      restartPoints: w.restartPoints,
      sections: w.sections,
      traceGcode,
      estMinutes: totalMin,
      sectionMinutes,
    },
    preview: { width: W, height: H, target, carved, work, res: R, beforeDetail },
    summary: {
      designWidthMm: (mi1 - mi0) * R,
      designDepthMm: (mj1 - mj0) * R,
      reliefDepthMm: reliefDepth,
      cutDepthMm: -lowest,
      workMinX: x0,
      workMaxX: x1,
      workMinY: y0,
      workMaxY: y1,
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
