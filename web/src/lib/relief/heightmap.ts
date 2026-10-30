/**
 * Turn a scaled relief mesh (triangle soup, mm) into a top-down height map.
 *
 * Each pixel holds the highest surface Z above it. Pixels with no mesh above them are outside
 * the design (`mask = 0`). Small gaps between triangles inside the design are filled from the
 * nearest covered pixel so flat areas don't show up as pits.
 */

export type HeightMap = {
  /** Columns (X) and rows (Y). Index = row * width + col. */
  width: number;
  height: number;
  /** mm per pixel */
  res: number;
  /** Position of pixel (0,0) in mesh coordinates (mm). */
  x0: number;
  y0: number;
  /** Surface height (mm, mesh Z). Only meaningful where mask = 1. */
  z: Float32Array;
  /** 1 = inside the design footprint */
  mask: Uint8Array;
  /** Lowest / highest surface Z inside the mask */
  zMin: number;
  zMax: number;
};

export function rasterizeRelief(
  vertices: Float32Array,
  res: number,
  padMm: number,
): HeightMap {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i],
      y = vertices[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const x0 = minX - padMm;
  const y0 = minY - padMm;
  const width = Math.ceil((maxX + padMm - x0) / res) + 1;
  const height = Math.ceil((maxY + padMm - y0) / res) + 1;
  const n = width * height;
  const z = new Float32Array(n).fill(-Infinity);

  const stamp = (px: number, py: number, pz: number) => {
    const i = Math.round(px),
      j = Math.round(py);
    if (i < 0 || j < 0 || i >= width || j >= height) return;
    const k = j * width + i;
    if (pz > z[k]) z[k] = pz;
  };

  for (let t = 0; t + 8 < vertices.length; t += 9) {
    const ax = (vertices[t] - x0) / res,
      ay = (vertices[t + 1] - y0) / res,
      az = vertices[t + 2];
    const bx = (vertices[t + 3] - x0) / res,
      by = (vertices[t + 4] - y0) / res,
      bz = vertices[t + 5];
    const cx = (vertices[t + 6] - x0) / res,
      cy = (vertices[t + 7] - y0) / res,
      cz = vertices[t + 8];
    // Vertices always count, so tiny or edge-on triangles still leave a mark.
    stamp(ax, ay, az);
    stamp(bx, by, bz);
    stamp(cx, cy, cz);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
    const i1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
    const j1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy)));
    const inv = 1 / area;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const w0 = ((bx - i) * (cy - j) - (by - j) * (cx - i)) * inv;
        const w1 = ((cx - i) * (ay - j) - (cy - j) * (ax - i)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const pz = w0 * az + w1 * bz + w2 * cz;
        const k = j * width + i;
        if (pz > z[k]) z[k] = pz;
      }
    }
  }

  const covered = new Uint8Array(n);
  for (let k = 0; k < n; k++) covered[k] = z[k] > -Infinity ? 1 : 0;

  // Close small gaps, then fill enclosed holes, to get a solid footprint.
  let mask = dilate4(covered, width, height, 3);
  mask = erode4(mask, width, height, 3);
  mask = fillHoles(mask, width, height);
  for (let k = 0; k < n; k++) if (covered[k]) mask[k] = 1;

  fillFromNearest(z, covered, mask, width, height);

  let zMin = Infinity,
    zMax = -Infinity;
  for (let k = 0; k < n; k++) {
    if (!mask[k]) continue;
    if (z[k] < zMin) zMin = z[k];
    if (z[k] > zMax) zMax = z[k];
  }
  return { width, height, res, x0, y0, z, mask, zMin, zMax };
}

/** One step of 4-neighbour dilation, repeated `iterations` times. */
export function dilate4(src: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let a = src.slice();
  for (let it = 0; it < iterations; it++) {
    const b = a.slice();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (a[k]) continue;
        if (
          (i > 0 && a[k - 1]) ||
          (i < w - 1 && a[k + 1]) ||
          (j > 0 && a[k - w]) ||
          (j < h - 1 && a[k + w])
        )
          b[k] = 1;
      }
    }
    a = b;
  }
  return a;
}

export function erode4(src: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let a = src.slice();
  for (let it = 0; it < iterations; it++) {
    const b = a.slice();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!a[k]) continue;
        if (
          i === 0 ||
          i === w - 1 ||
          j === 0 ||
          j === h - 1 ||
          !a[k - 1] ||
          !a[k + 1] ||
          !a[k - w] ||
          !a[k + w]
        )
          b[k] = 0;
      }
    }
    a = b;
  }
  return a;
}

/** Anything not reachable from the border through empty pixels becomes part of the mask. */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0,
    qt = 0;
  const push = (k: number) => {
    if (!mask[k] && !outside[k]) {
      outside[k] = 1;
      queue[qt++] = k;
    }
  };
  for (let i = 0; i < w; i++) {
    push(i);
    push((h - 1) * w + i);
  }
  for (let j = 0; j < h; j++) {
    push(j * w);
    push(j * w + w - 1);
  }
  while (qh < qt) {
    const k = queue[qh++];
    const i = k % w,
      j = (k - i) / w;
    if (i > 0) push(k - 1);
    if (i < w - 1) push(k + 1);
    if (j > 0) push(k - w);
    if (j < h - 1) push(k + w);
  }
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = outside[k] ? 0 : 1;
  return out;
}

/** Give each uncovered pixel inside the mask the height of the nearest covered pixel (BFS). */
function fillFromNearest(
  z: Float32Array,
  covered: Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
) {
  const n = w * h;
  const done = covered.slice();
  const queue = new Int32Array(n);
  let qh = 0,
    qt = 0;
  for (let k = 0; k < n; k++) if (covered[k]) queue[qt++] = k;
  while (qh < qt) {
    const k = queue[qh++];
    const i = k % w,
      j = (k - i) / w;
    const zk = z[k];
    const visit = (m: number) => {
      if (done[m] || !mask[m]) return;
      done[m] = 1;
      z[m] = zk;
      queue[qt++] = m;
    };
    if (i > 0) visit(k - 1);
    if (i < w - 1) visit(k + 1);
    if (j > 0) visit(k - w);
    if (j < h - 1) visit(k + w);
  }
  for (let k = 0; k < n; k++) if (!mask[k]) z[k] = 0;
}
