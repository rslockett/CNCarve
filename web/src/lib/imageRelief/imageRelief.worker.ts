/// <reference lib="webworker" />
/** Builds the relief, its shaded preview and the STL off the main thread (keeps the Pi responsive). */
import { encodeBinaryStl } from "../stl";
import { reliefToTriangles } from "./mesh";
import type { DepthMap } from "./depth.worker";
import { buildRelief, combineDepth, resample, type ReliefMap, type ReliefParams } from "./relief";

export type ReliefJob = {
  id: number;
  want: "preview" | "stl";
  /** brightness on the grid */
  lum: Float32Array;
  /** AI depth passes at the model's own sizes (photo mode): overall shape, then fine detail */
  depth: DepthMap[] | null;
  grid: { w: number; h: number; res: number };
  params: ReliefParams;
};

export type ReliefJobResult =
  | { id: number; type: "preview"; rgba: Uint8ClampedArray; width: number; height: number; triangles: number }
  | { id: number; type: "stl"; stl: ArrayBuffer; triangles: number }
  | { id: number; type: "error"; message: string };

const post = (m: ReliefJobResult, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

// Soft light from the upper left, like the live carving view.
const L = [-0.38, 0.46, 0.8];
const LN = Math.hypot(L[0], L[1], L[2]);

/** Shaded picture of the relief, as if lit wood, at most ~1100 px on the long side. */
function shade(m: ReliefMap): { rgba: Uint8ClampedArray; width: number; height: number } {
  const step = Math.max(1, Math.ceil(Math.max(m.w, m.h) / 1100));
  const W = Math.ceil(m.w / step),
    H = Math.ceil(m.h / step);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const z = (i: number, j: number) => m.z[Math.min(m.h - 1, Math.max(0, j)) * m.w + Math.min(m.w - 1, Math.max(0, i))];
  const d = step; // slope over one preview pixel
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = x * step,
        j = y * step;
      const o = (y * W + x) * 4;
      rgba[o + 3] = 255;
      if (!m.mask[j * m.w + i]) {
        rgba[o] = 15;
        rgba[o + 1] = 23;
        rgba[o + 2] = 42;
        continue;
      }
      const dzdx = (z(i + d, j) - z(i - d, j)) / (2 * d * m.res);
      const dzdy = -(z(i, j + d) - z(i, j - d)) / (2 * d * m.res); // picture rows go down
      const nl = Math.hypot(dzdx, dzdy, 1);
      const lambert = Math.max(0, (-dzdx * L[0] - dzdy * L[1] + L[2]) / (nl * LN));
      const s = 0.3 + 0.7 * lambert;
      const tint = 0.86 + 0.14 * m.level[j * m.w + i]; // higher parts a touch lighter
      const v = 250 * s * tint;
      rgba[o] = v;
      rgba[o + 1] = v * 0.82;
      rgba[o + 2] = v * 0.6;
    }
  return { rgba, width: W, height: H };
}

self.onmessage = (ev: MessageEvent<ReliefJob>) => {
  const job = ev.data;
  try {
    const { w, h } = job.grid;
    const onGrid = (d: DepthMap) => resample(d.data, d.width, d.height, w, h);
    const depth = job.depth?.length
      ? combineDepth(onGrid(job.depth[0]), job.depth[1] ? onGrid(job.depth[1]) : null, w, h)
      : null;
    const m = buildRelief(job.lum, depth, job.grid, job.params);
    if (job.want === "preview") {
      const p = shade(m);
      post({ id: job.id, type: "preview", ...p, triangles: 0 }, [p.rgba.buffer]);
    } else {
      const tris = reliefToTriangles(m);
      const stl = encodeBinaryStl(tris);
      post({ id: job.id, type: "stl", stl, triangles: tris.length / 9 }, [stl]);
    }
  } catch (e) {
    post({ id: job.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
