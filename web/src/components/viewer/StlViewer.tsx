"use client";

/**
 * STL viewer: drop in one STL or a whole set, see each one shaded like carved wood, zoom in,
 * move the light to bring out detail, check sizes, and send one to Simple carve.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ViewerMessage, ViewerRequest, ViewerResult } from "@/lib/viewer/viewer.worker";
import { putPendingDesign } from "@/lib/viewer/handoff";

const MM = 25.4;
/** Detail of the big view: pixels along the longest side. */
const LONG_SIDE_PX = 1600;

type Item = {
  id: string;
  name: string;
  bytes: number;
  file: File;
  state: "waiting" | "reading" | "ready" | "error";
  error?: string;
  map?: ViewerResult;
  thumb?: string;
  /** Chosen size (file units, usually mm); undefined = as saved in the file. */
  size?: Size;
  /** Keep proportions when changing the size (default on). */
  lock?: boolean;
};

type Size = { x: number; y: number; z: number };

type Light = { azimuth: number; height: number; relief: number };

/**
 * Shade a height map like carved wood, lit from `azimuth` (degrees, 0 = from the top).
 * `f` stretches the piece (width, height, depth factors) to show a resized version.
 */
function shade(m: ViewerResult, light: Light, scale = 1, f: Size = { x: 1, y: 1, z: 1 }): ImageData {
  const sx = scale * (f.x / f.y); // stretch the picture sideways by the width ÷ height change
  const W = Math.max(1, Math.round(m.w * sx)),
    H = Math.max(1, Math.round(m.h * scale));
  const img = new ImageData(W, H);
  const a = ((light.azimuth - 90) * Math.PI) / 180;
  const el = (light.height * Math.PI) / 180;
  const L = [Math.cos(a) * Math.cos(el), Math.sin(a) * Math.cos(el), Math.sin(el)];
  const range = m.zMax - m.zMin || 1;
  const gx = (light.relief * f.z) / f.x,
    gy = (light.relief * f.z) / f.y;
  for (let J = 0; J < H; J++) {
    const j = Math.min(m.h - 1, Math.floor(J / scale));
    for (let I = 0; I < W; I++) {
      const i = Math.min(m.w - 1, Math.floor(I / sx));
      const k = j * m.w + i;
      const o = (J * W + I) * 4;
      if (!m.mask[k]) {
        img.data[o] = 30;
        img.data[o + 1] = 41;
        img.data[o + 2] = 59;
        img.data[o + 3] = 255;
        continue;
      }
      const z = m.z[k];
      const zl = i > 0 && m.mask[k - 1] ? m.z[k - 1] : z;
      const zr = i < m.w - 1 && m.mask[k + 1] ? m.z[k + 1] : z;
      const zu = j > 0 && m.mask[k - m.w] ? m.z[k - m.w] : z;
      const zd = j < m.h - 1 && m.mask[k + m.w] ? m.z[k + m.w] : z;
      const nx = (-(zr - zl) / (2 * m.res)) * gx,
        ny = ((zd - zu) / (2 * m.res)) * gy;
      const nl = Math.hypot(nx, ny, 1);
      // Image rows go down, so the light's "up" is -y on screen.
      const lit = Math.max(0, (nx * L[0] - ny * L[1] + L[2]) / nl);
      const t = (z - m.zMin) / range;
      const s = (0.28 + 0.85 * lit) * (0.85 + 0.15 * t);
      img.data[o] = Math.min(255, 210 * s);
      img.data[o + 1] = Math.min(255, 145 * s);
      img.data[o + 2] = Math.min(255, 92 * s);
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function thumbOf(m: ViewerResult): string {
  const scale = Math.min(1, 150 / Math.max(m.w, m.h));
  const img = shade(m, { azimuth: 315, height: 40, relief: 1 }, scale);
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  cv.getContext("2d")!.putImageData(img, 0, 0);
  return cv.toDataURL();
}

const fmtSize = (mm: number) => `${(mm / MM).toFixed(2)} in (${mm.toFixed(1)} mm)`;
const fmtBytes = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

export function StlViewer() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [light, setLight] = useState<Light>({ azimuth: 315, height: 40, relief: 1 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const exportsRef = useRef(new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>());

  // One background worker reads the files one after another.
  useEffect(() => {
    const w = new Worker(new URL("../../lib/viewer/viewer.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<ViewerMessage>) => {
      const msg = ev.data;
      if (msg.type === "exported") {
        exportsRef.current.get(msg.id)?.resolve(msg.stl);
        exportsRef.current.delete(msg.id);
      } else if (msg.type === "error" && exportsRef.current.has(msg.id)) {
        exportsRef.current.get(msg.id)?.reject(new Error(msg.message));
        exportsRef.current.delete(msg.id);
      } else if (msg.type === "done") {
        const thumb = thumbOf(msg.result);
        setItems((list) => list.map((it) => (it.id === msg.result.id ? { ...it, state: "ready", map: msg.result, thumb } : it)));
      } else setItems((list) => list.map((it) => (it.id === msg.id ? { ...it, state: "error", error: msg.message } : it)));
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  // Start the next file when nothing is being read.
  useEffect(() => {
    if (items.some((it) => it.state === "reading")) return;
    const next = items.find((it) => it.state === "waiting");
    if (!next || !workerRef.current) return;
    const w = workerRef.current;
    void next.file.arrayBuffer().then((buffer) => {
      const req: ViewerRequest = { type: "view", id: next.id, buffer, longSidePx: LONG_SIDE_PX };
      w.postMessage(req, [buffer]);
    });
    setItems((list) => list.map((it) => (it.id === next.id ? { ...it, state: "reading" } : it)));
  }, [items]);

  const current = items.find((it) => it.id === selected) ?? null;
  const map = current?.map ?? null;
  const size = current?.size ?? map?.size ?? null;
  const resized =
    !!map && !!current?.size && (["x", "y", "z"] as const).some((a) => Math.abs(current.size![a] - map.size[a]) > 1e-6);
  const factors: Size = map && size ? { x: size.x / map.size.x, y: size.y / map.size.y, z: size.z / map.size.z } : { x: 1, y: 1, z: 1 };
  const fKey = `${factors.x.toFixed(4)},${factors.y.toFixed(4)},${factors.z.toFixed(4)}`;

  // Draw the big view whenever the piece or the light changes.
  useEffect(() => {
    if (!map || !canvasRef.current) return;
    const cv = canvasRef.current;
    const [fx, fy, fz] = fKey.split(",").map(Number);
    const img = shade(map, light, 1, { x: fx, y: fy, z: fz });
    cv.width = img.width;
    cv.height = img.height;
    cv.getContext("2d")!.putImageData(img, 0, 0);
  }, [map, light, fKey]);

  const setSize = (axis: keyof Size, value: number) => {
    if (!current || !map || !size || !(value > 0)) return;
    const lock = current.lock ?? true;
    const next: Size = lock
      ? { x: size.x * (value / size[axis]), y: size.y * (value / size[axis]), z: size.z * (value / size[axis]) }
      : { ...size, [axis]: value };
    setItems((list) => list.map((it) => (it.id === current.id ? { ...it, size: next } : it)));
  };

  /** The model at the chosen size, as a binary STL (made in the background). */
  const resizedStl = async (): Promise<ArrayBuffer> => {
    if (!current || !map || !size || !workerRef.current) throw new Error("Not ready");
    const buffer = await current.file.arrayBuffer();
    const id = `${current.id}:export`;
    const done = new Promise<ArrayBuffer>((resolve, reject) => exportsRef.current.set(id, { resolve, reject }));
    const req: ViewerRequest = { type: "export", id, buffer, size };
    workerRef.current.postMessage(req, [buffer]);
    return done;
  };

  const saveStl = async () => {
    if (!current || !size) return;
    setBusy("Making the STL…");
    try {
      const stl = await resizedStl();
      const url = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${current.name} ${(size.x / MM).toFixed(2)}x${(size.y / MM).toFixed(2)}in.stl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
      setBusy(null);
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const added: Item[] = [...files]
      .filter((f) => /\.stl$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`, name: f.name.replace(/\.stl$/i, ""), bytes: f.size, file: f, state: "waiting" }));
    if (!added.length) return;
    setItems((list) => [...list, ...added]);
    if (!selected) setSelected(added[0].id);
  };

  const choose = (id: string) => {
    setSelected(id);
    setView({ zoom: 1, x: 0, y: 0 });
  };

  const carveThis = async () => {
    if (!current?.map) return;
    setBusy("Opening in Simple carve…");
    try {
      if (resized && size) {
        // Resized: open it at exactly this size.
        await putPendingDesign({ name: current.name, stl: await resizedStl(), heightMm: size.y });
      } else {
        const stl = current.map.binary ?? (await current.file.arrayBuffer());
        await putPendingDesign({ name: current.name, stl });
      }
      router.push("/");
    } catch {
      setBusy(null);
    }
  };

  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.min(12, Math.max(1, v.zoom * f)) }));

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-6">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">STL viewer</h1>
            <p className="text-sm text-slate-400">See your relief files the way they&apos;ll carve.</p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:border-teal-500/60 hover:text-white"
          >
            ← Simple carve
          </Link>
        </header>

        <label
          className="mb-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-slate-900/60 px-4 py-5 text-center hover:border-teal-500/60"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
        >
          <span className="text-sm font-medium text-white">Choose STL files (one, or select several at once)</span>
          <span className="mt-1 text-xs text-slate-400">or drag them here. Files stay on this computer.</span>
          <input type="file" accept=".stl" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        </label>

        {items.length > 0 && (
          <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => choose(it.id)}
                className={`flex w-28 shrink-0 flex-col items-center rounded-lg border p-1.5 ${it.id === selected ? "border-teal-400 bg-teal-900/30" : "border-white/10 hover:border-teal-500/60"}`}
              >
                <div className="flex h-24 w-full items-center justify-center">
                  {it.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.thumb} alt={it.name} className="max-h-24 max-w-full" />
                  ) : (
                    <span className="text-[11px] text-slate-400">{it.state === "error" ? "Couldn't read" : it.state === "reading" ? "Reading…" : "Waiting…"}</span>
                  )}
                </div>
                <span className="mt-1 line-clamp-2 text-center text-[11px] leading-tight text-slate-300">{it.name}</span>
              </button>
            ))}
          </div>
        )}

        {current && (
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-900" style={{ height: "74vh" }}>
              {!map && (
                <p className="p-10 text-center text-sm text-slate-400">
                  {current.state === "error" ? `Couldn't read this file: ${current.error}` : "Reading the file…"}
                </p>
              )}
              {map && (
                <div
                  className="absolute inset-0 flex cursor-grab items-center justify-center active:cursor-grabbing"
                  onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
                  onPointerDown={(e) => {
                    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const d = dragRef.current;
                    if (d) setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
                  }}
                  onPointerUp={() => (dragRef.current = null)}
                >
                  <canvas
                    ref={canvasRef}
                    className="max-h-full max-w-full select-none"
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "center" }}
                  />
                </div>
              )}
              {map && (
                <div className="absolute bottom-3 right-3 flex gap-1.5">
                  <button type="button" onClick={() => zoomBy(1.4)} className="h-9 w-9 rounded-lg bg-slate-800/90 text-lg text-white hover:bg-slate-700">
                    +
                  </button>
                  <button type="button" onClick={() => zoomBy(1 / 1.4)} className="h-9 w-9 rounded-lg bg-slate-800/90 text-lg text-white hover:bg-slate-700">
                    −
                  </button>
                  <button type="button" onClick={() => setView({ zoom: 1, x: 0, y: 0 })} className="h-9 rounded-lg bg-slate-800/90 px-3 text-xs text-white hover:bg-slate-700">
                    Fit
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <h2 className="break-words text-base font-semibold text-white">{current.name}</h2>
                {map ? (
                  <dl className="mt-2 space-y-1 text-sm">
                    <Row k="Size in the file" v={`${(map.size.x / MM).toFixed(2)} × ${(map.size.y / MM).toFixed(2)} × ${(map.size.z / MM).toFixed(2)} in`} />
                    <Row k="Detail" v={`${map.triangles.toLocaleString()} triangles`} />
                    <Row k="File" v={`${fmtBytes(current.bytes)}${map.text ? " (text STL)" : ""}`} />
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">{current.state === "error" ? current.error : "Reading…"}</p>
                )}
                {map?.note && <p className="mt-2 text-xs text-slate-400">{map.note}</p>}
              </section>

              {map && size && (
                <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                  <h2 className="mb-1 text-sm font-semibold text-white">Size</h2>
                  <label className="mt-1 flex items-center gap-2 text-sm text-slate-200">
                    <input
                      type="checkbox"
                      className="accent-teal-500"
                      checked={current.lock ?? true}
                      onChange={(e) => setItems((list) => list.map((it) => (it.id === current.id ? { ...it, lock: e.target.checked } : it)))}
                    />
                    Keep proportions
                  </label>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <InchField key={`h${fKey}`} label="Height" mm={size.y} onChange={(v) => setSize("y", v)} />
                    <InchField key={`w${fKey}`} label="Width" mm={size.x} onChange={(v) => setSize("x", v)} />
                    <InchField key={`d${fKey}`} label="Depth" mm={size.z} onChange={(v) => setSize("z", v)} />
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {fmtSize(size.y)} tall · {fmtSize(size.x)} wide · {fmtSize(size.z)} deep
                  </p>
                  {resized && (
                    <button
                      type="button"
                      onClick={() => setItems((list) => list.map((it) => (it.id === current.id ? { ...it, size: undefined } : it)))}
                      className="mt-2 text-xs text-teal-300 underline"
                    >
                      Back to the size in the file
                    </button>
                  )}
                </section>
              )}

              {map && (
                <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                  <h2 className="mb-1 text-sm font-semibold text-white">Light</h2>
                  <Slider label="Direction" value={light.azimuth} min={0} max={359} step={1} show={(v) => `${v}°`} onChange={(azimuth) => setLight((l) => ({ ...l, azimuth }))} />
                  <Slider
                    label="Height (low shows fine detail)"
                    value={light.height}
                    min={5}
                    max={85}
                    step={1}
                    show={(v) => `${v}°`}
                    onChange={(height) => setLight((l) => ({ ...l, height }))}
                  />
                  <Slider
                    label="Exaggerate relief (view only)"
                    value={light.relief}
                    min={0.5}
                    max={4}
                    step={0.1}
                    show={(v) => `${v.toFixed(1)}×`}
                    onChange={(relief) => setLight((l) => ({ ...l, relief }))}
                  />
                  <button
                    type="button"
                    onClick={() => setLight({ azimuth: 315, height: 40, relief: 1 })}
                    className="mt-2 text-xs text-teal-300 underline"
                  >
                    Reset light
                  </button>
                </section>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!map || !!busy}
                  onClick={() => void carveThis()}
                  className="rounded-xl bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
                >
                  {busy ?? "Carve this →"}
                </button>
                <button
                  type="button"
                  disabled={!map || !!busy}
                  onClick={() => void saveStl()}
                  className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-200 hover:border-teal-500/60 disabled:opacity-50"
                >
                  Save STL
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setItems((list) => list.filter((it) => it.id !== current.id));
                    setSelected(items.find((it) => it.id !== current.id)?.id ?? null);
                  }}
                  className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300 hover:border-rose-400/60"
                >
                  Remove from list
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Number box in inches (mm shown under it); commits on Enter or leaving the box. */
function InchField({ label, mm, onChange }: { label: string; mm: number; onChange: (mm: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onChange(v * MM);
    setDraft(null);
  };
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <div className="mt-1 flex items-center rounded-lg border border-white/15 bg-slate-950 focus-within:border-teal-500">
        <input
          inputMode="decimal"
          value={draft ?? (mm / MM).toFixed(2)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-full min-w-0 bg-transparent px-2 py-1.5 text-sm text-white outline-none"
        />
        <span className="pr-2 text-xs text-slate-500">in</span>
      </div>
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{k}</dt>
      <dd className="text-right text-slate-100">{v}</dd>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  show,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="mt-3 block text-xs text-slate-400">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-slate-200">{show(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-teal-500" />
    </label>
  );
}
