/// <reference lib="webworker" />
/**
 * Live carving view. Runs entirely in this worker so it can never slow down the USB stream:
 * the page only tells it "the machine has got to line N" a few times a second.
 *
 * It keeps a height map of the board, cuts it with the real bit shape along every feed move
 * up to that line, and repaints only the part that changed into an OffscreenCanvas.
 */
import { bitProfile, type BitShape } from "./reliefCam";

export type LiveInit = {
  type: "init";
  canvas: OffscreenCanvas;
  gcode: string;
  bit: BitShape;
  area: { minX: number; maxX: number; minY: number; maxY: number };
  /** Longest side of the picture in pixels. */
  maxPx: number;
  /** Line already reached (for a carve that is continuing). */
  startLine: number;
};
export type LiveMsg = LiveInit | { type: "line"; line: number };
export type LiveOut =
  | { type: "layout"; width: number; height: number; minX: number; maxY: number; pxPerMm: number }
  | { type: "ready" };

/** GRBL acknowledges ~16 queued moves ahead of the bit; draw a little behind the acked line. */
const QUEUE_LAG_LINES = 16;

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let W = 0,
  H = 0; // grid size
let res = 0.05; // mm per grid cell
let gx0 = 0,
  gy0 = 0; // grid origin (mm)
let stock: Float32Array;
let seg: Float32Array; // x0,y0,z0,x1,y1,z1 per feed move
let segEndForLine: Int32Array; // number of feed moves that end at or before each line
let done = 0; // feed moves already cut
let offsets: { dx: number; dy: number; p: number }[] = [];
let dispW = 0,
  dispH = 0,
  k = 1; // display px per grid cell
let img: ImageData;
let dirty: [number, number, number, number] | null = null; // grid bbox i0,j0,i1,j1
let renderTimer: number | null = null;

function parse(gcode: string) {
  const segs: number[] = [];
  const ends: number[] = [];
  let x = 0,
    y = 0,
    z = 5,
    motion = 0;
  for (const raw of gcode.split(/\r?\n/)) {
    const noParen = raw.replace(/\([^)]*\)/g, "");
    const semi = noParen.indexOf(";");
    const code = (semi >= 0 ? noParen.slice(0, semi) : noParen).trim();
    if (!code || code === "%") continue;
    let nx = x,
      ny = y,
      nz = z;
    for (const m of code.toUpperCase().matchAll(/([GXYZ])\s*(-?\d*\.?\d+)/g)) {
      const v = Number(m[2]);
      if (m[1] === "G" && (v === 0 || v === 1)) motion = v;
      else if (m[1] === "X") nx = v;
      else if (m[1] === "Y") ny = v;
      else if (m[1] === "Z") nz = v;
    }
    if (motion === 1 && (nx !== x || ny !== y || nz !== z) && Math.min(z, nz) < 0) segs.push(x, y, z, nx, ny, nz);
    x = nx;
    y = ny;
    z = nz;
    ends.push(segs.length / 6);
  }
  seg = Float32Array.from(segs);
  segEndForLine = Int32Array.from(ends);
}

function makeOffsets(bit: BitShape, deepest: number) {
  let rMax = bit.diameterMm / 2;
  if (bit.type === "vee") {
    const t = Math.tan((bit.halfAngleDeg * Math.PI) / 180);
    rMax = Math.min(rMax, bit.tipDiameterMm / 2 + (deepest + 0.5) * t);
  }
  const kk = Math.ceil(rMax / res);
  const out: { dx: number; dy: number; p: number }[] = [];
  for (let dy = -kk; dy <= kk; dy++)
    for (let dx = -kk; dx <= kk; dx++) {
      const r = Math.hypot(dx, dy) * res;
      if (r > rMax + 1e-9) continue;
      const p = bitProfile(bit, r);
      if (Number.isFinite(p)) out.push({ dx, dy, p });
    }
  out.sort((a, b) => a.p - b.p);
  offsets = out;
}

function grow(i0: number, j0: number, i1: number, j1: number) {
  if (!dirty) dirty = [i0, j0, i1, j1];
  else {
    if (i0 < dirty[0]) dirty[0] = i0;
    if (j0 < dirty[1]) dirty[1] = j0;
    if (i1 > dirty[2]) dirty[2] = i1;
    if (j1 > dirty[3]) dirty[3] = j1;
  }
}

/** Cut the stock along feed moves [done, upto). */
function cutTo(upto: number) {
  const kr = offsets.reduce((a, o) => Math.max(a, Math.abs(o.dx), Math.abs(o.dy)), 0);
  for (; done < upto; done++) {
    const o6 = done * 6;
    const x0 = seg[o6],
      y0 = seg[o6 + 1],
      z0 = seg[o6 + 2],
      x1 = seg[o6 + 3],
      y1 = seg[o6 + 4],
      z1 = seg[o6 + 5];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / (res * 0.7)));
    let bi0 = W,
      bj0 = H,
      bi1 = 0,
      bj1 = 0;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const z = z0 + (z1 - z0) * t;
      const ci = Math.round((x0 + (x1 - x0) * t - gx0) / res);
      const cj = Math.round((y0 + (y1 - y0) * t - gy0) / res);
      for (const { dx, dy, p } of offsets) {
        const v = z + p;
        if (v >= 0) break; // the rest of the bit is above the board
        const i = ci + dx,
          j = cj + dy;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const idx = j * W + i;
        if (v < stock[idx]) stock[idx] = v;
      }
      if (ci < bi0) bi0 = ci;
      if (ci > bi1) bi1 = ci;
      if (cj < bj0) bj0 = cj;
      if (cj > bj1) bj1 = cj;
    }
    grow(bi0 - kr, bj0 - kr, bi1 + kr, bj1 + kr);
  }
}

// Soft light from the upper left, fairly high, so steep walls read as shade rather than black.
const L = [-0.38, 0.46, 0.8];
const LN = Math.hypot(L[0], L[1], L[2]);

/** Height at a fractional grid position (bilinear), clamped to the grid. */
function heightAt(fi: number, fj: number) {
  const i0 = Math.min(W - 1, Math.max(0, Math.floor(fi))),
    j0 = Math.min(H - 1, Math.max(0, Math.floor(fj)));
  const i1 = Math.min(W - 1, i0 + 1),
    j1 = Math.min(H - 1, j0 + 1);
  const tx = Math.min(1, Math.max(0, fi - i0)),
    ty = Math.min(1, Math.max(0, fj - j0));
  const a = stock[j0 * W + i0],
    b = stock[j0 * W + i1],
    c = stock[j1 * W + i0],
    d = stock[j1 * W + i1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Repaint the dirty part of the picture. */
function render() {
  renderTimer = null;
  if (!ctx || !dirty) return;
  const [gi0, gj0, gi1, gj1] = dirty;
  dirty = null;
  // grid → display: x = (i)*k, y = (H-1-j)*k
  const x0 = Math.max(0, Math.floor(gi0 * k) - 2),
    x1 = Math.min(dispW - 1, Math.ceil(gi1 * k) + 2);
  const y0 = Math.max(0, Math.floor((H - 1 - gj1) * k) - 2),
    y1 = Math.min(dispH - 1, Math.ceil((H - 1 - gj0) * k) + 2);
  if (x1 < x0 || y1 < y0) return;
  // Sample spacing in grid cells: one display pixel, never finer than the grid itself.
  const h = Math.max(1, 1 / k);
  const d = img.data;
  for (let y = y0; y <= y1; y++) {
    const fj = H - 1 - (y + 0.5) / k;
    for (let x = x0; x <= x1; x++) {
      const fi = (x + 0.5) / k;
      const z = heightAt(fi, fj);
      const o = (y * dispW + x) * 4;
      if (z >= -1e-3) {
        // untouched board: warm flat wood with a faint grain
        const g = 6 * Math.sin(fj * 0.09 + Math.sin(fi * 0.013) * 3);
        d[o] = 222 + g;
        d[o + 1] = 192 + g;
        d[o + 2] = 146 + g * 0.6;
        continue;
      }
      const dzdx = (heightAt(fi + h, fj) - heightAt(fi - h, fj)) / (2 * h * res);
      const dzdy = (heightAt(fi, fj + h) - heightAt(fi, fj - h)) / (2 * h * res);
      const nl = Math.hypot(dzdx, dzdy, 1);
      const lambert = Math.max(0, (-dzdx * L[0] - dzdy * L[1] + L[2]) / (nl * LN));
      const shade = 0.28 + 0.72 * lambert; // ambient + direct light
      // freshly cut wood is a little lighter than the board; deeper cuts slightly darker
      const depthTint = Math.max(0.8, 1 + z * 0.045);
      const v = 248 * shade * depthTint;
      d[o] = Math.min(255, v);
      d[o + 1] = Math.min(255, v * 0.84);
      d[o + 2] = Math.min(255, v * 0.62);
    }
  }
  ctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function scheduleRender() {
  if (renderTimer === null) renderTimer = setTimeout(render, 100) as unknown as number;
}

function linesToSegs(line: number) {
  const l = Math.min(segEndForLine.length - 1, line - QUEUE_LAG_LINES);
  return l < 0 ? 0 : segEndForLine[l];
}

self.onmessage = (ev: MessageEvent<LiveMsg>) => {
  const m = ev.data;
  if (m.type === "init") {
    parse(m.gcode);
    const pad = 1;
    gx0 = m.area.minX - pad;
    gy0 = m.area.minY - pad;
    const wMm = m.area.maxX - m.area.minX + 2 * pad,
      hMm = m.area.maxY - m.area.minY + 2 * pad;
    // Fine enough to look sharp, small enough to stay quick on a Raspberry Pi.
    res = Math.max(0.02, Math.sqrt((wMm * hMm) / 900_000));
    W = Math.ceil(wMm / res) + 1;
    H = Math.ceil(hMm / res) + 1;
    stock = new Float32Array(W * H);
    let deepest = 0;
    for (let s = 2; s < seg.length; s += 3) if (-seg[s] > deepest) deepest = -seg[s];
    makeOffsets(m.bit, deepest);
    k = Math.min(m.maxPx / W, m.maxPx / H);
    dispW = Math.max(1, Math.round(W * k));
    dispH = Math.max(1, Math.round(H * k));
    m.canvas.width = dispW;
    m.canvas.height = dispH;
    ctx = m.canvas.getContext("2d");
    img = new ImageData(dispW, dispH);
    for (let o = 3; o < img.data.length; o += 4) img.data[o] = 255;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
      type: "layout",
      width: dispW,
      height: dispH,
      minX: gx0,
      maxY: gy0 + (H - 1) * res,
      pxPerMm: k / res,
    } satisfies LiveOut);
    cutTo(linesToSegs(m.startLine));
    dirty = [0, 0, W - 1, H - 1];
    render();
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "ready" } satisfies LiveOut);
  } else if (m.type === "line" && seg) {
    const upto = linesToSegs(m.line);
    if (upto > done) {
      cutTo(upto);
      scheduleRender();
    }
  }
};
