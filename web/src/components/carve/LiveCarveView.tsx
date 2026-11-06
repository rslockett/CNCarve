"use client";

import type { Pos } from "@/lib/carveMachine";
import type { BitShape } from "@/lib/relief/reliefCam";
import type { LiveInit, LiveOut } from "@/lib/relief/liveCarve.worker";
import { useEffect, useRef, useState } from "react";

type Props = {
  /** Changes when a different carve starts — the view is rebuilt. */
  carveId: string;
  gcode: string;
  bit: BitShape;
  area: { minX: number; maxX: number; minY: number; maxY: number };
  /** Last line the machine acknowledged. */
  line: number;
  /** Where the bit really is (from the machine's status reports). */
  wpos: Pos | null;
  paused: boolean;
};

type Layout = { width: number; height: number; minX: number; maxY: number; pxPerMm: number };

/**
 * The board being carved, live. All the drawing happens in a worker (see liveCarve.worker.ts);
 * this component only forwards the line number a few times a second and moves the bit marker,
 * which the browser animates on the GPU.
 */
export function LiveCarveView({ carveId, gcode, bit, area, line, wpos, paused }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [ready, setReady] = useState(false);
  const lastSent = useRef(-1);
  const lineRef = useRef(line);
  useEffect(() => {
    lineRef.current = line;
  }, [line]);

  // Build the view once per carve. The canvas is handed to the worker, so React never redraws it.
  useEffect(() => {
    const el = holder.current;
    if (!el || typeof OffscreenCanvas === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.className = "block h-auto w-full rounded-lg";
    el.prepend(canvas);
    const off = canvas.transferControlToOffscreen();
    const w = new Worker(new URL("../../lib/relief/liveCarve.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (ev: MessageEvent<LiveOut>) => {
      if (ev.data.type === "layout") setLayout(ev.data);
      else if (ev.data.type === "ready") setReady(true);
    };
    const init: LiveInit = {
      type: "init",
      canvas: off,
      gcode,
      bit,
      area,
      maxPx: 640,
      startLine: lineRef.current,
    };
    w.postMessage(init, [off]);
    lastSent.current = lineRef.current;
    return () => {
      w.terminate();
      workerRef.current = null;
      canvas.remove();
      setLayout(null);
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carveId]);

  // Forward progress, at most 5 times a second.
  useEffect(() => {
    const t = window.setInterval(() => {
      const l = lineRef.current;
      if (workerRef.current && l !== lastSent.current) {
        workerRef.current.postMessage({ type: "line", line: l });
        lastSent.current = l;
      }
    }, 200);
    return () => window.clearInterval(t);
  }, []);

  const marker =
    layout && wpos
      ? {
          x: ((wpos.x - layout.minX) * layout.pxPerMm * 100) / layout.width,
          y: ((layout.maxY - wpos.y) * layout.pxPerMm * 100) / layout.height,
          cutting: wpos.z < 0,
          bitPx: Math.max(6, bit.diameterMm * layout.pxPerMm),
        }
      : null;

  return (
    <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-xl bg-slate-950 p-2 shadow-inner ring-1 ring-white/10">
      <div ref={holder} className="relative" style={layout ? { aspectRatio: `${layout.width} / ${layout.height}` } : { minHeight: 160 }}>
        {marker && marker.x >= -5 && marker.x <= 105 && marker.y >= -5 && marker.y <= 105 && (
          <div
            className="pointer-events-none absolute left-0 top-0 h-full w-full"
            aria-hidden
          >
            <div
              className="absolute rounded-full transition-[left,top] duration-[250ms] ease-linear will-change-[left,top]"
              style={{
                left: `${marker.x}%`,
                top: `${marker.y}%`,
                width: marker.bitPx,
                height: marker.bitPx,
                transform: "translate(-50%, -50%)",
                background: marker.cutting ? "radial-gradient(circle, #f8fafc 0 22%, #2dd4bf 40%, rgba(45,212,191,0) 72%)" : "transparent",
                border: marker.cutting ? "none" : "2px solid rgba(45,212,191,0.9)",
                boxShadow: marker.cutting && !paused ? "0 0 14px 4px rgba(45,212,191,0.45)" : "none",
              }}
            />
          </div>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
            {typeof OffscreenCanvas === "undefined" ? "Live view isn't available in this browser." : "Preparing the live view…"}
          </div>
        )}
      </div>
    </div>
  );
}
