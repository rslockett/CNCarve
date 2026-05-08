"use client";

import { formatDuration, parseGcodeStats } from "@/lib/gcodeStats";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  open: boolean;
  gcode: string;
  sentLine: number;
  totalLines: number;
  estimatedTotalSec: number;
  elapsedSec: number;
  onClose: () => void;
};

const MAX_RENDER_SEGMENTS = 12000;
const DEFAULT_POS = { x: 20, y: 110 };

export function GcodeLivePreviewModal({
  open,
  gcode,
  sentLine,
  totalLines,
  estimatedTotalSec,
  elapsedSec,
  onClose,
}: Props) {
  const { motions } = useMemo(() => parseGcodeStats(gcode), [gcode]);
  const [zoom, setZoom] = useState(1);
  const [show3d, setShow3d] = useState(true);
  const [pos, setPos] = useState(DEFAULT_POS);
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null);

  const extents = useMemo(() => {
    if (motions.length === 0) return { minX: 0, maxX: 100, minY: 0, maxY: 100 };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const seg of motions) {
      minX = Math.min(minX, seg.x1, seg.x2);
      minY = Math.min(minY, seg.y1, seg.y2);
      maxX = Math.max(maxX, seg.x1, seg.x2);
      maxY = Math.max(maxY, seg.y1, seg.y2);
    }
    if (maxX - minX < 0.01) maxX = minX + 1;
    if (maxY - minY < 0.01) maxY = minY + 1;
    return { minX, maxX, minY, maxY };
  }, [motions]);

  const current = useMemo(() => {
    let x = extents.minX;
    let y = extents.minY;
    for (const seg of motions) {
      if (seg.sourceLine <= sentLine) {
        x = seg.x2;
        y = seg.y2;
      } else {
        break;
      }
    }
    return { x, y };
  }, [motions, sentLine, extents.minX, extents.minY]);

  if (!open) return null;

  const width = extents.maxX - extents.minX;
  const height = extents.maxY - extents.minY;
  const donePct = totalLines > 0 ? Math.min(100, Math.round((sentLine / totalLines) * 100)) : 0;
  const remain = Math.max(0, estimatedTotalSec - elapsedSec);
  const zSpread = Math.max(
    1,
    motions.reduce((max, m) => Math.max(max, Math.abs(m.z1), Math.abs(m.z2)), 1),
  );
  const proj = (x: number, y: number, z: number) => {
    if (!show3d) return { x, y };
    const isoX = x + y * 0.28;
    const isoY = y * 0.72 + (z / zSpread) * 40;
    return { x: isoX, y: isoY };
  };

  useEffect(() => {
    if (!open) return;
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current || dragRef.current.id !== ev.pointerId) return;
      setPos({
        x: Math.max(8, ev.clientX - dragRef.current.dx),
        y: Math.max(8, ev.clientY - dragRef.current.dy),
      });
    };
    const onUp = (ev: PointerEvent) => {
      if (dragRef.current?.id === ev.pointerId) {
        dragRef.current = null;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [open]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        className="pointer-events-auto absolute w-[min(48rem,calc(100vw-1rem))] rounded-xl border border-white/15 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-sm"
        style={{ left: pos.x, top: pos.y }}
      >
        <div
          className="mb-3 flex cursor-move items-center justify-between"
          onPointerDown={(ev) => {
            const rect = (ev.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
            dragRef.current = { id: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
          }}
        >
          <div>
            <p className="text-sm font-semibold text-white">Live carve preview</p>
            <p className="text-xs text-slate-400">
              Draggable tracker using parsed G-code motion and feed
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShow3d((s) => !s)}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              {show3d ? "3D view" : "2D view"}
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(6, z * 1.25))}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              Zoom +
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.45, z / 1.25))}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              Zoom -
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-500/80 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
            >
              Hide
            </button>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-200 sm:grid-cols-4">
          <span>
            Line: <strong className="text-teal-300">{sentLine}</strong> / {totalLines}
          </span>
          <span>
            Progress: <strong className="text-emerald-300">{donePct}%</strong>
          </span>
          <span>
            Est time: <strong className="text-sky-300">{formatDuration(estimatedTotalSec)}</strong>
          </span>
          <span>
            Remaining: <strong className="text-amber-300">{formatDuration(remain)}</strong>
          </span>
        </div>

        <div className="aspect-[16/10] w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/85">
          <svg
            viewBox={`${extents.minX} ${extents.minY} ${width / zoom} ${height / zoom}`}
            className="h-full w-full"
          >
            <g transform={`scale(1,-1) translate(0,${-(extents.minY + extents.maxY)})`}>
              {motions.map((seg, idx) => {
                const done = seg.sourceLine <= sentLine;
                const p1 = proj(seg.x1, seg.y1, seg.z1);
                const p2 = proj(seg.x2, seg.y2, seg.z2);
                return (
                  <line
                    key={idx}
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    stroke={done ? (seg.rapid ? "#94a3b8" : "#14b8a6") : "#334155"}
                    strokeOpacity={done ? 1 : 0.35}
                    strokeWidth={Math.max(width, height) * 0.0032}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {(() => {
                const pc = proj(current.x, current.y, 0);
                return (
              <circle
                cx={pc.x}
                cy={pc.y}
                r={Math.max(width, height) * 0.012}
                fill="#f59e0b"
                stroke="#fef3c7"
                strokeWidth={Math.max(width, height) * 0.0018}
                vectorEffect="non-scaling-stroke"
              />
                );
              })()}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
