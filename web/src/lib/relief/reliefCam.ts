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
};

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
  const raster = (Z: Float32Array, rows: number[], feed: number, surfaceTop: Float32Array | null) => {
    let flip = false;
    for (const j of rows) {
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
      if (!segs.length) continue;
      if (flip) {
        segs.reverse();
        for (const s of segs) s.reverse();
      }
      flip = !flip;
      for (const s of segs) {
        const pts = compress(s.map((i) => [X(i), Y(j), Z[j * W + i]] as [number, number, number]));
        if (w.pos[2] < P.clearZ) w.g0(undefined, undefined, P.clearZ);
        // Restart point: from here the segment needs nothing but a spinning bit.
        w.restartHere();
        w.forgetFeed();
        w.g0(pts[0][0], pts[0][1]);
        const startTop = surfaceTop ? surfaceTop[j * W + s[0]] : 0;
        w.g0(undefined, undefined, Math.min(P.clearZ, startTop + 0.3));
        w.plunge(pts[0][2]);
        for (let a = 1; a < pts.length; a++) w.g1(pts[a][0], pts[a][1], pts[a][2], feed);
        w.g0(undefined, undefined, P.clearZ);
      }
    }
  };

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
    raster(Zl, roughRows, P.feedRough, cur);
    for (let k = 0; k < n; k++) if (work[k] && Zl[k] < cur[k]) cur[k] = Zl[k];
  });

  // Detail pass, in three parts so progress reads naturally.
  progress(0.62, "Planning the detail pass");
  const finishPx = Math.max(1, Math.round(P.finishStepMm / R));
  const finishRows: number[] = [];
  for (let j = Math.ceil(wj0 / finishPx) * finishPx; j <= wj1; j += finishPx) finishRows.push(j);
  const parts = 3;
  for (let p = 0; p < parts; p++) {
    w.section(`Detail pass - part ${p + 1} of ${parts}`);
    const a = Math.floor((finishRows.length * p) / parts),
      b = Math.floor((finishRows.length * (p + 1)) / parts);
    raster(Zf, finishRows.slice(a, b), P.feedFinish, null);
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
    preview: { width: W, height: H, target, carved, work, res: R },
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
