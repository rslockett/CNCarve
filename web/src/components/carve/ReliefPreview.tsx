"use client";

import type { ReliefPreview as Preview } from "@/lib/relief/reliefCam";
import { useEffect, useRef } from "react";

type Which = "target" | "carved" | "beforeDetail" | "likely";

/**
 * How much the detail bit is pushed off by leftover wood, as a share of the extra wood it meets
 * (beyond the planned 0.2 mm skin). Estimates from real carvings on the 3018: at the Fast speed,
 * carvings with tall fins showed clear lines; at the Original speed the first cross came out
 * clean with the same fins.
 */
export const PUSH_OFF = { fast: 0.1, original: 0.02 } as const;

/**
 * "likely": the finished surface as a real, slightly flexible machine tends to cut it. Where the
 * detail bit meets more than the planned skin, it ends up a little shallow.
 */
function likelySurface(p: Preview, pushOff: number): Float32Array {
  const out = new Float32Array(p.carved.length);
  for (let k = 0; k < out.length; k++) {
    const extra = p.beforeDetail[k] - p.carved[k] - 0.2;
    out[k] = p.carved[k] + (extra > 0 ? pushOff * extra : 0);
  }
  return out;
}

/**
 * Centre of the square (2·half pixels wide) with the most going on in the design: inside the
 * machined area and with the most fine change in height (faces, hands, lettering). Based on the design only, so every
 * close-up of the same carving shows the same spot.
 */
function busiestSpot(p: Preview, half: number, i0: number, i1: number, j0: number, j1: number): [number, number] {
  const step = Math.max(2, Math.round(half / 6));
  let best = -1, bi = Math.round((i0 + i1) / 2), bj = Math.round((j0 + j1) / 2);
  for (let cj = j0 + half; cj <= j1 - half; cj += step)
    for (let ci = i0 + half; ci <= i1 - half; ci += step) {
      let score = 0, inside = 0, n = 0;
      for (let j = cj - half; j < cj + half; j += step)
        for (let i = ci - half; i < ci + half; i += step) {
          n++;
          const k = j * p.width + i;
          if (!p.work[k]) continue;
          inside++;
          const kr = Math.min(p.width - 1, i + step) + j * p.width, kd = Math.min(p.height - 1, j + step) * p.width + i;
          // Fine relief counts, tall walls (frames, edges) don't: each change is capped.
          const cap = 0.04 * step;
          score += Math.min(cap, Math.abs(p.target[kr] - p.target[k])) + Math.min(cap, Math.abs(p.target[kd] - p.target[k]));
        }
      if (inside < 0.9 * n) continue; // mostly inside the carving
      if (score > best) [best, bi, bj] = [score, ci, cj];
    }
  return [bi, bj];
}

/** Shaded "wood" picture of a height map, cropped to the machined area. `zoomMm`: show only a
 * square this many mm wide (the busiest part of the design), enlarged. */
function draw(canvas: HTMLCanvasElement, p: Preview, which: Which, maxPx: number, zoomMm: number | undefined, pushOff: number) {
  const z =
    which === "target"
      ? p.target
      : which === "carved"
        ? p.carved
        : which === "likely"
          ? likelySurface(p, pushOff)
          : p.beforeDetail;
  let i0 = p.width,
    i1 = 0,
    j0 = p.height,
    j1 = 0;
  for (let j = 0; j < p.height; j++)
    for (let i = 0; i < p.width; i++)
      if (p.work[j * p.width + i]) {
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
  if (i1 < i0) return;
  if (zoomMm) {
    const half = Math.round(zoomMm / p.res / 2);
    const [ci, cj] = busiestSpot(p, half, i0, i1, j0, j1);
    i0 = Math.max(0, ci - half);
    i1 = Math.min(p.width - 1, ci + half);
    j0 = Math.max(0, cj - half);
    j1 = Math.min(p.height - 1, cj + half);
  }
  const cw = i1 - i0 + 1,
    ch = j1 - j0 + 1;
  const scale = zoomMm ? maxPx / Math.max(cw, ch) : Math.min(1, maxPx / Math.max(cw, ch));
  const W = Math.max(1, Math.round(cw * scale)),
    H = Math.max(1, Math.round(ch * scale));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(W, H);
  const L = [-0.5, 0.6, 0.65];
  const ln = Math.hypot(L[0], L[1], L[2]);
  const at = (i: number, j: number) => {
    const ii = Math.min(p.width - 1, Math.max(0, i)),
      jj = Math.min(p.height - 1, Math.max(0, j));
    return p.work[jj * p.width + ii] ? z[jj * p.width + ii] : 0;
  };
  // Enlarged views blend between grid points, so the grid itself never shows as blocks.
  const zAt = (fi: number, fj: number) => {
    const a = Math.floor(fi), b = Math.floor(fj), u = fi - a, v = fj - b;
    return (
      at(a, b) * (1 - u) * (1 - v) + at(a + 1, b) * u * (1 - v) + at(a, b + 1) * (1 - u) * v + at(a + 1, b + 1) * u * v
    );
  };
  const step = Math.max(1, Math.round(1 / scale));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fi = i0 + x / scale, fj = j1 - y / scale; // front of the board at the bottom
      const i = Math.min(p.width - 1, Math.round(fi)), j = Math.max(0, Math.round(fj));
      const o = (y * W + x) * 4;
      img.data[o + 3] = 255;
      if (!p.work[j * p.width + i]) {
        img.data[o] = 214;
        img.data[o + 1] = 184;
        img.data[o + 2] = 140; // untouched board
        continue;
      }
      const dzdx = scale > 1
        ? (zAt(fi + 1, fj) - zAt(fi - 1, fj)) / (2 * p.res)
        : (at(i + step, j) - at(i - step, j)) / (2 * step * p.res);
      const dzdy = scale > 1
        ? (zAt(fi, fj + 1) - zAt(fi, fj - 1)) / (2 * p.res)
        : (at(i, j + step) - at(i, j - step)) / (2 * step * p.res);
      const nl = Math.hypot(dzdx, dzdy, 1);
      const s = Math.max(0, (-dzdx * L[0] - dzdy * L[1] + L[2]) / (nl * ln));
      const v = 40 + 215 * s;
      img.data[o] = Math.min(255, v);
      img.data[o + 1] = Math.min(255, v * 0.82);
      img.data[o + 2] = Math.min(255, v * 0.6);
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function ReliefPreview({
  preview,
  which,
  label,
  zoomMm,
  pushOff = PUSH_OFF.fast,
}: {
  preview: Preview;
  which: Which;
  label: string;
  zoomMm?: number;
  /** For "likely": see PUSH_OFF. */
  pushOff?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) draw(ref.current, preview, which, zoomMm ? 360 : 480, zoomMm, pushOff);
  }, [preview, which, zoomMm, pushOff]);
  return (
    <figure className="flex flex-col items-center">
      <canvas
        ref={ref}
        className="max-h-72 w-auto max-w-full rounded-lg shadow-lg"
      />
      <figcaption className="mt-1.5 text-xs text-slate-400">{label}</figcaption>
    </figure>
  );
}
