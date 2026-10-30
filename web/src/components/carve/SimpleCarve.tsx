"use client";

import Link from "next/link";
import { CarveMachine } from "@/lib/carveMachine";
import {
  EDGE_ALLOWANCE_MM,
  EXTRA_DEPTH_MM,
  fitProblems,
  largestScale,
  MACHINE_TRAVEL,
  orientForCarving,
  rotate90,
  type Board,
  type Oriented,
} from "@/lib/relief/fit";
import type { ReliefResult } from "@/lib/relief/reliefCam";
import type { ReliefWorkerMessage, ReliefWorkerRequest } from "@/lib/relief/relief.worker";
import { deriveReliefSettings } from "@/lib/relief/settings";
import { PROVER_PRESET } from "@/lib/presets/prover";
import { parseBinaryStl, scaleVertices } from "@/lib/stl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MachineStep } from "./MachineStep";
import { ReliefPreview } from "./ReliefPreview";

type Units = "in" | "mm";
const MM = 25.4;
const PREFS_KEY = "cncarve:simplePrefs";

type Prefs = { units: Units; board: Board; wood: string; toolId: number };
const DEFAULT_PREFS: Prefs = {
  units: "in",
  board: { widthMm: 4 * MM, lengthMm: 6 * MM, thicknessMm: 0.75 * MM },
  wood: "hardwood",
  toolId: PROVER_PRESET.defaultDetailToolId,
};

const WOODS = [
  { id: "softwood", label: "Soft wood", hint: "pine, basswood, cedar" },
  { id: "hardwood", label: "Hard wood", hint: "oak, maple, walnut" },
  { id: "mdf", label: "MDF / plywood", hint: "practice pieces" },
];

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return p ? { ...DEFAULT_PREFS, ...p, board: { ...DEFAULT_PREFS.board, ...p.board } } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

type Design = { name: string; base: Oriented; turned: boolean; autoTurned: boolean };

type Toolpaths =
  | { kind: "idle" }
  | { kind: "running"; fraction: number; label: string }
  | { kind: "error"; message: string }
  | { kind: "done"; key: string; result: ReliefResult; bitLabel: string; spindleS: number };

export function SimpleCarve() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    // Read saved choices once on the client (localStorage isn't available during the server render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(loadPrefs());
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs, prefsLoaded]);

  const [machine] = useState(() => new CarveMachine());
  const [design, setDesign] = useState<Design | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  /** Design height (front-to-back on the board) in mm; null = "largest that fits". */
  const [heightMm, setHeightMm] = useState<number | null>(null);
  const [tp, setTp] = useState<Toolpaths>({ kind: "idle" });
  const workerRef = useRef<Worker | null>(null);

  const u = prefs.units;
  const fmt = (mm: number) => (u === "in" ? `${(mm / MM).toFixed(2)} in` : `${mm.toFixed(1)} mm`);

  const oriented = design ? (design.turned ? rotate90(design.base) : design.base) : null;
  const maxScale = oriented ? largestScale(oriented.size, prefs.board) : 0;
  const scale = oriented ? (heightMm === null ? maxScale : heightMm / oriented.size.y) : 0;
  const sized = oriented && scale > 0
    ? { x: oriented.size.x * scale, y: oriented.size.y * scale, z: oriented.size.z * scale }
    : null;
  const tooBigForMachine =
    !!sized &&
    (sized.x + 2 * EDGE_ALLOWANCE_MM > MACHINE_TRAVEL.xMm || sized.y + 2 * EDGE_ALLOWANCE_MM > MACHINE_TRAVEL.yMm);
  const problems = [
    ...(oriented && sized ? fitProblems(oriented.size, scale, prefs.board, fmt) : []),
    ...(tooBigForMachine ? ["That's bigger than the 3018 can reach (about 300 × 180 mm)."] : []),
  ];
  const fits = !!sized && problems.length === 0 && maxScale > 0;

  const settings = useMemo(
    () =>
      sized
        ? deriveReliefSettings(
            { machineId: PROVER_PRESET.id, toolId: prefs.toolId, materialId: prefs.wood, qualityId: "balanced" },
            sized,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sized?.x, sized?.y, prefs.toolId, prefs.wood],
  );

  const key = design && sized && settings
    ? [design.name, design.turned, sized.x.toFixed(2), sized.y.toFixed(2), JSON.stringify(prefs.board), JSON.stringify(settings.params), JSON.stringify(settings.bit)].join("|")
    : null;

  // Make toolpaths automatically once everything fits (short pause so typing doesn't restart it).
  useEffect(() => {
    if (!fits || !key || !oriented || !settings || !design) return;
    if (tp.kind === "done" && tp.key === key) return;
    const timer = window.setTimeout(() => {
      workerRef.current?.terminate();
      const w = new Worker(new URL("../../lib/relief/relief.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = w;
      setTp({ kind: "running", fraction: 0, label: "Starting" });
      w.onmessage = (ev: MessageEvent<ReliefWorkerMessage>) => {
        const m = ev.data;
        if (m.type === "progress") setTp({ kind: "running", fraction: m.fraction, label: m.label });
        else if (m.type === "error") {
          setTp({ kind: "error", message: m.message });
          w.terminate();
        } else {
          setTp({ kind: "done", key, result: m.result, bitLabel: settings.bitLabel, spindleS: settings.params.spindleS });
          w.terminate();
        }
      };
      w.onerror = (ev) => setTp({ kind: "error", message: ev.message || "The toolpath maker stopped unexpectedly." });
      const req: ReliefWorkerRequest = {
        vertices: scaleVertices(oriented.vertices, scale, scale, scale),
        bit: settings.bit,
        params: settings.params,
        board: { widthMm: prefs.board.widthMm, depthMm: prefs.board.lengthMm, thicknessMm: prefs.board.thicknessMm },
        name: design.name,
      };
      w.postMessage(req, [req.vertices.buffer]);
    }, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fits]);
  useEffect(() => () => workerRef.current?.terminate(), []);

  const current = tp.kind === "done" && tp.key === key ? tp : null;
  const job = current
    ? { ...current.result.program, name: design?.name ?? "carving", bitLabel: current.bitLabel, spindleS: current.spindleS }
    : null;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileError(null);
    setLoadingFile(true);
    try {
      const buf = await f.arrayBuffer();
      const head = new TextDecoder().decode(buf.slice(0, 5));
      const n = buf.byteLength >= 84 ? new DataView(buf).getUint32(80, true) : 0;
      if (head === "solid" && 84 + n * 50 !== buf.byteLength)
        throw new Error("This is a text (ASCII) STL. Please export it as a binary STL.");
      const raw = parseBinaryStl(buf);
      if (raw.length < 9) throw new Error("The file has no triangles in it.");
      const base = orientForCarving(raw);
      // Turn it 90° on the board if that lets it be carved bigger.
      const turned = rotate90(base);
      const autoTurned = largestScale(turned.size, prefs.board) > largestScale(base.size, prefs.board) * 1.02;
      setDesign({ name: f.name.replace(/\.stl$/i, ""), base, turned: autoTurned, autoTurned });
      setHeightMm(null);
      setTp({ kind: "idle" });
    } catch (e) {
      setDesign(null);
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingFile(false);
    }
  };

  const setBoard = (patch: Partial<Board>) => setPrefs((p) => ({ ...p, board: { ...p.board, ...patch } }));

  const step1 = !!design;
  const step2 = prefs.board.widthMm > 0 && prefs.board.lengthMm > 0 && prefs.board.thicknessMm > 0;
  const step3 = step1 && fits;
  const step4 = !!current && current.result.summary.problems.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">CNCarve</h1>
            <p className="text-sm text-slate-400">Carve a relief on the 3018 in five steps.</p>
          </div>
          <Link href="/advanced" className="mt-1 text-xs text-slate-500 underline hover:text-slate-300">
            Advanced (Kiri:Moto)
          </Link>
        </header>

        <div className="space-y-4">
          <Card n={1} title="Choose your design" done={step1} summary={design ? `${design.name}` : undefined}>
            <label
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-slate-900/60 px-4 py-8 text-center hover:border-teal-500/60"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onFile(e.dataTransfer.files?.[0]);
              }}
            >
              <span className="text-sm font-medium text-white">
                {loadingFile ? "Reading the file…" : design ? "Choose a different STL file" : "Choose an STL file"}
              </span>
              <span className="mt-1 text-xs text-slate-400">or drop it here</span>
              <input
                id="carve-stl-input"
                type="file"
                accept=".stl,model/stl"
                className="sr-only"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </label>
            {fileError && <p className="mt-2 text-sm text-rose-300">{fileError}</p>}
            {design?.base.note && <p className="mt-2 text-xs text-slate-400">{design.base.note}</p>}
          </Card>

          <Card
            n={2}
            title="Your board"
            done={step1 && step2}
            summary={`${fmt(prefs.board.widthMm)} × ${fmt(prefs.board.lengthMm)} × ${fmt(prefs.board.thicknessMm)}, ${WOODS.find((w) => w.id === prefs.wood)?.label.toLowerCase()}`}
            open={step1}
          >
            <div className="mb-3 flex gap-1 text-xs">
              {(["in", "mm"] as Units[]).map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setPrefs((p) => ({ ...p, units: x }))}
                  className={`rounded-md px-2.5 py-1 ${u === x ? "bg-teal-600 text-white" : "bg-slate-800 text-slate-300"}`}
                >
                  {x === "in" ? "Inches" : "Millimetres"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width (left to right)" mm={prefs.board.widthMm} units={u} onChange={(v) => setBoard({ widthMm: v })} />
              <NumberField label="Length (front to back)" mm={prefs.board.lengthMm} units={u} onChange={(v) => setBoard({ lengthMm: v })} />
              <NumberField label="Thickness" mm={prefs.board.thicknessMm} units={u} onChange={(v) => setBoard({ thicknessMm: v })} />
            </div>
            <p className="mt-3 text-xs text-slate-400">Wood</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {WOODS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setPrefs((p) => ({ ...p, wood: w.id }))}
                  className={`rounded-xl border px-2 py-2 text-left text-sm ${prefs.wood === w.id ? "border-teal-500 bg-teal-950/50 text-white" : "border-white/10 bg-slate-900/60 text-slate-300"}`}
                >
                  {w.label}
                  <span className="block text-[11px] text-slate-500">{w.hint}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card
            n={3}
            title="Size on the board"
            done={step3}
            summary={sized ? `${fmt(sized.x)} wide × ${fmt(sized.y)} tall, ${fmt(sized.z)} deep` : undefined}
            open={step1 && step2}
          >
            {oriented && sized && (
              <div className="flex flex-wrap items-start gap-5">
                <BoardDiagram board={prefs.board} design={sized} />
                <div className="min-w-[12rem] flex-1 space-y-3">
                  <NumberField
                    label="Height of the carving (front to back)"
                    mm={sized.y}
                    units={u}
                    onChange={(v) => setHeightMm(v)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setHeightMm(null)}
                      className={`rounded-lg px-3 py-1.5 text-xs ${heightMm === null ? "bg-teal-700 text-white" : "border border-white/15 text-slate-200"}`}
                    >
                      Largest that fits
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDesign({ ...design!, turned: !design!.turned });
                        setHeightMm(null);
                      }}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200"
                    >
                      Turn 90°
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    {fmt(sized.x)} wide × {fmt(sized.y)} tall, carved {fmt(sized.z + EXTRA_DEPTH_MM)} deep.
                    {design?.autoTurned && design.turned && " Turned 90° so it fits bigger."}
                  </p>
                  {problems.map((p) => (
                    <p key={p} className="text-sm text-amber-200">
                      {p}
                    </p>
                  ))}
                  {maxScale <= 0 && <p className="text-sm text-amber-200">The board is too small to carve on.</p>}
                </div>
              </div>
            )}
          </Card>

          <Card
            n={4}
            title="Toolpaths"
            done={step4}
            summary={current ? `about ${minutesText(current.result.program.estMinutes)} of carving` : undefined}
            open={step3}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              Bit:
              <select
                value={prefs.toolId}
                onChange={(e) => setPrefs((p) => ({ ...p, toolId: Number(e.target.value) }))}
                className="rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-xs text-slate-100"
              >
                {PROVER_PRESET.tools.map((t) => (
                  <option key={t.id as number} value={t.id as number}>
                    {String(t.name)}
                  </option>
                ))}
              </select>
            </div>
            {tp.kind === "running" && (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-teal-500 transition-[width]" style={{ width: `${Math.round(tp.fraction * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-slate-400">{tp.label}…</p>
              </div>
            )}
            {tp.kind === "error" && <p className="text-sm text-rose-300">{tp.message}</p>}
            {current && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <ReliefPreview preview={current.result.preview} which="target" label="Your design" />
                  <ReliefPreview preview={current.result.preview} which="carved" label="What your bit will carve" />
                </div>
                {current.result.program.estMinutes > 240 && (
                  <p className="text-xs text-amber-200">
                    That&apos;s a long carve. Carving time grows with the area, so a slightly smaller size is much
                    faster — change the height in step 3.
                  </p>
                )}
                {current.result.summary.problems.length === 0 ? (
                  <p className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 text-sm text-emerald-100">
                    ✓ Ready: about {minutesText(current.result.program.estMinutes)} of carving in one go, with a{" "}
                    {current.bitLabel}. Checked for the machine, and the bit never cuts into the design.
                  </p>
                ) : (
                  <ul className="space-y-1 rounded-xl border border-rose-500/40 bg-rose-950/40 p-3 text-sm text-rose-100">
                    {current.result.summary.problems.map((p) => (
                      <li key={p}>⚠ {p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>

          <Card n={5} title="Carve" done={false} open>
            <MachineStep machine={machine} job={step4 ? job : null} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function minutesText(min: number) {
  const m = Math.max(1, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function Card({
  n,
  title,
  done,
  summary,
  open = true,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  summary?: string;
  open?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const showBody = open && (!done || expanded || n >= 4);
  return (
    <section className={`rounded-2xl border bg-slate-900/70 p-4 ${open ? "border-white/10" : "border-white/5 opacity-50"}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-emerald-500 text-white" : "bg-slate-700 text-slate-200"}`}
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {done && summary && !showBody && <p className="truncate text-xs text-slate-400">{summary}</p>}
        </div>
        {done && open && n < 4 && (
          <button type="button" onClick={() => setExpanded((x) => !x)} className="text-xs text-slate-400 underline">
            {expanded ? "Done" : "Change"}
          </button>
        )}
      </div>
      {showBody && <div className="mt-4">{children}</div>}
    </section>
  );
}

/** Number box in inches or mm that stores mm; commits on blur or Enter so typing isn't fought. */
function NumberField({
  label,
  mm,
  units,
  onChange,
}: {
  label: string;
  mm: number;
  units: Units;
  onChange: (mm: number) => void;
}) {
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

/** Top view: the board, and the carving (with its saw groove) centred on it. */
function BoardDiagram({ board, design }: { board: Board; design: { x: number; y: number } }) {
  const W = 150;
  const k = W / Math.max(board.widthMm, board.lengthMm);
  const bw = board.widthMm * k,
    bl = board.lengthMm * k;
  const dw = (design.x + 2 * 1.5) * k,
    dl = (design.y + 2 * 1.5) * k;
  return (
    <svg width={W + 20} height={W + 34} viewBox={`-10 -10 ${W + 20} ${W + 34}`} aria-label="Board top view" className="shrink-0">
      <rect x={(W - bw) / 2} y={(W - bl) / 2} width={bw} height={bl} rx={3} fill="#d6b88c" stroke="#a07a4a" />
      <rect
        x={(W - dw) / 2}
        y={(W - dl) / 2}
        width={dw}
        height={dl}
        rx={2}
        fill="#8a6a42"
        fillOpacity={0.55}
        stroke="#3b2a17"
        strokeDasharray="3 2"
      />
      <line x1={W / 2 - 4} y1={W / 2} x2={W / 2 + 4} y2={W / 2} stroke="#1e293b" />
      <line x1={W / 2} y1={W / 2 - 4} x2={W / 2} y2={W / 2 + 4} stroke="#1e293b" />
      <text x={W / 2} y={W + 18} textAnchor="middle" fontSize="10" fill="#94a3b8">
        front of the machine
      </text>
    </svg>
  );
}
