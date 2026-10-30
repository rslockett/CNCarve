"use client";

import type { ReliefPreview as Preview } from "@/lib/relief/reliefCam";
import { useEffect, useRef } from "react";

/** Shaded "wood" picture of a height map, cropped to the machined area. */
function draw(canvas: HTMLCanvasElement, p: Preview, which: "target" | "carved", maxPx: number) {
  const z = which === "target" ? p.target : p.carved;
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
  const cw = i1 - i0 + 1,
    ch = j1 - j0 + 1;
  const scale = Math.min(1, maxPx / Math.max(cw, ch));
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
  const step = Math.max(1, Math.round(1 / scale));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = i0 + Math.floor(x / scale);
      const j = j1 - Math.floor(y / scale); // front of the board at the bottom
      const o = (y * W + x) * 4;
      img.data[o + 3] = 255;
      if (!p.work[j * p.width + i]) {
        img.data[o] = 214;
        img.data[o + 1] = 184;
        img.data[o + 2] = 140; // untouched board
        continue;
      }
      const dzdx = (at(i + step, j) - at(i - step, j)) / (2 * step * p.res);
      const dzdy = (at(i, j + step) - at(i, j - step)) / (2 * step * p.res);
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
}: {
  preview: Preview;
  which: "target" | "carved";
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) draw(ref.current, preview, which, 480);
  }, [preview, which]);
  return (
    <figure className="flex flex-col items-center">
      <canvas ref={ref} className="max-h-72 w-auto max-w-full rounded-lg shadow-lg" />
      <figcaption className="mt-1.5 text-xs text-slate-400">{label}</figcaption>
    </figure>
  );
}
