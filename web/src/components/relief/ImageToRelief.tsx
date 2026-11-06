"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DepthMap, DepthMessage, DepthRequest } from "@/lib/imageRelief/depth.worker";
import { putPendingDesign } from "@/lib/imageRelief/handoff";
import type { ReliefJob, ReliefJobResult } from "@/lib/imageRelief/imageRelief.worker";
import {
  DEFAULT_PARAMS,
  detectTilt,
  gridFor,
  luminance,
  type OutlineShape,
  type ReliefMode,
  type ReliefParams,
} from "@/lib/imageRelief/relief";

const MM = 25.4;
type Units = "in" | "mm";

/** Starting values for each kind of picture (depth, base and shape are kept when switching). */
const MODE_DEFAULTS: Record<ReliefMode, Pick<ReliefParams, "detail" | "flatten" | "smooth" | "background" | "shape">> = {
  // Photos of a carved piece: follow the piece's own outline.
  photo: { detail: 0.15, flatten: 0.4, smooth: 0.1, background: 0.05, shape: "cutout" },
  // Drawings: a plain shape (tracing "its own" outline could drop letters that aren't joined up).
  drawing: { detail: 0.6, flatten: 0, smooth: 0.15, background: 0.1, shape: "rectangle" },
};
/** The AI passes: overall shape, plus a high-resolution pass for lettering and fine borders. */
const PASSES = { standard: [518], high: [518, 1036] } as const;
type Quality = keyof typeof PASSES;

type Crop = { x: number; y: number; w: number; h: number };
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

type Picture = { name: string; bitmap: ImageBitmap; id: number };
type Depth =
  | { kind: "none" }
  | { kind: "running"; fraction: number; label: string }
  | { kind: "error"; message: string }
  | { kind: "done"; key: string; maps: DepthMap[]; seconds: number };

function loadUnits(): Units {
  try {
    return (JSON.parse(localStorage.getItem("cncarve:simplePrefs") ?? "null")?.units as Units) ?? "in";
  } catch {
    return "in";
  }
}

/** The picture turned/mirrored, then cropped, drawn no bigger than `maxSide` (or exactly w × h). */
/** Average colour around the picture's edge (fills the corners uncovered by straightening). */
const edgeColour = new WeakMap<ImageBitmap, string>();
function borderColour(bmp: ImageBitmap): string {
  const hit = edgeColour.get(bmp);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0, 64, 64);
  const d = x.getImageData(0, 0, 64, 64).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < 64; i++)
    for (const [px, py] of [[i, 0], [i, 63], [0, i], [63, i]]) {
      const o = (py * 64 + px) * 4;
      r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
    }
  const col = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  edgeColour.set(bmp, col);
  return col;
}

function drawPicture(
  bmp: ImageBitmap,
  rot: number,
  mirror: boolean,
  crop: Crop,
  size: { maxSide: number } | { w: number; h: number },
  angleDeg = 0,
): HTMLCanvasElement {
  const turned = rot % 2 === 1;
  const fw = turned ? bmp.height : bmp.width,
    fh = turned ? bmp.width : bmp.height;
  const full = document.createElement("canvas");
  full.width = fw;
  full.height = fh;
  const fc = full.getContext("2d")!;
  fc.fillStyle = borderColour(bmp);
  fc.fillRect(0, 0, fw, fh);
  fc.imageSmoothingQuality = "high";
  fc.translate(fw / 2, fh / 2);
  fc.rotate((rot * Math.PI) / 2 + (angleDeg * Math.PI) / 180);
  if (mirror) fc.scale(-1, 1);
  fc.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  const sx = crop.x * fw,
    sy = crop.y * fh,
    sw = crop.w * fw,
    sh = crop.h * fh;
  let W: number, H: number;
  if ("w" in size) {
    W = size.w;
    H = size.h;
  } else {
    const k = Math.min(1, size.maxSide / Math.max(sw, sh));
    W = Math.max(1, Math.round(sw * k));
    H = Math.max(1, Math.round(sh * k));
  }
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const oc = out.getContext("2d", { willReadFrequently: true })!;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(full, sx, sy, sw, sh, 0, 0, W, H);
  return out;
}

export function ImageToRelief() {
  const router = useRouter();
  const [units, setUnits] = useState<Units>("in");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUnits(loadUnits());
  }, []);
  const [pic, setPic] = useState<Picture | null>(null);
  const [picError, setPicError] = useState<string | null>(null);
  const [rot, setRot] = useState(0);
  const [mirror, setMirror] = useState(false);
  const [crop, setCrop] = useState<Crop>(FULL);
  /** Fine straightening (degrees), on top of the 90° turns. */
  const [angle, setAngle] = useState(0);
  const [autoAngle, setAutoAngle] = useState<number | null>(null);
  const [quality, setQuality] = useState<Quality>("high");
  /** The picture/crop the user asked the AI to work on ("Make the relief"). */
  const [asked, setAsked] = useState("");
  const [params, setParams] = useState<ReliefParams>(DEFAULT_PARAMS);
  const [heightMm, setHeightMm] = useState(3 * MM);
  const [depth, setDepth] = useState<Depth>({ kind: "none" });
  const [preview, setPreview] = useState<{ rgba: Uint8ClampedArray; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState<null | "download" | "carve">(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stlInfo, setStlInfo] = useState<string | null>(null);

  const fmt = (mm: number) => (units === "in" ? `${(mm / MM).toFixed(2)} in` : `${mm.toFixed(1)} mm`);

  // Size of the cropped picture → aspect ratio of the carving.
  const turned = rot % 2 === 1;
  const fw = pic ? (turned ? pic.bitmap.height : pic.bitmap.width) : 1;
  const fh = pic ? (turned ? pic.bitmap.width : pic.bitmap.height) : 1;
  const aspect = (crop.w * fw) / (crop.h * fh);
  const grid = gridFor(aspect, heightMm);
  const widthMm = heightMm * aspect;
  const picKey = pic ? [pic.id, rot, mirror, angle, crop.x, crop.y, crop.w, crop.h, quality].join("|") : "";

  // ---- AI depth (photo mode): run once per picture/crop, in its own worker. ----
  // The worker stays alive so the model is only loaded once; a newer request makes older
  // answers stale (they are ignored).
  const depthWorker = useRef<Worker | null>(null);
  const depthRun = useRef(0);
  useEffect(() => {
    if (!pic || params.mode !== "photo" || !asked || asked !== picKey) return;
    if (depth.kind === "done" && depth.key === picKey) return;
    const timer = window.setTimeout(() => {
      if (!depthWorker.current)
        depthWorker.current = new Worker(new URL("../../lib/imageRelief/depth.worker.ts", import.meta.url), { type: "module" });
      const w = depthWorker.current;
      const run = ++depthRun.current;
      setDepth({ kind: "running", fraction: 0, label: "Getting ready" });
      const t0 = performance.now();
      w.onmessage = (ev: MessageEvent<DepthMessage>) => {
        if (run !== depthRun.current) return;
        const m = ev.data;
        if (m.type === "progress") setDepth({ kind: "running", fraction: m.fraction, label: m.label });
        else if (m.type === "error") setDepth({ kind: "error", message: m.message });
        else setDepth({ kind: "done", key: picKey, maps: m.maps, seconds: (performance.now() - t0) / 1000 });
      };
      w.onerror = (ev) => {
        setDepth({ kind: "error", message: ev.message || "The depth step stopped unexpectedly." });
        depthWorker.current?.terminate();
        depthWorker.current = null;
      };
      const c = drawPicture(pic.bitmap, rot, mirror, crop, { maxSide: 1600 }, angle);
      const img = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      const req: DepthRequest = { rgba: img.data, width: c.width, height: c.height, sides: [...PASSES[quality]] };
      w.postMessage(req, [img.data.buffer]);
    }, 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, params.mode]);
  useEffect(() => () => depthWorker.current?.terminate(), []);

  const depthReady = depth.kind === "done" && depth.key === picKey ? depth : null;
  const canBuild = !!pic && (params.mode === "drawing" || !!depthReady);

  // ---- Relief + preview / STL, in a second worker. ----
  const reliefWorker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const waiters = useRef(new Map<number, (r: ReliefJobResult) => void>());
  const worker = () => {
    if (!reliefWorker.current) {
      const w = new Worker(new URL("../../lib/imageRelief/imageRelief.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<ReliefJobResult>) => {
        const done = waiters.current.get(ev.data.id);
        waiters.current.delete(ev.data.id);
        done?.(ev.data);
      };
      reliefWorker.current = w;
    }
    return reliefWorker.current;
  };
  useEffect(() => () => reliefWorker.current?.terminate(), []);

  const runJob = (want: ReliefJob["want"], override: Partial<ReliefParams> = {}) =>
    new Promise<ReliefJobResult>((resolve) => {
      const id = ++jobId.current;
      const c = drawPicture(pic!.bitmap, rot, mirror, crop, { w: grid.w, h: grid.h }, angle);
      const img = c.getContext("2d")!.getImageData(0, 0, grid.w, grid.h);
      const lum = luminance(img.data, grid.w, grid.h);
      const job: ReliefJob = {
        id,
        want,
        lum,
        depth:
          params.mode === "photo" && depthReady
            ? depthReady.maps.map((m) => ({ data: m.data.slice(), width: m.width, height: m.height }))
            : null,
        grid,
        params: { ...params, ...override },
      };
      waiters.current.set(id, resolve);
      worker().postMessage(job, [lum.buffer, ...(job.depth ?? []).map((m) => m.data.buffer)]);
    });

  const previewKey = canBuild ? [picKey, JSON.stringify(params), grid.w, grid.h, !!depthReady].join("|") : "";
  useEffect(() => {
    if (!previewKey) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const r = await runJob("preview");
      if (live && r.type === "preview") setPreview({ rgba: r.rgba, width: r.width, height: r.height });
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const makeStl = async (override: Partial<ReliefParams> = {}) => {
    setSaveError(null);
    const r = await runJob("stl", override);
    if (r.type === "error") throw new Error(r.message);
    if (r.type !== "stl") throw new Error("Unexpected result");
    setStlInfo(`${r.triangles.toLocaleString()} triangles, ${(r.stl.byteLength / 1e6).toFixed(1)} MB`);
    return r.stl;
  };
  const baseName = (pic?.name ?? "relief").replace(/\.[a-z0-9]+$/i, "") + " relief";

  const download = async () => {
    setBusy("download");
    try {
      const stl = await makeStl();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
      a.download = `${baseName}.stl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const carve = async () => {
    setBusy("carve");
    try {
      // Carving ignores the solid backing, so send only a thin one (keeps the board-thickness check honest).
      const stl = await makeStl({ baseMm: 0.3 });
      await putPendingDesign({ name: baseName, stl, heightMm });
      router.push("/");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setPicError(null);
    try {
      const bitmap = await createImageBitmap(f);
      setPic({ name: f.name, bitmap, id: Date.now() });
      setRot(0);
      setMirror(false);
      setCrop(FULL);
      // Straighten automatically when the picture is clearly a little crooked.
      const c = drawPicture(bitmap, 0, false, FULL, { maxSide: 500 });
      const small = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      const tilt = detectTilt(luminance(small.data, c.width, c.height), c.width, c.height);
      const fix = Math.abs(tilt) >= 0.4 ? Math.round(-tilt * 10) / 10 : 0;
      setAngle(fix);
      setAutoAngle(fix);
      setPreview(null);
      setStlInfo(null);
    } catch {
      setPicError("That file couldn't be opened as a picture. Try a JPG or PNG.");
    }
  };

  const set = (patch: Partial<ReliefParams>) => {
    setParams((p) => ({ ...p, ...patch }));
    setStlInfo(null);
  };
  const setMode = (mode: ReliefMode) => setParams((p) => ({ ...p, mode, ...MODE_DEFAULTS[mode] }));

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-6">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">Picture to relief</h1>
            <p className="text-sm text-slate-400">Turn a picture into a relief STL you can carve or keep.</p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:border-teal-500/60 hover:text-white"
          >
            ← Simple carve
          </Link>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <Card title="1. Choose a picture">
              <label
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-slate-900/60 px-4 py-6 text-center hover:border-teal-500/60"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void onFile(e.dataTransfer.files?.[0]);
                }}
              >
                <span className="text-sm font-medium text-white">{pic ? "Choose a different picture" : "Choose a picture"}</span>
                <span className="mt-1 text-xs text-slate-400">JPG or PNG — or drop it here</span>
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </label>
              {picError && <p className="mt-2 text-sm text-rose-300">{picError}</p>}
              {pic && (
                <div className="mt-3">
                  <CropBox pic={pic} rot={rot} mirror={mirror} angle={angle} crop={crop} onCrop={setCrop} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <SmallButton onClick={() => { setRot((r) => (r + 1) % 4); setCrop(FULL); }}>Turn 90°</SmallButton>
                    <SmallButton on={mirror} onClick={() => setMirror((m) => !m)}>Mirror</SmallButton>
                    <SmallButton onClick={() => setCrop(FULL)} disabled={crop === FULL}>Undo crop</SmallButton>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Drag across the picture to crop it — just around the piece, leaving out chains and beads.
                  </p>
                  {mirror && (
                    <p className="mt-1 text-xs text-amber-200">Mirrored: any lettering will read backwards.</p>
                  )}
                  <div className="mt-3">
                    <Slider
                      label="Straighten"
                      value={angle}
                      min={-20}
                      max={20}
                      step={0.1}
                      shown={`${angle > 0 ? "+" : ""}${angle.toFixed(1)}°`}
                      onChange={(v) => {
                        setAngle(v);
                        setCrop(FULL);
                      }}
                      hint={
                        autoAngle
                          ? `Straightened automatically by ${autoAngle > 0 ? "+" : ""}${autoAngle.toFixed(1)}°. Line the piece up with the grid if it still looks off.`
                          : "Line the piece up with the grid."
                      }
                    />
                    <div className="-mt-1 flex gap-2">
                      {autoAngle !== null && angle !== autoAngle && (
                        <SmallButton onClick={() => { setAngle(autoAngle); setCrop(FULL); }}>Auto</SmallButton>
                      )}
                      {angle !== 0 && <SmallButton onClick={() => { setAngle(0); setCrop(FULL); }}>Not turned</SmallButton>}
                    </div>
                  </div>
                </div>
              )}
            </Card>

            <Card title="2. What kind of picture is it?">
              <div className="grid grid-cols-2 gap-2">
                <Choice
                  on={params.mode === "photo"}
                  onClick={() => setMode("photo")}
                  title="Photo / statue"
                  hint="Photos of carvings, statues, faces. Shape found by AI on this computer."
                />
                <Choice
                  on={params.mode === "drawing"}
                  onClick={() => setMode("drawing")}
                  title="Drawing / line art"
                  hint="Line drawings, logos, clip art. Brightness becomes height."
                />
              </div>
              {params.mode === "photo" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">Detail:</span>
                  <SmallButton on={quality === "high"} onClick={() => setQuality("high")}>High — sharp lettering</SmallButton>
                  <SmallButton on={quality === "standard"} onClick={() => setQuality("standard")}>Standard — faster</SmallButton>
                </div>
              )}
              {params.mode === "photo" && (
                <p className="mt-2 text-xs text-slate-500">
                  Runs on this computer — free, no account, nothing is uploaded. The first time, it downloads the
                  depth model (about 100 MB) and keeps it.
                </p>
              )}
              {params.mode === "drawing" && (
                <div className="mt-3 flex gap-2 text-xs">
                  <span className="self-center text-slate-400">Raised parts:</span>
                  <SmallButton on={params.raised === "dark"} onClick={() => set({ raised: "dark" })}>Dark</SmallButton>
                  <SmallButton on={params.raised === "light"} onClick={() => set({ raised: "light" })}>Light</SmallButton>
                </div>
              )}
            </Card>

            <Card title="3. Size and shape">
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Height of the carving" mm={heightMm} units={units} onChange={setHeightMm} />
                <div className="text-xs text-slate-400">
                  Width
                  <p className="mt-1 py-2 text-sm text-slate-200">{fmt(widthMm)}</p>
                </div>
              </div>
              <div className="mt-2 flex gap-1 text-xs">
                {(["in", "mm"] as Units[]).map((x) => (
                  <SmallButton key={x} on={units === x} onClick={() => setUnits(x)}>
                    {x === "in" ? "Inches" : "Millimetres"}
                  </SmallButton>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Outline — “Its own” follows the piece in the photo (best for crosses and icons photographed on a plain
                background).
              </p>
              <div className="mt-1 grid grid-cols-5 gap-2">
                {(["cutout", "rectangle", "oval", "arch", "cross"] as OutlineShape[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set({ shape: s })}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-xs capitalize ${params.shape === s ? "border-teal-500 bg-teal-950/50 text-white" : "border-white/10 bg-slate-900/60 text-slate-300"}`}
                  >
                    <ShapeIcon shape={s} />
                    {s === "cutout" ? "Its own" : s}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="4. Adjust">
              <Slider
                label="Depth"
                value={params.depthMm}
                min={0.5}
                max={8}
                step={0.1}
                shown={fmt(params.depthMm)}
                onChange={(v) => set({ depthMm: v })}
                onReset={params.depthMm !== DEFAULT_PARAMS.depthMm ? () => set({ depthMm: DEFAULT_PARAMS.depthMm }) : undefined}
                hint="From the background to the highest point. 3 mm suits a 3-inch piece with a 20° V-bit."
              />
              <Slider
                label="Background"
                value={params.background}
                min={0}
                max={0.8}
                step={0.01}
                shown={`${Math.round(params.background * 100)}%`}
                onChange={(v) => set({ background: v })}
                hint="Raise it until the background is flat and only the figure stands up."
              />
              <Slider
                label="Flatten"
                value={params.flatten}
                min={0}
                max={1}
                step={0.01}
                shown={`${Math.round(params.flatten * 100)}%`}
                onChange={(v) => set({ flatten: v })}
                hint="Squeezes deep differences so it looks carved, while keeping the details."
              />
              <Slider
                label="Detail"
                value={params.detail}
                min={0}
                max={1}
                step={0.01}
                shown={`${Math.round(params.detail * 100)}%`}
                onChange={(v) => set({ detail: v })}
                hint={params.mode === "photo" ? "Fine texture from the photo: folds, hair, lettering." : "Crisper edges."}
              />
              <Slider
                label="Smooth"
                value={params.smooth}
                min={0}
                max={1}
                step={0.01}
                shown={`${Math.round(params.smooth * 100)}%`}
                onChange={(v) => set({ smooth: v })}
                hint="Removes grain and noise."
              />
              <Slider
                label="Base under the relief"
                value={params.baseMm}
                min={0.5}
                max={6}
                step={0.1}
                shown={fmt(params.baseMm)}
                onChange={(v) => set({ baseMm: v })}
                hint="Only for the STL file (3D printing, other software). Carving ignores it."
              />
              <button
                type="button"
                onClick={() => setParams((p) => ({ ...DEFAULT_PARAMS, mode: p.mode, raised: p.raised, ...MODE_DEFAULTS[p.mode], shape: p.shape }))}
                className="mt-1 text-xs text-slate-400 underline"
              >
                Reset all to default
              </button>
            </Card>
          </div>

          <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            <Card title="Preview">
              {!pic && <p className="text-sm text-slate-400">Choose a picture to see the relief here.</p>}
              {pic && params.mode === "photo" && !depthReady && depth.kind !== "running" && (
                <div className="mb-3">
                  <button
                    type="button"
                    onClick={() => setAsked(picKey)}
                    className="rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-500"
                  >
                    {preview ? "Update the relief" : "Make the relief"}
                  </button>
                  <p className="mt-1 text-xs text-slate-500">
                    {preview
                      ? "The picture changed (crop, straighten or detail). Press to work out the shape again."
                      : "Crop and straighten first, then press this."}{" "}
                    {quality === "high"
                      ? "High detail takes under a minute on a Mac, about 3–5 minutes on the Raspberry Pi."
                      : "Standard takes a few seconds on a Mac, under a minute on the Raspberry Pi."}
                  </p>
                </div>
              )}
              {pic && params.mode === "photo" && depth.kind === "running" && (
                <div className="mb-3">
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full bg-teal-500 transition-[width]" style={{ width: `${Math.round(depth.fraction * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{depth.label}…</p>
                </div>
              )}
              {pic && params.mode === "photo" && depth.kind === "error" && (
                <p className="mb-3 text-sm text-rose-300">
                  {depth.message} You can still use “Drawing / line art”, which doesn&apos;t need the depth model.
                </p>
              )}
              {preview && (canBuild || params.mode === "photo") && (
                <div className={canBuild ? "" : "opacity-40"}>
                  <PreviewCanvas preview={preview} />
                </div>
              )}
              {pic && params.mode === "photo" && depthReady && (
                <p className="mt-2 text-xs text-slate-500">Shape found in {Math.max(1, Math.round(depthReady.seconds))} s.</p>
              )}
              {canBuild && (
                <p className="mt-2 text-xs text-slate-400">
                  {fmt(widthMm)} wide × {fmt(heightMm)} tall, {fmt(params.depthMm)} deep. Shown lit from the upper left,
                  as carved wood.
                </p>
              )}
            </Card>

            <Card title="5. Use it">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canBuild || !!busy}
                  onClick={() => void carve()}
                  className="rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-500 disabled:opacity-40"
                >
                  {busy === "carve" ? "Getting it ready…" : "Carve this →"}
                </button>
                <button
                  type="button"
                  disabled={!canBuild || !!busy}
                  onClick={() => void download()}
                  className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-slate-100 hover:border-teal-500/60 disabled:opacity-40"
                >
                  {busy === "download" ? "Making the STL…" : "Download STL"}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {`“Carve this” opens Simple carve with this relief loaded at ${fmt(heightMm)} tall — then it's the usual steps: board, size, toolpaths, carve.`}
              </p>
              {stlInfo && <p className="mt-1 text-xs text-slate-400">STL: {stlInfo}, closed solid.</p>}
              {saveError && <p className="mt-2 text-sm text-rose-300">{saveError}</p>}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewCanvas({ preview }: { preview: { rgba: Uint8ClampedArray; width: number; height: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = preview.width;
    c.height = preview.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(preview.rgba), preview.width, preview.height), 0, 0);
  }, [preview]);
  return (
    <div>
      <div className={zoom ? "max-h-[75vh] overflow-auto rounded-lg" : ""}>
        <canvas
          ref={ref}
          aria-label="Relief preview"
          onClick={() => setZoom((z) => !z)}
          className={
            zoom
              ? "block max-w-none cursor-zoom-out bg-slate-950"
              : "mx-auto block max-h-[70vh] w-auto max-w-full cursor-zoom-in rounded-lg bg-slate-950"
          }
          style={zoom ? { width: preview.width * 1.5 } : { aspectRatio: `${preview.width} / ${preview.height}` }}
        />
      </div>
      <p className="mt-1 text-center text-[11px] text-slate-500">
        {zoom ? "Click to see the whole piece" : "Click the picture to look closer (check the lettering)"}
      </p>
    </div>
  );
}

/** The (turned/mirrored) picture with a drag-to-crop rectangle. */
function CropBox({
  pic,
  rot,
  mirror,
  angle,
  crop,
  onCrop,
}: {
  pic: Picture;
  rot: number;
  mirror: boolean;
  angle: number;
  crop: Crop;
  onCrop: (c: Crop) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => {
    const src = drawPicture(pic.bitmap, rot, mirror, FULL, { maxSide: 900 }, angle);
    const c = ref.current;
    if (!c) return;
    c.width = src.width;
    c.height = src.height;
    const x = c.getContext("2d")!;
    x.drawImage(src, 0, 0);
    // A light grid to line the piece up against.
    x.strokeStyle = "rgba(45,212,191,0.35)";
    x.lineWidth = 1;
    const step = Math.max(c.width, c.height) / 12;
    for (let gx = step; gx < c.width; gx += step) {
      x.beginPath();
      x.moveTo(Math.round(gx) + 0.5, 0);
      x.lineTo(Math.round(gx) + 0.5, c.height);
      x.stroke();
    }
    for (let gy = step; gy < c.height; gy += step) {
      x.beginPath();
      x.moveTo(0, Math.round(gy) + 0.5);
      x.lineTo(c.width, Math.round(gy) + 0.5);
      x.stroke();
    }
  }, [pic, rot, mirror, angle]);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const shown = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : crop;
  return (
    <div className="relative mx-auto w-fit touch-none select-none overflow-hidden rounded-lg">
      <canvas
        ref={ref}
        className="block max-h-[45vh] w-auto max-w-full cursor-crosshair rounded-lg"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const p = at(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = at(e);
          setDrag({ ...drag, x1: p.x, y1: p.y });
        }}
        onPointerUp={() => {
          if (drag) {
            const w = Math.abs(drag.x1 - drag.x0),
              h = Math.abs(drag.y1 - drag.y0);
            if (w > 0.05 && h > 0.05) onCrop({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w, h });
          }
          setDrag(null);
        }}
      />
      {(shown.w < 1 || shown.h < 1) && (
        <div
          className="pointer-events-none absolute border-2 border-teal-400"
          style={{
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`,
            height: `${shown.h * 100}%`,
            boxShadow: "0 0 0 9999px rgba(2,6,23,0.6)",
          }}
        />
      )}
    </div>
  );
}

function ShapeIcon({ shape }: { shape: OutlineShape }) {
  const common = { fill: "#d6b88c", stroke: "#a07a4a", strokeWidth: 1 };
  return (
    <svg width="22" height="30" viewBox="0 0 22 30" aria-hidden>
      {shape === "cutout" && (
        <path d="M8 2 H14 V6 H17 V10 H20 V15 H14 V22 Q17 24 14 28 H8 Q5 24 8 22 V15 H2 V10 H5 V6 H8 Z" {...common} strokeDasharray="2 1.5" />
      )}
      {shape === "rectangle" && <rect x="2" y="2" width="18" height="26" rx="1" {...common} />}
      {shape === "oval" && <ellipse cx="11" cy="15" rx="9" ry="13" {...common} />}
      {shape === "arch" && <path d="M2 28 V11 A9 9 0 0 1 20 11 V28 Z" {...common} />}
      {shape === "cross" && <path d="M8 2 H14 V8 H20 V14 H14 V28 H8 V14 H2 V8 H8 Z" {...common} />}
    </svg>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
      <h2 className="mb-3 text-base font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

function Choice({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-left text-sm ${on ? "border-teal-500 bg-teal-950/50 text-white" : "border-white/10 bg-slate-900/60 text-slate-300"}`}
    >
      {title}
      <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{hint}</span>
    </button>
  );
}

function SmallButton({
  on,
  disabled,
  onClick,
  children,
}: {
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs disabled:opacity-40 ${on ? "bg-teal-700 text-white" : "border border-white/15 text-slate-200"}`}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  shown,
  hint,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  shown: string;
  hint?: string;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  return (
    <label className="mb-3 block">
      <span className="flex items-center justify-between text-xs text-slate-300">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {onReset && (
            <button type="button" onClick={(e) => { e.preventDefault(); onReset(); }} className="text-[11px] text-teal-300 underline">
              Default
            </button>
          )}
          <span className="tabular-nums text-slate-400">{shown}</span>
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-teal-500"
      />
      {hint && <span className="block text-[11px] leading-snug text-slate-500">{hint}</span>}
    </label>
  );
}

/** Number box in inches or mm that stores mm; commits on blur or Enter. */
function NumberField({ label, mm, units, onChange }: { label: string; mm: number; units: Units; onChange: (mm: number) => void }) {
  const shown = units === "in" ? (mm / MM).toFixed(2) : mm.toFixed(1);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onChange(units === "in" ? v * MM : v);
    setDraft(null);
  };
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <div className="mt-1 flex items-center rounded-lg border border-white/15 bg-slate-950 focus-within:border-teal-500">
        <input
          inputMode="decimal"
          value={draft ?? shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-full min-w-0 bg-transparent px-2.5 py-2 text-sm text-white outline-none"
        />
        <span className="pr-2.5 text-xs text-slate-500">{units}</span>
      </div>
    </label>
  );
}
