/**
 * Relief height map → closed (watertight) STL solid.
 *
 * A plain grid at full detail would be hundreds of MB, so the top surface is an adaptive
 * quadtree: flat or gently curved areas get a few large triangles, detailed areas keep every
 * grid point. Cells are only merged when the result stays within `toleranceMm` of every grid
 * point. Neighbouring cells differ by at most one size step and the bigger one shares the smaller
 * one's corner, so there are no cracks. Walls follow the outline; the bottom mirrors the top
 * triangulation at z = 0, so every edge is shared by exactly two triangles.
 */
import type { ReliefMap } from "./relief";

export type MeshStats = { triangles: number; bytes: number };

export function reliefToTriangles(m: ReliefMap, toleranceMm = 0.01): Float32Array {
  const { w, h, res, z, mask } = m;
  const cw = w - 1,
    ch = h - 1; // cells
  let N = 1;
  while (N < Math.max(cw, ch)) N *= 2;

  // A cell is inside when all four of its corners are.
  const cellIn = new Uint8Array(N * N);
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      const a = j * w + i;
      cellIn[j * N + i] = mask[a] && mask[a + 1] && mask[a + w] && mask[a + w + 1] ? 1 : 0;
    }
  // Summed-area table of inside cells → fast "all / none / some inside" for any square.
  const sat = new Int32Array((N + 1) * (N + 1));
  for (let j = 0; j < N; j++) {
    let row = 0;
    for (let i = 0; i < N; i++) {
      row += cellIn[j * N + i];
      sat[(j + 1) * (N + 1) + i + 1] = sat[j * (N + 1) + i + 1] + row;
    }
  }
  const count = (x: number, y: number, s: number) =>
    sat[(y + s) * (N + 1) + x + s] - sat[y * (N + 1) + x + s] - sat[(y + s) * (N + 1) + x] + sat[y * (N + 1) + x];

  const zAt = (i: number, j: number) => z[j * w + i];
  /** Largest gap between the surface and the two-triangle approximation of this square. */
  const error = (x: number, y: number, s: number) => {
    const z00 = zAt(x, y),
      z10 = zAt(x + s, y),
      z01 = zAt(x, y + s),
      z11 = zAt(x + s, y + s);
    let e = 0;
    for (let j = 0; j <= s; j++) {
      const ty = j / s;
      const base = (y + j) * w + x;
      for (let i = 0; i <= s; i++) {
        const tx = i / s;
        // Triangles split along the (0,0)–(1,1) diagonal.
        const approx =
          tx >= ty ? z00 + (z10 - z00) * tx + (z11 - z10) * ty : z00 + (z01 - z00) * ty + (z11 - z01) * tx;
        const d = Math.abs(z[base + i] - approx);
        if (d > e) {
          e = d;
          if (e > toleranceMm) return e;
        }
      }
    }
    return e;
  };

  // leafSize[cell] = size of the inside leaf covering it, 0 = outside.
  const leafSize = new Int32Array(N * N);
  const leafX = new Int32Array(N * N); // leaf origin for each cell (to find the leaf)
  const leafY = new Int32Array(N * N);
  const setLeaf = (x: number, y: number, s: number) => {
    for (let j = y; j < y + s; j++)
      for (let i = x; i < x + s; i++) {
        leafSize[j * N + i] = s;
        leafX[j * N + i] = x;
        leafY[j * N + i] = y;
      }
  };
  const MAX_LEAF = 64;
  const build = (x: number, y: number, s: number) => {
    const c = count(x, y, s);
    if (c === 0) return; // all outside
    const full = c === s * s;
    if (s === 1 || (full && s <= MAX_LEAF && error(x, y, s) <= toleranceMm)) {
      setLeaf(x, y, s);
      return;
    }
    const k = s / 2;
    build(x, y, k);
    build(x + k, y, k);
    build(x, y + k, k);
    build(x + k, y + k, k);
  };
  build(0, 0, N);

  const sizeAt = (i: number, j: number) => (i < 0 || j < 0 || i >= N || j >= N ? 0 : leafSize[j * N + i]);

  // Balance: no inside leaf may touch an inside leaf less than half its size.
  const split = (x: number, y: number, s: number) => {
    const k = s / 2;
    for (const [ox, oy] of [
      [0, 0],
      [k, 0],
      [0, k],
      [k, k],
    ])
      setLeaf(x + ox, y + oy, k);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const s = leafSize[j * N + i];
        if (s < 4 || leafX[j * N + i] !== i || leafY[j * N + i] !== j) continue; // visit each leaf once at its origin
        let need = false;
        for (let t = 0; t < s && !need; t++) {
          const a = sizeAt(i - 1, j + t),
            b = sizeAt(i + s, j + t),
            c = sizeAt(i + t, j - 1),
            d = sizeAt(i + t, j + s);
          if ((a && a < s / 2) || (b && b < s / 2) || (c && c < s / 2) || (d && d < s / 2)) need = true;
        }
        if (need) {
          split(i, j, s);
          changed = true;
        }
      }
  }

  // Emit triangles.
  let out = new Float32Array(1 << 20);
  let used = 0;
  const push9 = (a: number[], b: number[], c: number[]) => {
    if (used + 9 > out.length) {
      const bigger = new Float32Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[used++] = a[0]; out[used++] = a[1]; out[used++] = a[2];
    out[used++] = b[0]; out[used++] = b[1]; out[used++] = b[2];
    out[used++] = c[0]; out[used++] = c[1]; out[used++] = c[2];
  };
  const P = (i: number, j: number, top: boolean): [number, number, number] => [
    i * res,
    (h - 1 - j) * res, // picture rows go down; the model's Y goes up
    top ? zAt(i, j) : 0,
  ];
  const tri = (a: number[], b: number[], c: number[], nz: number, nx = 0, ny = 0) => {
    // Order the corners so the face points along (nx, ny, nz).
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz < 0) push9(a, c, b);
    else push9(a, b, c);
  };
  const face = (pts: [number, number][]) => {
    // Fan or pair of triangles on the top, mirrored on the bottom.
    for (let t = 1; t + 1 < pts.length; t++) {
      const [a, b, c] = [pts[0], pts[t], pts[t + 1]];
      tri(P(a[0], a[1], true), P(b[0], b[1], true), P(c[0], c[1], true), 1);
      tri(P(a[0], a[1], false), P(b[0], b[1], false), P(c[0], c[1], false), -1);
    }
  };
  const wall = (i0: number, j0: number, i1: number, j1: number, nx: number, ny: number) => {
    const ta = P(i0, j0, true),
      tb = P(i1, j1, true),
      ba = P(i0, j0, false),
      bb = P(i1, j1, false);
    tri(ta, tb, bb, 0, nx, ny);
    tri(ta, bb, ba, 0, nx, ny);
  };

  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const s = leafSize[j * N + i];
      if (!s || leafX[j * N + i] !== i || leafY[j * N + i] !== j) continue;
      const k = s / 2;
      // For each edge: does a smaller inside neighbour put a point at its middle?
      // Edges: 0 = top (j), 1 = right (i+s), 2 = bottom (j+s), 3 = left (i).
      const across = [
        (t: number) => sizeAt(i + t, j - 1),
        (t: number) => sizeAt(i + s, j + t),
        (t: number) => sizeAt(i + t, j + s),
        (t: number) => sizeAt(i - 1, j + t),
      ];
      const mid = across.map((f) => s > 1 && ((f(0) > 0 && f(0) < s) || (f(k) > 0 && f(k) < s)));
      // Corners and middles, going round the square.
      const ring: [number, number][] = [[i, j]];
      if (mid[0]) ring.push([i + k, j]);
      ring.push([i + s, j]);
      if (mid[1]) ring.push([i + s, j + k]);
      ring.push([i + s, j + s]);
      if (mid[2]) ring.push([i + k, j + s]);
      ring.push([i, j + s]);
      if (mid[3]) ring.push([i, j + k]);
      if (ring.length === 4) {
        face([ring[0], ring[1], ring[2]]);
        face([ring[0], ring[2], ring[3]]);
      } else {
        const c: [number, number] = [i + k, j + k];
        for (let t = 0; t < ring.length; t++) face([c, ring[t], ring[(t + 1) % ring.length]]);
      }
      // Walls where the neighbour across an edge is outside.
      const outward: [number, number][] = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ];
      const ends: [number, number, number, number][] = [
        [i, j, i + s, j],
        [i + s, j, i + s, j + s],
        [i + s, j + s, i, j + s],
        [i, j + s, i, j],
      ];
      for (let e = 0; e < 4; e++) {
        const [x0, y0, x1, y1] = ends[e];
        const [nx, ny] = outward[e];
        if (!mid[e]) {
          if (!across[e](0)) wall(x0, y0, x1, y1, nx, ny);
        } else {
          const mx = (x0 + x1) / 2,
            my = (y0 + y1) / 2;
          // First half (from x0,y0) — sample the neighbour cell next to that corner.
          const firstT = e === 0 || e === 1 ? 0 : k;
          const secondT = e === 0 || e === 1 ? k : 0;
          if (!across[e](firstT)) wall(x0, y0, mx, my, nx, ny);
          if (!across[e](secondT)) wall(mx, my, x1, y1, nx, ny);
        }
      }
    }
  return out.slice(0, used);
}
