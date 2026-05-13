"use client";

import type { WizardAnswers } from "@/lib/presets/types";
import { parseBinaryStl } from "@/lib/stl";
import {
  bbox2dFromVerticesXY,
  meshFitsStockWithMargin,
  meshPlacementOffsetMm,
} from "@/lib/stockTopPreviewLayout";
import {
  buildStlForKiri,
  nativeMeshExceedsStock,
  patternFootprintOnStockTopMm,
  readNativeStlSize,
} from "@/lib/stockTransform";
import { isPatternSizeReady } from "@/lib/wizard";
import { useLayoutEffect, useMemo, useRef } from "react";

type Props = {
  answers: WizardAnswers;
  stlBuffer: ArrayBuffer | null;
  /** Fallback silhouette when STL cannot be built yet (same mm as diagram). */
  patternFootprintWidthMm: number;
  patternFootprintDepthMm: number;
};

type DrawPayload = {
  verts: Float32Array | null;
  ox: number;
  oy: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  fallbackW: number;
  fallbackH: number;
  fallbackOx: number;
  fallbackOy: number;
  fits: boolean;
  /** Native file exceeds stock; carved size not set — show “tap Auto-fit” copy. */
  oversizedNativeWaitingFit?: boolean;
};

function drawTopPreview(canvas: HTMLCanvasElement, answers: WizardAnswers, p: DrawPayload) {
  const W = Math.max(answers.stockWidthMm, 1e-6);
  const D = Math.max(answers.stockDepthMm, 1e-6);
  const m = Math.max(0, answers.stockMarginMm);

  const cssW = canvas.clientWidth || 280;
  const cssH = canvas.clientHeight || 200;
  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = 10;

  const flipPreviewY = answers.patternTopViewMirrorY;

  /** World mm: X along stock width, Y along stock depth — same mapping as `meshPlacementOffsetMm`. */
  let mx0 = 0;
  let my0 = 0;
  let mx1 = W;
  let my1 = D;
  /** Mid-Y of placed mesh in stock mm; used only to mirror the teal mesh in the canvas (not in the STL sent to Kiri). */
  let meshCy: number | null = null;
  if (p.verts && p.bbox) {
    const bx0 = p.bbox.minX + p.ox;
    const bx1 = p.bbox.maxX + p.ox;
    const rawY0 = p.bbox.minY + p.oy;
    const rawY1 = p.bbox.maxY + p.oy;
    meshCy = (rawY0 + rawY1) / 2;
    const fy0 = flipPreviewY ? 2 * meshCy - rawY0 : rawY0;
    const fy1 = flipPreviewY ? 2 * meshCy - rawY1 : rawY1;
    const by0 = Math.min(fy0, fy1);
    const by1 = Math.max(fy0, fy1);
    mx0 = Math.min(0, bx0);
    my0 = Math.min(0, by0);
    mx1 = Math.max(W, bx1);
    my1 = Math.max(D, by1);
  }
  const gw = Math.max(mx1 - mx0, 1e-6);
  const gh = Math.max(my1 - my0, 1e-6);
  const scale = Math.min((cssW - 2 * pad) / gw, (cssH - 2 * pad) / gh);
  const orgX = pad + ((cssW - 2 * pad) - gw * scale) / 2 - mx0 * scale;
  const orgY = pad + ((cssH - 2 * pad) - gh * scale) / 2 - my0 * scale;

  const toS = (x: number, y: number) => ({
    x: orgX + x * scale,
    y: orgY + y * scale,
  });

  const meshWorldY = (rawY: number) =>
    flipPreviewY && meshCy != null ? 2 * meshCy - rawY : rawY;

  const corners = [
    toS(0, 0),
    toS(W, 0),
    toS(W, D),
    toS(0, D),
  ];
  const sxMin = Math.min(...corners.map((c) => c.x));
  const sxMax = Math.max(...corners.map((c) => c.x));
  const syMin = Math.min(...corners.map((c) => c.y));
  const syMax = Math.max(...corners.map((c) => c.y));

  ctx.fillStyle = "rgba(120, 53, 15, 0.3)";
  ctx.strokeStyle = "rgba(217, 119, 6, 0.5)";
  ctx.lineWidth = 1;
  ctx.fillRect(sxMin, syMin, sxMax - sxMin, syMax - syMin);
  ctx.strokeRect(sxMin, syMin, sxMax - sxMin, syMax - syMin);

  const mc = [toS(m, m), toS(W - m, m), toS(W - m, D - m), toS(m, D - m)];
  const uxMin = Math.min(...mc.map((c) => c.x));
  const uxMax = Math.max(...mc.map((c) => c.x));
  const uyMin = Math.min(...mc.map((c) => c.y));
  const uyMax = Math.max(...mc.map((c) => c.y));
  ctx.strokeStyle = "rgba(148, 163, 184, 0.65)";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(uxMin, uyMin, uxMax - uxMin, uyMax - uyMin);
  ctx.setLineDash([]);

  if (p.verts && p.bbox) {
    const triCount = p.verts.length / 9;
    const step = triCount > 6000 ? Math.ceil(triCount / 6000) : 1;
    ctx.fillStyle = "rgba(45, 212, 191, 0.18)";
    ctx.strokeStyle = "rgba(45, 212, 191, 0.35)";
    ctx.lineWidth = 0.35;
    for (let t = 0; t < triCount; t += step) {
      const i = t * 9;
      const ax = p.verts[i] + p.ox;
      const ay = meshWorldY(p.verts[i + 1] + p.oy);
      const bx = p.verts[i + 3] + p.ox;
      const by = meshWorldY(p.verts[i + 4] + p.oy);
      const cx = p.verts[i + 6] + p.ox;
      const cy = meshWorldY(p.verts[i + 7] + p.oy);
      const pa = toS(ax, ay);
      const pb = toS(bx, by);
      const pc = toS(cx, cy);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else {
    const w = p.fallbackW;
    const h = p.fallbackH;
    const c0 = toS(p.fallbackOx, p.fallbackOy);
    const c1 = toS(p.fallbackOx + w, p.fallbackOy + h);
    const c2 = toS(p.fallbackOx + w, p.fallbackOy);
    const c3 = toS(p.fallbackOx, p.fallbackOy + h);
    const pxMin = Math.min(c0.x, c1.x, c2.x, c3.x);
    const pxMax = Math.max(c0.x, c1.x, c2.x, c3.x);
    const pyMin = Math.min(c0.y, c1.y, c2.y, c3.y);
    const pyMax = Math.max(c0.y, c1.y, c2.y, c3.y);
    const p0 = { x: pxMin, y: pyMin };
    const p1 = { x: pxMax, y: pyMax };
    ctx.fillStyle = p.fits
      ? "rgba(45, 212, 191, 0.2)"
      : "rgba(244, 63, 94, 0.22)";
    ctx.strokeStyle = p.fits
      ? "rgba(45, 212, 191, 0.85)"
      : "rgba(244, 63, 94, 0.9)";
    ctx.lineWidth = 1;
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  }
}

/**
 * Top-down stock + margin + mesh overlay. Scaled STL bytes match `buildStlForKiri` (what Kiri
 * imports). Optional Y mirror is **canvas-only** for the teal mesh so CAD “up” can match the
 * diagram without changing the file sent to Kiri.
 */
export function StockMeshTopPreview({
  answers,
  stlBuffer,
  patternFootprintWidthMm,
  patternFootprintDepthMm,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const payload = useMemo((): DrawPayload => {
    const fw = Math.max(patternFootprintWidthMm, 1e-6);
    const fh = Math.max(patternFootprintDepthMm, 1e-6);
    const fb = { minX: 0, minY: 0, maxX: fw, maxY: fh };
    const fp = meshPlacementOffsetMm(
      answers.patternPlacement,
      answers.stockWidthMm,
      answers.stockDepthMm,
      answers.stockMarginMm,
      fb,
    );
    const footprintFits = meshFitsStockWithMargin(
      fb,
      fp.ox,
      fp.oy,
      answers.stockWidthMm,
      answers.stockDepthMm,
      answers.stockMarginMm,
    );

    if (!stlBuffer?.byteLength || !answers.stlFileName) {
      return {
        verts: null,
        ox: 0,
        oy: 0,
        bbox: null,
        fallbackW: fw,
        fallbackH: fh,
        fallbackOx: fp.ox,
        fallbackOy: fp.oy,
        fits: footprintFits,
      };
    }

    if (!isPatternSizeReady(answers)) {
      const nat = readNativeStlSize(stlBuffer);
      if (nat) {
        const fpNat = patternFootprintOnStockTopMm(nat);
        const exceeds = nativeMeshExceedsStock(
          nat,
          answers.stockWidthMm,
          answers.stockDepthMm,
          answers.stockThicknessMm,
          answers.stockMarginMm,
        );
        const m = Math.max(0, answers.stockMarginMm);
        const innerW = Math.max(1e-6, answers.stockWidthMm - 2 * m);
        const innerD = Math.max(1e-6, answers.stockDepthMm - 2 * m);
        const sGhost = Math.min(innerW / fpNat.widthMm, innerD / fpNat.depthMm);
        const gW = fpNat.widthMm * sGhost;
        const gH = fpNat.depthMm * sGhost;
        const ghostBbox = { minX: 0, minY: 0, maxX: gW, maxY: gH };
        const gOff = meshPlacementOffsetMm(
          answers.patternPlacement,
          answers.stockWidthMm,
          answers.stockDepthMm,
          answers.stockMarginMm,
          ghostBbox,
        );
        const ghostFits = meshFitsStockWithMargin(
          ghostBbox,
          gOff.ox,
          gOff.oy,
          answers.stockWidthMm,
          answers.stockDepthMm,
          answers.stockMarginMm,
        );
        return {
          verts: null,
          ox: 0,
          oy: 0,
          bbox: null,
          fallbackW: gW,
          fallbackH: gH,
          fallbackOx: gOff.ox,
          fallbackOy: gOff.oy,
          fits: ghostFits && !exceeds,
          oversizedNativeWaitingFit: exceeds,
        };
      }
      return {
        verts: null,
        ox: 0,
        oy: 0,
        bbox: null,
        fallbackW: fw,
        fallbackH: fh,
        fallbackOx: fp.ox,
        fallbackOy: fp.oy,
        fits: footprintFits,
      };
    }
    try {
      const { buffer } = buildStlForKiri(stlBuffer, answers);
      const verts = parseBinaryStl(buffer);
      const bbox = bbox2dFromVerticesXY(verts);
      const { ox, oy } = meshPlacementOffsetMm(
        answers.patternPlacement,
        answers.stockWidthMm,
        answers.stockDepthMm,
        answers.stockMarginMm,
        bbox,
      );
      const fits = meshFitsStockWithMargin(
        bbox,
        ox,
        oy,
        answers.stockWidthMm,
        answers.stockDepthMm,
        answers.stockMarginMm,
      );
      return {
        verts,
        ox,
        oy,
        bbox,
        fallbackW: fw,
        fallbackH: fh,
        fallbackOx: fp.ox,
        fallbackOy: fp.oy,
        fits,
      };
    } catch {
      return {
        verts: null,
        ox: 0,
        oy: 0,
        bbox: null,
        fallbackW: fw,
        fallbackH: fh,
        fallbackOx: fp.ox,
        fallbackOy: fp.oy,
        fits: footprintFits,
      };
    }
  }, [
    stlBuffer,
    stlBuffer?.byteLength ?? 0,
    answers.stlFileName,
    answers.stockWidthMm,
    answers.stockDepthMm,
    answers.stockThicknessMm,
    answers.stockMarginMm,
    answers.patternPlacement,
    answers.patternSizeMm.x,
    answers.patternSizeMm.y,
    answers.patternSizeMm.z,
    answers.linkPatternSizes,
    answers.patternScaleAxis,
    patternFootprintDepthMm,
    patternFootprintWidthMm,
  ]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const paint = () => drawTopPreview(canvas, answers, payload);
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    paint();
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [answers, payload]);

  return (
    <figure className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-slate-950/60">
      <canvas
        ref={canvasRef}
        className="block h-[min(14rem,38vh)] w-full"
        aria-label="Top view of stock, margin, and scaled mesh as sent to Kiri"
      />
      <figcaption className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-slate-400">
        Top view — same millimeters as import: tan = stock ({answers.stockWidthMm.toFixed(1)} ×{" "}
        {answers.stockDepthMm.toFixed(1)} mm), dashed = margin ({answers.stockMarginMm.toFixed(1)}{" "}
        mm inset on each side), teal = pattern. After carve size is set, this matches the scaled STL
        sent to Kiri; before that, only the footprint shape is drawn (native aspect, not full file
        size). STL X → width, Y → depth (front of the bed toward the bottom of this view). With
        “Mirror pattern on Y” on (default), only this diagram flips the mesh front/back; the STL
        sent to Kiri is not mirrored. Non-center placements may still need a quick nudge in Kiri
        Arrange after load.
      </figcaption>
      {!payload.fits && (
        <div className="border-t border-rose-500/20 bg-rose-950/25 px-3 py-2 text-xs text-rose-200/90">
          {payload.oversizedNativeWaitingFit ? (
            <>
              This mesh is larger than your stock (inside the dashed margin) at full file size. Tap{" "}
              <strong className="font-medium text-rose-100">Auto-fit on stock</strong> to scale it
              into the safe area without leaving this screen, or type Carve X/Y/Z yourself. Import
              stays off until a non-zero carved size is set.
            </>
          ) : (
            <>
              Pattern extends outside the margin inset — use Auto-fit or adjust stock / margin /
              size.
            </>
          )}
        </div>
      )}
    </figure>
  );
}
