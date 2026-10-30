/**
 * Get any relief STL ready to carve without asking the user anything:
 *  - the thinnest side becomes the carving depth (Z), with the carved face pointing up;
 *  - the design is turned 90° on the board when that lets it be carved bigger;
 *  - "largest that fits" respects the board's width, length and thickness.
 */

import { bboxFromVertices } from "../stl";

/** Room kept clear around the design: saw groove (1.5 mm) + a little wood to hold. */
export const EDGE_ALLOWANCE_MM = 4.5;
/** Extra cut below the design for the saw groove + skim (see reliefCam floorBelow/topSkim). */
export const EXTRA_DEPTH_MM = 0.6;
/** Wood that must stay under the deepest cut. */
export const MIN_FLOOR_MM = 1.5;

export type Oriented = {
  /** Mesh with min corner at the origin, relief facing +Z (native units/scale). */
  vertices: Float32Array;
  size: { x: number; y: number; z: number };
  /** What was done, in plain words, if anything. */
  note: string | null;
};

function permute(v: Float32Array, order: [number, number, number], flip: boolean): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i + order[0]],
      y = v[i + order[1]],
      z = v[i + order[2]];
    out[i] = x;
    out[i + 1] = flip ? -y : y;
    out[i + 2] = flip ? -z : z;
  }
  return out;
}

/** Area-weighted sum of triangle normals along Z: > 0 means the surface mostly faces up. */
function upFacing(v: Float32Array): number {
  let s = 0;
  for (let t = 0; t + 8 < v.length; t += 9) {
    const ax = v[t + 3] - v[t],
      ay = v[t + 4] - v[t + 1];
    const bx = v[t + 6] - v[t],
      by = v[t + 7] - v[t + 1];
    s += ax * by - ay * bx; // 2 × projected area, signed by facing
  }
  return s;
}

function normalize(v: Float32Array): { vertices: Float32Array; size: Oriented["size"] } {
  const bb = bboxFromVertices(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = v[i] - bb.min[0];
    out[i + 1] = v[i + 1] - bb.min[1];
    out[i + 2] = v[i + 2] - bb.min[2];
  }
  return {
    vertices: out,
    size: { x: bb.max[0] - bb.min[0], y: bb.max[1] - bb.min[1], z: bb.max[2] - bb.min[2] },
  };
}

export function orientForCarving(raw: Float32Array): Oriented {
  const bb = bboxFromVertices(raw);
  const ext = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
  const thin = ext.indexOf(Math.min(...ext));
  // Cyclic permutations keep the model from being mirrored.
  const order: [number, number, number] = thin === 2 ? [0, 1, 2] : thin === 0 ? [1, 2, 0] : [2, 0, 1];
  let v = permute(raw, order, false);
  let note: string | null = thin === 2 ? null : "Turned the model so its carved face points up.";
  // A one-sided relief has a clear facing; a closed solid sums to ~0 and is left as is.
  const facing = upFacing(v);
  let total = 0;
  for (let t = 0; t + 8 < v.length; t += 9) {
    const ax = v[t + 3] - v[t],
      ay = v[t + 4] - v[t + 1];
    const bx = v[t + 6] - v[t],
      by = v[t + 7] - v[t + 1];
    total += Math.abs(ax * by - ay * bx);
  }
  if (total > 0 && facing < -0.2 * total) {
    v = permute(v, [0, 1, 2], true);
    note = "Flipped the model so its carved face points up.";
  }
  const n = normalize(v);
  return { ...n, note };
}

/** Turn the design 90° on the board (around Z). */
export function rotate90(o: Oriented): Oriented {
  const v = o.vertices;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = -v[i + 1];
    out[i + 1] = v[i];
    out[i + 2] = v[i + 2];
  }
  return { ...normalize(out), note: o.note };
}

export type Board = { widthMm: number; lengthMm: number; thicknessMm: number };

/** Largest uniform scale that fits the board (or 0 if it can't fit at all). */
export function largestScale(size: Oriented["size"], board: Board): number {
  const w = board.widthMm - 2 * EDGE_ALLOWANCE_MM;
  const l = board.lengthMm - 2 * EDGE_ALLOWANCE_MM;
  const t = board.thicknessMm - MIN_FLOOR_MM - EXTRA_DEPTH_MM;
  if (w <= 0 || l <= 0 || t <= 0) return 0;
  return Math.min(w / size.x, l / size.y, size.z > 1e-6 ? t / size.z : Infinity);
}

/** Problems with carving at this scale, in plain words (empty = fits). */
export function fitProblems(size: Oriented["size"], scale: number, board: Board, fmt: (mm: number) => string): string[] {
  const out: string[] = [];
  const w = size.x * scale + 2 * EDGE_ALLOWANCE_MM;
  const l = size.y * scale + 2 * EDGE_ALLOWANCE_MM;
  const d = size.z * scale + EXTRA_DEPTH_MM + MIN_FLOOR_MM;
  if (w > board.widthMm + 1e-6) out.push(`It needs a board at least ${fmt(w)} wide.`);
  if (l > board.lengthMm + 1e-6) out.push(`It needs a board at least ${fmt(l)} long.`);
  if (d > board.thicknessMm + 1e-6) out.push(`It needs a board at least ${fmt(d)} thick.`);
  return out;
}

/** 3018-PROVer travel; anything bigger can't be carved in one go. */
export const MACHINE_TRAVEL = { xMm: 300, yMm: 180 };
