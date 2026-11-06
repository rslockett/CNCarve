/**
 * Picture → relief height map.
 *
 * Two starting points:
 *  - "drawing": brightness becomes height (line art, logos, carved-look clip art);
 *  - "photo": the AI depth map (see depth.worker.ts), plus fine detail taken from the picture.
 *
 * Then the same shaping for both: cut away the background, flatten the overall depth so it reads
 * as a carved relief rather than a deep 3D scene, smooth, and trim to an outline shape.
 * Everything here is plain arithmetic on the user's own picture.
 */

export type ReliefMode = "photo" | "drawing";
/** "cutout" = the object's own outline, found in the picture. */
export type OutlineShape = "cutout" | "rectangle" | "oval" | "arch" | "cross";

export type ReliefParams = {
  mode: ReliefMode;
  /** Drawing mode: which parts stand up. */
  raised: "dark" | "light";
  /** Height from the background to the highest point (mm). */
  depthMm: number;
  /** Solid backing under the relief, so the STL is a proper closed solid (mm). */
  baseMm: number;
  /** 0–1: fine detail from the picture (photo mode) / edge crispness (drawing mode). */
  detail: number;
  /** 0–1: squeeze big depth differences so the relief reads like carving. */
  flatten: number;
  /** 0–1: smooth out noise and grain. */
  smooth: number;
  /** 0–1: everything below this level becomes flat background. */
  background: number;
  shape: OutlineShape;
};

export const DEFAULT_PARAMS: ReliefParams = {
  mode: "photo",
  raised: "dark",
  depthMm: 3,
  baseMm: 1.5,
  detail: 0.15,
  flatten: 0.4,
  smooth: 0.1,
  background: 0.05,
  shape: "cutout",
};

export type Grid = { w: number; h: number };

/** Result: heights (mm, top of the solid) on a vertex grid, and which vertices are inside the outline. */
export type ReliefMap = {
  w: number;
  h: number;
  /** mm between neighbouring grid points */
  res: number;
  /** z (mm) per vertex, row 0 = top of the picture; includes the base */
  z: Float32Array;
  /** 1 = inside the outline */
  mask: Uint8Array;
  /** 0–1 relief level per vertex (no base, no depth scaling) for the preview */
  level: Float32Array;
};

/** Grid size for a carving `heightMm` tall with the picture's aspect ratio. */
export function gridFor(aspect: number, heightMm: number): Grid & { res: number } {
  // Fine enough to be well below what a V-bit can cut, small enough to stay quick on a Pi.
  const maxVerts = 1024;
  const minRes = 0.05;
  const widthMm = heightMm * aspect;
  const res = Math.max(minRes, Math.max(widthMm, heightMm) / (maxVerts - 1));
  return {
    w: Math.max(8, Math.round(widthMm / res) + 1),
    h: Math.max(8, Math.round(heightMm / res) + 1),
    res,
  };
}

/** Bilinear resample of a single-channel image to w × h (corner-aligned). */
export function resample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? (y * (sh - 1)) / (h - 1) : 0;
    const y0 = Math.floor(fy),
      y1 = Math.min(sh - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = w > 1 ? (x * (sw - 1)) / (w - 1) : 0;
      const x0 = Math.floor(fx),
        x1 = Math.min(sw - 1, x0 + 1),
        tx = fx - x0;
      const a = src[y0 * sw + x0],
        b = src[y0 * sw + x1],
        c = src[y1 * sw + x0],
        d = src[y1 * sw + x1];
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Brightness 0–1 from RGBA (transparent pixels count as white paper). */
export function luminance(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const l = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
    out[i] = l * a + (1 - a);
  }
  return out;
}

/** One box-blur pass along rows then columns (radius r, edges clamped). */
function boxPass(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Close to a Gaussian blur with standard deviation `sigma` pixels (three box passes). */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  return boxPass(boxPass(boxPass(src, w, h, r), w, h, r), w, h, r);
}

/** Value at fraction q of the sorted data (sampled, fast). */
function percentile(a: Float32Array, q: number): number {
  const step = Math.max(1, Math.floor(a.length / 20000));
  const s: number[] = [];
  for (let i = 0; i < a.length; i += step) s.push(a[i]);
  s.sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

function normalize01(a: Float32Array, lo: number, hi: number) {
  const span = hi - lo || 1;
  for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (a[i] - lo) / span));
}

/** Is (u, v) — 0..1 across, 0..1 down — inside the outline? */
export function insideShape(shape: OutlineShape, u: number, v: number, aspect: number): boolean {
  switch (shape) {
    case "cutout":
    case "rectangle":
      return u >= 0 && u <= 1 && v >= 0 && v <= 1;
    case "oval": {
      const dx = (u - 0.5) * 2,
        dy = (v - 0.5) * 2;
      return dx * dx + dy * dy <= 1;
    }
    case "arch": {
      // Round top (a half circle as wide as the piece), straight sides and bottom.
      const r = 0.5; // in widths
      const capV = (r * aspect) ; // half-circle height as a fraction of the height
      if (v >= capV) return u >= 0 && u <= 1 && v <= 1;
      const dx = u - 0.5,
        dy = (capV - v) / aspect;
      return dx * dx + dy * dy <= r * r;
    }
    case "cross": {
      // Upright 1/3 of the width; arms 1/4 of the height, their middle 1/3 of the way down.
      const inUpright = u >= 1 / 3 && u <= 2 / 3;
      const inArms = v >= 1 / 3 - 1 / 8 && v <= 1 / 3 + 1 / 8;
      return (inUpright || inArms) && u >= 0 && u <= 1 && v >= 0 && v <= 1;
    }
  }
}

/** Otsu's threshold: the level that best splits the values into two groups. */
function otsu(a: Float32Array, lo: number, hi: number): number {
  const bins = 256;
  const hist = new Float64Array(bins);
  const span = hi - lo || 1;
  for (let i = 0; i < a.length; i++) hist[Math.min(bins - 1, Math.max(0, Math.floor(((a[i] - lo) / span) * bins)))]++;
  let total = 0,
    sumAll = 0;
  for (let b = 0; b < bins; b++) {
    total += hist[b];
    sumAll += b * hist[b];
  }
  let wB = 0,
    sumB = 0,
    best = 0,
    bestB = bins / 2;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB,
      mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestB = b;
    }
  }
  return lo + ((bestB + 0.5) / bins) * span;
}

/** Keep the biggest connected piece, fill its holes, and smooth its edge (radius ~r px). */
function cleanMask(fg: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const n = w * h;
  // Biggest 4-connected piece.
  const label = new Int32Array(n);
  let best = 0,
    bestSize = 0,
    next = 0;
  const stack = new Int32Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (!fg[s0] || label[s0]) continue;
    next++;
    let top = 0,
      size = 0;
    stack[top++] = s0;
    label[s0] = next;
    while (top) {
      const k = stack[--top];
      size++;
      const x = k % w,
        y = (k / w) | 0;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const m of nb)
        if (m >= 0 && fg[m] && !label[m]) {
          label[m] = next;
          stack[top++] = m;
        }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  // Fill holes: anything not reachable from the border through non-object pixels is object.
  const outside = new Uint8Array(n);
  let top = 0;
  const pushOut = (k: number) => {
    if (!outside[k] && label[k] !== best) {
      outside[k] = 1;
      stack[top++] = k;
    }
  };
  for (let x = 0; x < w; x++) {
    pushOut(x);
    pushOut((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushOut(y * w);
    pushOut(y * w + w - 1);
  }
  while (top) {
    const k = stack[--top];
    const x = k % w,
      y = (k / w) | 0;
    if (x > 0) pushOut(k - 1);
    if (x < w - 1) pushOut(k + 1);
    if (y > 0) pushOut(k - w);
    if (y < h - 1) pushOut(k + w);
  }
  // Smooth the edge: blur and re-threshold (removes stair-steps and specks along the outline).
  const soft = new Float32Array(n);
  for (let k = 0; k < n; k++) soft[k] = outside[k] ? 0 : 1;
  const b = blur(soft, w, h, r);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = b[k] >= 0.5 ? 1 : 0;
  return out;
}

/** The object's outline: what stands in front of the background. */
function cutoutMask(lum: Float32Array, depth: Float32Array | null, w: number, h: number): Uint8Array {
  const n = w * h;
  const fg = new Uint8Array(n);
  const px = Math.max(w, h);
  if (depth) {
    // The object is nearer the camera than the wall/table behind it.
    const d = blur(depth, w, h, px / 600);
    const t = otsu(d, percentile(d, 0.001), percentile(d, 0.999));
    for (let k = 0; k < n; k++) fg[k] = d[k] > t ? 1 : 0;
  } else {
    // Drawings: whatever differs from the paper colour (taken from the picture's border).
    const border: number[] = [];
    for (let x = 0; x < w; x++) border.push(lum[x], lum[(h - 1) * w + x]);
    for (let y = 0; y < h; y++) border.push(lum[y * w], lum[y * w + w - 1]);
    border.sort((a, b) => a - b);
    const paper = border[border.length >> 1];
    const l = blur(lum, w, h, px / 500);
    for (let k = 0; k < n; k++) fg[k] = Math.abs(l[k] - paper) > 0.12 ? 1 : 0;
  }
  return cleanMask(fg, w, h, px / 400);
}

/** Fit z = a·x + b·y + c over the mask and remove it (a photo taken at a slight angle). */
function removeTilt(z: Float32Array, mask: Uint8Array, w: number, h: number) {
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, sxz = 0, syz = 0, sz = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200000)));
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const k = y * w + x;
      if (!mask[k]) continue;
      const u = x / w, v = y / h, q = z[k];
      sxx += u * u; sxy += u * v; sx += u; syy += v * v; sy += v; s1++;
      sxz += u * q; syz += v * q; sz += q;
    }
  if (s1 < 10) return;
  // Solve the 3×3 normal equations (Cramer's rule).
  const M = [sxx, sxy, sx, sxy, syy, sy, sx, sy, s1];
  const det3 = (m: number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return;
  const a = det3([sxz, sxy, sx, syz, syy, sy, sz, sy, s1]) / D;
  const b = det3([sxx, sxz, sx, sxy, syz, sy, sx, sz, s1]) / D;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) z[y * w + x] -= a * (x / w) + b * (y / h);
}

/**
 * Two depth passes → one: the overall shape from the standard pass, the fine detail (lettering,
 * borders) from the high-resolution pass. Both are on the grid already.
 */
export function combineDepth(base: Float32Array, fine: Float32Array | null, w: number, h: number): Float32Array {
  if (!fine) return base.slice();
  const n = w * h;
  // The model's depth has no fixed scale, so match the fine pass to the base pass first.
  let sf = 0, sb = 0, sff = 0, sfb = 0;
  for (let i = 0; i < n; i++) {
    sf += fine[i]; sb += base[i]; sff += fine[i] * fine[i]; sfb += fine[i] * base[i];
  }
  const a = (n * sfb - sf * sb) / (n * sff - sf * sf || 1);
  const b = (sb - a * sf) / n;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = a * fine[i] + b;
  const sigma = Math.max(w, h) / 60;
  const lowBase = blur(base, w, h, sigma);
  const lowFine = blur(f, w, h, sigma);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lowBase[i] + (f[i] - lowFine[i]);
  return out;
}

/**
 * Build the relief on a w × h vertex grid.
 * `lum` is the picture's brightness on that grid; `depth` (photo mode) the AI depth on that grid
 * (already combined), larger = nearer.
 */
export function buildRelief(
  lum: Float32Array,
  depth: Float32Array | null,
  grid: Grid & { res: number },
  p: ReliefParams,
): ReliefMap {
  const { w, h, res } = grid;
  const n = w * h;
  const px = Math.max(w, h); // pixels across the longest side
  const photo = p.mode === "photo" && !!depth;
  const aspect = (w - 1) / (h - 1);

  // 0. Outline first, so every level below is measured on the object only.
  let mask: Uint8Array;
  if (p.shape === "cutout") mask = cutoutMask(lum, photo ? depth : null, w, h);
  else {
    mask = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) mask[y * w + x] = insideShape(p.shape, x / (w - 1), y / (h - 1), aspect) ? 1 : 0;
  }
  const inMask = (a: Float32Array) => {
    const vals: number[] = [];
    const step = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += step) if (mask[i]) vals.push(a[i]);
    return Float32Array.from(vals.length ? vals : [0, 1]);
  };

  // 1. Starting heights 0–1.
  let hgt: Float32Array;
  if (photo) {
    hgt = depth!.slice();
    removeTilt(hgt, mask, w, h);
    const v = inMask(hgt);
    normalize01(hgt, percentile(v, 0.01), percentile(v, 0.998));
  } else {
    hgt = new Float32Array(n);
    // A little blur first so jagged pixels don't become jagged walls.
    const l = blur(lum, w, h, 0.6 + (1 - p.detail) * 1.5);
    for (let i = 0; i < n; i++) hgt[i] = p.raised === "dark" ? 1 - l[i] : l[i];
    const v = inMask(hgt);
    normalize01(hgt, percentile(v, 0.005), percentile(v, 0.995));
  }

  // 2. Background: everything under the cut-off is the flat floor.
  const cut = Math.min(0.95, Math.max(0, p.background));
  const fg = new Float32Array(n); // 1 = figure, 0 = background, soft in between
  for (let i = 0; i < n; i++) {
    const v = (hgt[i] - cut) / (1 - cut);
    hgt[i] = Math.max(0, v);
    fg[i] = cut > 0 ? Math.min(1, Math.max(0, v * 12)) : 1;
  }

  // 3. Flatten: keep the local shape, squeeze the big, slow changes (what a carver does).
  if (p.flatten > 0) {
    const big = blur(hgt, w, h, px / 14);
    const keep = 1 - 0.75 * p.flatten;
    for (let i = 0; i < n; i++) hgt[i] = (big[i] * keep + (hgt[i] - big[i])) * fg[i];
  }

  // 4. Fine detail from the picture's shading — photo mode only.
  if (photo && p.detail > 0) {
    const fine = blur(lum, w, h, Math.max(1, px / 700));
    const soft = blur(lum, w, h, Math.max(2, px / 120));
    for (let i = 0; i < n; i++) hgt[i] += (fine[i] - soft[i]) * p.detail * 0.9 * fg[i];
  }

  // 5. Smooth.
  if (p.smooth > 0) hgt = blur(hgt, w, h, (p.smooth * px) / 250);

  // 6. Lowest level = 0, highest = 1, measured on the object.
  const v = inMask(hgt);
  normalize01(hgt, Math.max(0, percentile(v, 0.002)), Math.max(1e-6, percentile(v, 0.999)));

  // 7. Heights.
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = mask[i] ? p.baseMm + hgt[i] * p.depthMm : 0;
  return { w, h, res, z, mask, level: hgt };
}

/**
 * How far the picture is turned from straight (degrees, within ±20°), from the direction of its
 * strong edges. Crosses, frames and lettering have mostly upright and level edges.
 */
export function detectTilt(lum: Float32Array, w: number, h: number): number {
  const bins = 160; // 0.25° steps over ±20°
  const hist = new Float64Array(bins);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const gx = lum[k + 1 - w] + 2 * lum[k + 1] + lum[k + 1 + w] - lum[k - 1 - w] - 2 * lum[k - 1] - lum[k - 1 + w];
      const gy = lum[k + w - 1] + 2 * lum[k + w] + lum[k + w + 1] - lum[k - w - 1] - 2 * lum[k - w] - lum[k - w + 1];
      const m = gx * gx + gy * gy;
      if (m < 0.02) continue;
      // Edge direction folded into −45°…45° (upright and level edges land near 0).
      let a = (Math.atan2(gy, gx) * 180) / Math.PI;
      a = ((((a + 45) % 90) + 90) % 90) - 45;
      if (a < -20 || a >= 20) continue;
      hist[Math.floor(((a + 20) / 40) * bins)] += Math.sqrt(m);
    }
  // Smooth the histogram a little and take the peak.
  let best = 0,
    bestB = bins / 2;
  for (let b = 0; b < bins; b++) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += hist[Math.min(bins - 1, Math.max(0, b + d))] * (4 - Math.abs(d));
    if (s > best) {
      best = s;
      bestB = b;
    }
  }
  return ((bestB + 0.5) / bins) * 40 - 20;
}
