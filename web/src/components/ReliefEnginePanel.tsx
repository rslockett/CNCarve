"use client";

import { useAppState } from "@/context/AppState";
import type { ReliefPreview, ReliefResult } from "@/lib/relief/reliefCam";
import type { ReliefWorkerMessage, ReliefWorkerRequest } from "@/lib/relief/relief.worker";
import { deriveReliefSettings } from "@/lib/relief/settings";
import { buildStlForKiri, reliefThicknessAxis } from "@/lib/stockTransform";
import { formatDuration } from "@/lib/gcodeStats";
import { isPatternSizeReady } from "@/lib/wizard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenSetup: () => void;
  /** Put one job's G-code into the machine panel. */
  onLoadJob: (gcode: string, title: string) => void;
};

type RunState =
  | { kind: "idle" }
  | { kind: "running"; fraction: number; label: string }
  | { kind: "error"; message: string }
  | { kind: "done"; result: ReliefResult; key: string };

const DONE_KEY = "cncarve:reliefJobsDone";

function loadDone(key: string): Record<string, boolean> {
  try {
    const all = JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}");
    return all[key] ?? {};
  } catch {
    return {};
  }
}
function saveDone(key: string, v: Record<string, boolean>) {
  try {
    const all = JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}");
    all[key] = v;
    localStorage.setItem(DONE_KEY, JSON.stringify(all));
  } catch {
    /* private mode etc. — ticks just won't persist */
  }
}

/** Shaded "wood" rendering of a height map, cropped to the machined area. */
function drawRelief(canvas: HTMLCanvasElement, p: ReliefPreview, which: "target" | "carved") {
  const z = which === "target" ? p.target : p.carved;
  let i0 = p.width,
    i1 = 0,
    j0 = p.height,
    j1 = 0;
  for (let j = 0; j < p.height; j++)
    for (let i = 0; i < p.width; i++)
      if (p.work[j * p.width + i]) {
        i0 = Math.min(i0, i);
        i1 = Math.max(i1, i);
        j0 = Math.min(j0, j);
        j1 = Math.max(j1, j);
      }
  if (i1 < i0) return;
  const cw = i1 - i0 + 1,
    ch = j1 - j0 + 1;
  const scale = Math.min(1, 520 / Math.max(cw, ch));
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
      // row 0 of the map is the front of the board → draw it at the bottom
      const j = j1 - Math.floor(y / scale);
      const o = (y * W + x) * 4;
      if (!p.work[j * p.width + i]) {
        img.data[o] = 30;
        img.data[o + 1] = 41;
        img.data[o + 2] = 59;
        img.data[o + 3] = 255;
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
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ReliefEnginePanel({ open, onClose, onOpenSetup, onLoadJob }: Props) {
  const { answers, stlBuffer } = useAppState();
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [done, setDone] = useState<Record<string, boolean>>({});
  const workerRef = useRef<Worker | null>(null);
  const targetCanvas = useRef<HTMLCanvasElement>(null);
  const carvedCanvas = useRef<HTMLCanvasElement>(null);

  /** Everything the engine needs, or a plain-English reason it can't run yet. */
  const prepared = useMemo(() => {
    if (!stlBuffer?.byteLength || !answers.stlFileName)
      return { error: "Choose an STL file in Setup first." } as const;
    if (!isPatternSizeReady(answers))
      return { error: "Set the carved size in Setup first." } as const;
    try {
      const built = buildStlForKiri(stlBuffer, answers);
      if (reliefThicknessAxis(built.finalSize) !== "z")
        return {
          error:
            "This model's carved face points sideways. Re-export the STL with the relief facing up (its thinnest side along Z).",
        } as const;
      const settings = deriveReliefSettings(answers, built.finalSize);
      const key = [
        answers.stlFileName,
        built.finalSize.x.toFixed(2),
        built.finalSize.y.toFixed(2),
        built.finalSize.z.toFixed(2),
        JSON.stringify(settings),
      ].join("|");
      return { built, settings, key } as const;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [answers, stlBuffer]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const start = useCallback(() => {
    if ("error" in prepared) return;
    workerRef.current?.terminate();
    const w = new Worker(new URL("../lib/relief/relief.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    setRun({ kind: "running", fraction: 0, label: "Starting" });
    const key = prepared.key;
    w.onmessage = (ev: MessageEvent<ReliefWorkerMessage>) => {
      const m = ev.data;
      if (m.type === "progress") setRun({ kind: "running", fraction: m.fraction, label: m.label });
      else if (m.type === "error") {
        setRun({ kind: "error", message: m.message });
        w.terminate();
      } else {
        setDone(loadDone(key));
        setRun({ kind: "done", result: m.result, key });
        w.terminate();
      }
    };
    w.onerror = (ev) => setRun({ kind: "error", message: ev.message || "The engine stopped unexpectedly." });
    const req: ReliefWorkerRequest = {
      vertices: prepared.built.vertices.slice(),
      bit: prepared.settings.bit,
      params: prepared.settings.params,
      placement: prepared.settings.placement,
    };
    w.postMessage(req, [req.vertices.buffer]);
  }, [prepared]);

  const result = run.kind === "done" ? run.result : null;
  const stale = run.kind === "done" && !("error" in prepared) && run.key !== prepared.key;

  useEffect(() => {
    if (!result || !open) return;
    if (targetCanvas.current) drawRelief(targetCanvas.current, result.preview, "target");
    if (carvedCanvas.current) drawRelief(carvedCanvas.current, result.preview, "carved");
  }, [result, open]);

  const toggleDone = (file: string) => {
    if (run.kind !== "done") return;
    const next = { ...done, [file]: !done[file] };
    setDone(next);
    saveDone(run.key, next);
  };

  if (!open || typeof document === "undefined") return null;

  const s = result?.summary;
  const centred = answers.patternPlacement === "center";
  const thinBoard = s ? answers.stockThicknessMm < s.cutDepthMm + 1 : false;
  const nextJob = result?.jobs.find((j) => !done[j.fileName]);

  const panel = (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-slate-950/75 p-4 backdrop-blur-md md:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="relief-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[min(calc(100dvh-2rem),60rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/95 text-slate-100 shadow-2xl ring-1 ring-teal-500/20">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-teal-400/90">
              One bit · layered · short jobs
            </p>
            <h2 id="relief-title" className="mt-1 text-lg font-semibold text-white">
              Carve with the CNCarve engine
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Removes wood in shallow layers before the detail pass, so the bit is never buried.
              Each job is short and can simply be run again if anything stops.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-1 text-sm text-slate-400 hover:bg-white/10 hover:text-white"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {"error" in prepared ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-3 text-sm text-amber-100">
              {prepared.error}{" "}
              <button type="button" onClick={onOpenSetup} className="underline">
                Open Setup
              </button>
            </div>
          ) : (
            <section className="grid gap-2 rounded-xl border border-white/10 bg-slate-950/40 p-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-400">Bit: </span>
                {prepared.settings.bitLabel}
              </div>
              <div>
                <span className="text-slate-400">Wood: </span>
                {prepared.settings.materialLabel}
              </div>
              <div>
                <span className="text-slate-400">Carved size: </span>
                {prepared.built.finalSize.x.toFixed(1)} × {prepared.built.finalSize.y.toFixed(1)} mm,{" "}
                {prepared.built.finalSize.z.toFixed(1)} mm deep
              </div>
              <div>
                <span className="text-slate-400">Board: </span>
                {answers.stockWidthMm.toFixed(0)} × {answers.stockDepthMm.toFixed(0)} ×{" "}
                {answers.stockThicknessMm.toFixed(1)} mm
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={start}
                  disabled={run.kind === "running"}
                  className="rounded-xl bg-gradient-to-r from-teal-500 to-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-60"
                >
                  {run.kind === "done" ? "Make toolpaths again" : "Make toolpaths"}
                </button>
                <button
                  type="button"
                  onClick={onOpenSetup}
                  className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-200 hover:bg-white/5"
                >
                  Change settings
                </button>
                {stale && (
                  <span className="text-xs text-amber-200">
                    Settings changed since these toolpaths were made — make them again.
                  </span>
                )}
              </div>
            </section>
          )}

          {run.kind === "running" && (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full bg-teal-500 transition-[width]"
                  style={{ width: `${Math.round(run.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-400">{run.label}…</p>
            </div>
          )}

          {run.kind === "error" && (
            <p className="rounded-xl border border-red-500/40 bg-red-950/40 p-3 text-sm text-red-100">
              {run.message}
            </p>
          )}

          {result && s && (
            <>
              <section className="grid grid-cols-2 gap-3">
                <figure className="text-center">
                  <canvas ref={targetCanvas} className="mx-auto max-h-80 w-auto max-w-full rounded-lg" />
                  <figcaption className="mt-1 text-xs text-slate-400">Your design</figcaption>
                </figure>
                <figure className="text-center">
                  <canvas ref={carvedCanvas} className="mx-auto max-h-80 w-auto max-w-full rounded-lg" />
                  <figcaption className="mt-1 text-xs text-slate-400">
                    Simulated result with your bit
                  </figcaption>
                </figure>
              </section>

              <section className="grid gap-2 text-sm sm:grid-cols-3">
                <Stat
                  label="Total carving time"
                  value={`about ${formatDuration(Math.round(s.totalMinutes) * 60).replace(/ 0s$/, "")}`}
                />
                <Stat label="Deepest cut" value={`${s.cutDepthMm.toFixed(1)} mm`} />
                <Stat
                  label="Detail match"
                  value={`${s.accuracyPct.toFixed(0)}% within 0.15 mm`}
                />
              </section>

              {s.problems.length === 0 ? (
                <p className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 text-sm text-emerald-100">
                  ✓ Every line checked for GRBL · ✓ no cutting into the design (worst{" "}
                  {s.maxGougeMm.toFixed(2)} mm) · ✓ longest job{" "}
                  {Math.round(Math.max(...result.jobs.map((j) => j.estMinutes)))} min
                </p>
              ) : (
                <ul className="space-y-1 rounded-xl border border-red-500/40 bg-red-950/40 p-3 text-sm text-red-100">
                  {s.problems.map((p) => (
                    <li key={p}>⚠ {p}</li>
                  ))}
                </ul>
              )}
              {thinBoard && (
                <p className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-3 text-sm text-amber-100">
                  Your board is {answers.stockThicknessMm.toFixed(1)} mm thick but the deepest cut is{" "}
                  {s.cutDepthMm.toFixed(1)} mm. Use a board at least {Math.ceil(s.cutDepthMm + 2)} mm thick.
                </p>
              )}

              <section className="rounded-xl border border-white/10 bg-slate-950/40 p-3 text-sm">
                <h3 className="font-semibold text-white">Before the first job</h3>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
                  <li>
                    Put in the <strong>{prepared && !("error" in prepared) ? prepared.settings.bitLabel : "bit"}</strong>.
                    You won&apos;t change it for the whole carving.
                  </li>
                  <li>Home the machine.</li>
                  <li>
                    {centred ? (
                      <>
                        Jog to the <strong>centre of the board</strong> (draw corner-to-corner pencil
                        lines) and set X and Y zero there.
                      </>
                    ) : (
                      <>
                        Jog to the <strong>front-left corner of the board</strong> and set X and Y
                        zero there.
                      </>
                    )}
                  </li>
                  <li>
                    Set Z zero on the <strong>top of the board</strong> with the probe.
                  </li>
                  <li>
                    Run the dry run first (spindle stays off) and watch that it stays on the wood and
                    away from clamps.
                  </li>
                </ol>
                <p className="mt-2 text-xs text-slate-400">
                  If a job stops: don&apos;t touch your zero. Home the machine, load the same job and
                  run it again from the start — the finished part is cut in the air, then it carries
                  on.
                </p>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Jobs — run them in this order</h3>
                  <button
                    type="button"
                    onClick={() =>
                      result.jobs.forEach((j, i) =>
                        setTimeout(() => downloadText(j.fileName, j.gcode), i * 400),
                      )
                    }
                    className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/5"
                  >
                    Download all
                  </button>
                </div>
                <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
                  {result.jobs.map((j, idx) => {
                    const isNext = nextJob?.fileName === j.fileName;
                    return (
                      <li
                        key={j.fileName}
                        className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${isNext ? "bg-teal-950/40" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={!!done[j.fileName]}
                          onChange={() => toggleDone(j.fileName)}
                          aria-label={`Mark ${j.title} done`}
                          className="h-4 w-4 accent-teal-500"
                        />
                        <span className="w-6 text-slate-500">{idx}</span>
                        <span className={`min-w-0 flex-1 ${done[j.fileName] ? "text-slate-500 line-through" : ""}`}>
                          {j.title}
                          {isNext && <span className="ml-2 text-xs text-teal-300">next</span>}
                        </span>
                        <span className="w-16 text-right text-xs text-slate-400">
                          {j.kind === "dry_run" ? "1 min" : `~${Math.round(j.estMinutes)} min`}
                        </span>
                        <button
                          type="button"
                          onClick={() => onLoadJob(j.gcode, j.title)}
                          className="rounded-lg bg-teal-700/90 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-600"
                        >
                          Load into machine
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadText(j.fileName, j.gcode)}
                          className="rounded-lg border border-white/15 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
                          title={`Download ${j.fileName}`}
                        >
                          ↓
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-slate-400">
                  Finish every roughing job before starting the detail jobs. Vacuum the chips between
                  jobs. Afterwards, saw along the groove around the design.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="font-medium text-white">{value}</div>
    </div>
  );
}
