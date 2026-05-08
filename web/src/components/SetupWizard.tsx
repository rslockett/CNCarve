"use client";

import { useAppState } from "@/context/AppState";
import { PROVER_PRESET } from "@/lib/presets/prover";
import type {
  CamToolStrategy,
  PatternPlacement,
  StockOnBed,
  WizardAnswers,
} from "@/lib/presets/types";
import { readNativeStlSize } from "@/lib/stockTransform";
import { lengthFromDisplay, lengthToDisplay } from "@/lib/units";
import {
  coerceToolsForMachine,
  isPatternSizeReady,
  listMaterials,
  listPresetTools,
  listQuality,
  validateSafety,
} from "@/lib/wizard";
import type { DisplayUnits } from "@/lib/presets/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Top-view diagram: stock, usable area (margin), and pattern XY footprint. */
function StockStlFitPreview({
  stockWidthMm,
  stockDepthMm,
  marginMm,
  patternXMm,
  patternYMm,
}: {
  stockWidthMm: number;
  stockDepthMm: number;
  marginMm: number;
  patternXMm: number;
  patternYMm: number;
}) {
  const k = useMemo(() => {
    const maxSide = Math.max(stockWidthMm, stockDepthMm, 1);
    return 88 / maxSide;
  }, [stockWidthMm, stockDepthMm]);

  const sw = stockWidthMm * k;
  const sd = stockDepthMm * k;
  const vbW = 100;
  const vbH = Math.max(56, sd + 12);
  const ox = (vbW - sw) / 2;
  const oy = (vbH - sd) / 2;

  const inset = Math.min(marginMm * k, sw / 2 - 0.5, sd / 2 - 0.5);
  const usableW = Math.max(0, sw - 2 * inset);
  const usableH = Math.max(0, sd - 2 * inset);
  const ux = ox + inset;
  const uy = oy + inset;

  const pw = patternXMm * k;
  const ph = patternYMm * k;
  const px = ox + (sw - pw) / 2;
  const py = oy + (sd - ph) / 2;

  const fitsX = patternXMm <= stockWidthMm - 2 * marginMm + 1e-6;
  const fitsY = patternYMm <= stockDepthMm - 2 * marginMm + 1e-6;
  const fits = fitsX && fitsY;

  return (
    <figure className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-slate-950/60">
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        className="h-auto w-full text-slate-200"
        aria-hidden
      >
        <rect
          x={ox}
          y={oy}
          width={sw}
          height={sd}
          rx={1.2}
          className="fill-amber-900/35 stroke-amber-600/50"
          strokeWidth={0.6}
        />
        <rect
          x={ux}
          y={uy}
          width={usableW}
          height={usableH}
          rx={0.8}
          fill="none"
          className="stroke-slate-500/60"
          strokeWidth={0.45}
          strokeDasharray="2 2"
        />
        <rect
          x={px}
          y={py}
          width={pw}
          height={ph}
          rx={0.6}
          className={
            fits
              ? "fill-teal-500/25 stroke-teal-400/80"
              : "fill-rose-500/20 stroke-rose-400/90"
          }
          strokeWidth={0.55}
        />
        <text
          x={vbW / 2}
          y={oy + sd + 7}
          textAnchor="middle"
          style={{
            fill: "rgba(148, 163, 184, 0.95)",
            fontSize: "4.2px",
            fontWeight: 500,
          }}
        >
          Top view — stock (tan), margin (dashed), pattern (teal)
        </text>
      </svg>
      {!fits && (
        <figcaption className="border-t border-rose-500/20 bg-rose-950/25 px-3 py-2 text-xs text-rose-200/90">
          Pattern is wider or deeper than the usable area inside your margin — use
          Auto-fit or shrink the size.
        </figcaption>
      )}
    </figure>
  );
}

const PLACEMENTS: { id: PatternPlacement; label: string; hint: string }[] = [
  { id: "center", label: "Center", hint: "Most people start here." },
  { id: "front_left", label: "Front-left corner", hint: "Near you, on the left." },
  { id: "front_right", label: "Front-right corner", hint: "Near you, on the right." },
  { id: "back_left", label: "Back-left", hint: "Away from you, left." },
  { id: "back_right", label: "Back-right", hint: "Away from you, right." },
  { id: "left", label: "Left side", hint: "Runs along the left edge." },
  { id: "right", label: "Right side", hint: "Runs along the right edge." },
  { id: "front", label: "Front edge", hint: "Near you, centered side-to-side." },
  { id: "back", label: "Back edge", hint: "Far edge, centered side-to-side." },
];

const BED_ANCHOR: { id: StockOnBed; label: string; hint: string }[] = [
  {
    id: "front_left",
    label: "Stock touches front-left of the table",
    hint: "Matches many 3018 setups: board shoved into the front-left corner.",
  },
  {
    id: "centered",
    label: "Stock is centered on the table",
    hint: "Uses the middle of the bed as the starting reference.",
  },
];

type Props = {
  open: boolean;
  onDismiss: () => void;
  onImportToKiri: (answersOverride?: WizardAnswers) => void;
  /** Close setup and open Send to machine (e.g. user already has a .gcode file). */
  onSkipToMachine?: () => void;
  importStatus: string | null;
  importBusy: boolean;
};

export function SetupWizard({
  open,
  onDismiss,
  onImportToKiri,
  onSkipToMachine,
  importStatus,
  importBusy,
}: Props) {
  const {
    answers,
    setAnswers,
    setStlFile,
    setStlBuffer,
    setStlNativeSize,
    stlNativeSize,
  } = useAppState();

  const materials = listMaterials();
  const presetTools = useMemo(
    () => listPresetTools(answers.machineId),
    [answers.machineId],
  );
  const qualities = listQuality();
  const safety = validateSafety(answers);
  const u = answers.displayUnits;
  const dimSuffix = u === "mm" ? "mm" : "in";
  const formatDisplay = useCallback(
    (mm: number) => String(lengthToDisplay(mm, u)),
    [u],
  );

  const [stockDraft, setStockDraft] = useState<{
    stockWidthMm: string;
    stockDepthMm: string;
    stockThicknessMm: string;
  }>({
    stockWidthMm: formatDisplay(answers.stockWidthMm),
    stockDepthMm: formatDisplay(answers.stockDepthMm),
    stockThicknessMm: formatDisplay(answers.stockThicknessMm),
  });
  const [marginDraft, setMarginDraft] = useState<string>(
    formatDisplay(answers.stockMarginMm),
  );

  useEffect(() => {
    setStockDraft({
      stockWidthMm: formatDisplay(answers.stockWidthMm),
      stockDepthMm: formatDisplay(answers.stockDepthMm),
      stockThicknessMm: formatDisplay(answers.stockThicknessMm),
    });
    setMarginDraft(formatDisplay(answers.stockMarginMm));
  }, [
    answers.stockDepthMm,
    answers.stockMarginMm,
    answers.stockThicknessMm,
    answers.stockWidthMm,
    formatDisplay,
  ]);

  const syncPatternFromNative = useCallback(
    (native: { x: number; y: number; z: number }) => {
      setAnswers((a) => ({
        ...a,
        patternSizeMm: { x: native.x, y: native.y, z: native.z },
      }));
    },
    [setAnswers],
  );

  const onStlPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) {
      setStlFile(null);
      setStlBuffer(null);
      setStlNativeSize(null);
      setAnswers((a) => ({
        ...a,
        stlFileName: null,
        patternSizeMm: { x: 0, y: 0, z: 0 },
      }));
      return;
    }
    setStlFile(f);
    setAnswers((a) => ({ ...a, stlFileName: f.name }));
    const buf = await f.arrayBuffer();
    setStlBuffer(buf);
    const nat = readNativeStlSize(buf);
    setStlNativeSize(nat);
    if (nat) syncPatternFromNative(nat);
  };

  const setPatternField = useCallback(
    (axis: "x" | "y" | "z", value: number) => {
      const raw = Number.isFinite(value) ? Math.max(0, value) : 0;
      setAnswers((a) => {
        const n = stlNativeSize;
        if (!a.linkPatternSizes) {
          return {
            ...a,
            patternSizeMm: { ...a.patternSizeMm, [axis]: raw },
          };
        }
        if (n) {
          if (raw <= 0) {
            return { ...a, patternSizeMm: { x: 0, y: 0, z: 0 } };
          }
          const k = raw / n[axis];
          return {
            ...a,
            patternSizeMm: {
              x: n.x * k,
              y: n.y * k,
              z: n.z * k,
            },
          };
        }
        const cur = a.patternSizeMm;
        if (raw <= 0) {
          return { ...a, patternSizeMm: { x: 0, y: 0, z: 0 } };
        }
        if (cur[axis] > 1e-9) {
          const k = raw / cur[axis];
          return {
            ...a,
            patternSizeMm: {
              x: cur.x * k,
              y: cur.y * k,
              z: cur.z * k,
            },
          };
        }
        return {
          ...a,
          patternSizeMm: { ...cur, [axis]: raw },
        };
      });
    },
    [setAnswers, stlNativeSize],
  );

  const autoFitPatternToStock = useCallback(() => {
    setAnswers((a) => {
      const nat = stlNativeSize;
      if (!nat) return a;

      // Use live draft text so Auto-fit reflects what user just typed,
      // even before blur/Enter commits those fields.
      const draftW = lengthFromDisplay(parseFloat(stockDraft.stockWidthMm), u);
      const draftD = lengthFromDisplay(parseFloat(stockDraft.stockDepthMm), u);
      const draftT = lengthFromDisplay(parseFloat(stockDraft.stockThicknessMm), u);
      const draftM = lengthFromDisplay(parseFloat(marginDraft), u);

      const widthMm = Number.isFinite(draftW) ? Math.max(0.5, draftW) : a.stockWidthMm;
      const depthMm = Number.isFinite(draftD) ? Math.max(0.5, draftD) : a.stockDepthMm;
      const thickMm = Number.isFinite(draftT) ? Math.max(0.5, draftT) : a.stockThicknessMm;
      const marginMm = Number.isFinite(draftM) ? Math.max(0, draftM) : a.stockMarginMm;

      const usableW = Math.max(1, widthMm - 2 * marginMm);
      const usableD = Math.max(1, depthMm - 2 * marginMm);
      const usableZ = Math.max(0.5, thickMm - marginMm);
      // Auto-fit is a top-view action: fill the usable XY area first.
      // Z may exceed stock thickness for very tall meshes; we surface that as safety text.
      const s = Math.min(usableW / nat.x, usableD / nat.y);
      return {
        ...a,
        stockWidthMm: widthMm,
        stockDepthMm: depthMm,
        stockThicknessMm: thickMm,
        stockMarginMm: marginMm,
        linkPatternSizes: true,
        patternScaleAxis: "uniform",
        patternSizeMm: {
          x: nat.x * s,
          y: nat.y * s,
          z: nat.z * s,
        },
      };
    });
  }, [marginDraft, setAnswers, stockDraft.stockDepthMm, stockDraft.stockThicknessMm, stockDraft.stockWidthMm, stlNativeSize, u]);

  const commitStockField = useCallback(
    (key: "stockWidthMm" | "stockDepthMm" | "stockThicknessMm", raw: string) => {
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) {
        setStockDraft((prev) => ({ ...prev, [key]: formatDisplay(answers[key]) }));
        return;
      }
      const mm = lengthFromDisplay(parsed, u);
      const nextMm = Math.max(0.5, mm);
      setAnswers((a) => ({ ...a, [key]: nextMm }));
      setStockDraft((prev) => ({ ...prev, [key]: formatDisplay(nextMm) }));
    },
    [answers, formatDisplay, setAnswers, u],
  );

  const commitMarginField = useCallback(
    (raw: string) => {
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) {
        setMarginDraft(formatDisplay(answers.stockMarginMm));
        return;
      }
      const mm = Math.max(0, lengthFromDisplay(parsed, u));
      setAnswers((a) => ({ ...a, stockMarginMm: mm }));
      setMarginDraft(formatDisplay(mm));
    },
    [answers.stockMarginMm, formatDisplay, setAnswers, u],
  );

  const buildCommittedAnswers = useCallback((): WizardAnswers => {
    const draftW = lengthFromDisplay(parseFloat(stockDraft.stockWidthMm), u);
    const draftD = lengthFromDisplay(parseFloat(stockDraft.stockDepthMm), u);
    const draftT = lengthFromDisplay(parseFloat(stockDraft.stockThicknessMm), u);
    const draftM = lengthFromDisplay(parseFloat(marginDraft), u);

    const stockWidthMm = Number.isFinite(draftW)
      ? Math.max(0.5, draftW)
      : answers.stockWidthMm;
    const stockDepthMm = Number.isFinite(draftD)
      ? Math.max(0.5, draftD)
      : answers.stockDepthMm;
    const stockThicknessMm = Number.isFinite(draftT)
      ? Math.max(0.5, draftT)
      : answers.stockThicknessMm;
    const stockMarginMm = Number.isFinite(draftM)
      ? Math.max(0, draftM)
      : answers.stockMarginMm;

    return {
      ...answers,
      stockWidthMm,
      stockDepthMm,
      stockThicknessMm,
      stockMarginMm,
    };
  }, [answers, marginDraft, stockDraft.stockDepthMm, stockDraft.stockThicknessMm, stockDraft.stockWidthMm, u]);

  const committedForImport = buildCommittedAnswers();
  const canImport =
    !!committedForImport.stlFileName && isPatternSizeReady(committedForImport);

  const importBlockedReason = !committedForImport.stlFileName
    ? "Upload an STL above — the Import button stays off until a file is chosen."
    : !isPatternSizeReady(committedForImport)
      ? "Carved size is still zero. Use a binary STL so dimensions auto-fill, or turn off “Lock proportions” and type X, Y, and Z."
      : null;

  const patternCarveInputsDisabled =
    !answers.stlFileName ||
    (answers.linkPatternSizes && !stlNativeSize);

  const importHintRef = useRef<HTMLParagraphElement>(null);

  /** Same-origin fullscreen iframe + modal in one subtree breaks hit-testing in some engines; portal to body fixes it. */
  const [portalReady, setPortalReady] = useState(false);
  useLayoutEffect(() => {
    queueMicrotask(() => setPortalReady(true));
  }, []);

  const handleImportClick = useCallback(() => {
    const committed = buildCommittedAnswers();
    setAnswers(committed);
    if (!committed.stlFileName || !isPatternSizeReady(committed)) {
      importHintRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      document.getElementById("cn-wizard-stl-input")?.focus();
    }
    onImportToKiri(committed);
  }, [buildCommittedAnswers, onImportToKiri, setAnswers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  /**
   * Native `<dialog showModal>` + a same-origin full-viewport Kiri iframe broke hit-testing (e.g. mm/in
   * toggles). A fixed overlay is rendered via `createPortal(..., document.body)` so it is not a DOM
   * descendant of the iframe’s parent (see comment on `portalReady` above).
   */
  const overlay = (
    <div
      className="fixed inset-0 z-[200] flex min-h-[100dvh] w-full max-w-none flex-col items-center overflow-x-hidden overflow-y-auto bg-slate-950/70 p-4 pt-10 outline-none backdrop-blur-md md:justify-center md:pt-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="pointer-events-auto relative z-10 mb-8 flex max-h-[min(calc(100dvh-2rem),56rem)] w-full max-w-lg shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 shadow-2xl shadow-teal-950/40 ring-1 ring-teal-500/20"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute -top-px left-8 right-8 z-10 h-px bg-gradient-to-r from-transparent via-teal-400/60 to-transparent" />
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-teal-400/90">
              Step-by-step
            </p>
            <h2 id="wizard-title" className="mt-1 text-xl font-semibold text-white">
              Carving setup
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Answer in plain English. When you are ready, we push everything into
              full-screen Kiri:Moto for you. If the 3D view fails after choosing a file,
              use <span className="text-slate-300">Restart Kiri</span> (bottom right) or reload the page
              — Kiri needs WebGL.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10"
          >
            Hide
          </button>
        </header>

        <div className="relative z-0 min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain px-6 py-6">
          {onSkipToMachine && (
            <section className="rounded-xl border border-sky-500/35 bg-sky-950/30 p-4 ring-1 ring-sky-500/15">
              <h3 className="text-sm font-semibold text-sky-100">
                Already have G-code?
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Skip this wizard and open <strong className="text-slate-300">Send to machine</strong>{" "}
                to drop in a <span className="text-slate-300">.gcode</span> file (or paste), then
                connect USB — no STL or Kiri required.
              </p>
              <button
                type="button"
                onClick={onSkipToMachine}
                className="mt-3 w-full rounded-xl border border-sky-500/50 bg-sky-900/50 py-2.5 text-sm font-semibold text-sky-50 hover:bg-sky-800/60 sm:w-auto sm:px-5"
              >
                Skip to Send to machine
              </button>
            </section>
          )}

          <section className="rounded-xl border border-white/10 bg-slate-950/40 p-4">
            <h3 className="text-sm font-semibold text-white">Measurement units</h3>
            <p className="mt-1 text-xs text-slate-500">
              Board size, margins, and pattern dimensions below follow this choice.
              Values sent to Kiri:Moto are always converted to millimeters.
            </p>
            <div
              className="mt-3 inline-flex rounded-xl border border-white/10 p-0.5"
              role="group"
              aria-label="Length units"
            >
              {(
                [
                  ["mm", "Millimeters"],
                  ["in", "Inches"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    setAnswers((a) => ({
                      ...a,
                      displayUnits: id as DisplayUnits,
                    }))
                  }
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    u === id
                      ? "bg-teal-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">Your board (stock)</h3>
            <p className="mt-1 text-xs text-slate-500">
              Real-world size of the material you clamped down — width, depth, and
              thickness ({dimSuffix}).
            </p>
            <p className="mt-2 text-xs text-slate-500">
              In Kiri the large <strong className="font-medium text-slate-400">rectangle</strong>{" "}
              around your model is this stock volume — boards are rectangular, so CAM always shows a
              box. It is <em>not</em> the Outline pass; Outline traces your STL silhouette. Contour
              with Inside / Clip-to-stock stays on the mesh inside that box. To waste less air-time,
              keep stock close to your carve (smaller board sizes here, smaller margin, or{" "}
              <span className="text-slate-400">Auto-fit on stock</span> then trim stock fields if
              needed).
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  ["stockWidthMm", "Width (X)"],
                  ["stockDepthMm", "Depth (Y)"],
                  ["stockThicknessMm", "Thickness (Z)"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-xs text-slate-400">
                  {label} ({dimSuffix})
                  <input
                    type="text"
                    inputMode="decimal"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-2 py-2 text-sm text-slate-100"
                    value={stockDraft[key]}
                    onChange={(e) =>
                      setStockDraft((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    onBlur={(e) => commitStockField(key, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitStockField(key, (e.currentTarget as HTMLInputElement).value);
                        (e.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            <label className="mt-3 block text-xs text-slate-400">
              Safety margin from edge of board ({dimSuffix})
              <input
                type="text"
                inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                value={marginDraft}
                onChange={(e) => setMarginDraft(e.target.value)}
                onBlur={(e) => commitMarginField(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitMarginField((e.currentTarget as HTMLInputElement).value);
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
            </label>
          </section>

          <section id="cn-wizard-stl-section">
            <h3 className="text-sm font-semibold text-white">3D model (STL)</h3>
            <p className="mt-1 text-xs text-slate-500">
              Binary STL from your CAD or slicer. We read its size and can scale it
              to your stock.
            </p>
            <input
              id="cn-wizard-stl-input"
              type="file"
              accept=".stl"
              onChange={onStlPicked}
              className="mt-2 block w-full text-sm text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-600 file:px-3 file:py-2 file:text-sm file:text-white hover:file:bg-teal-500"
            />
            {answers.stlFileName && (
              <p className="mt-2 text-sm text-teal-400">{answers.stlFileName}</p>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">STL size & fit on stock</h3>
            <p className="mt-1 text-xs text-slate-500">
              Carved size starts at zero until you upload a binary STL — then it
              matches the mesh. With proportions locked, editing X, Y, or Z scales
              the others to keep the same shape.
            </p>
            {!answers.stlFileName && (
              <p className="mt-2 text-xs text-amber-200/80">
                Upload an STL in the section above to fill sizes and enable import.
              </p>
            )}
            {answers.stlFileName &&
              answers.linkPatternSizes &&
              !stlNativeSize && (
                <p className="mt-2 text-xs text-amber-200/80">
                  Could not read mesh size — use a binary STL, or turn off
                  proportions to type X, Y, and Z yourself.
                </p>
              )}
            {answers.stlFileName && (
              <p className="mt-2 text-xs text-teal-300/90">
                Mesh size in file (native):{" "}
                {stlNativeSize
                  ? u === "mm"
                    ? `${stlNativeSize.x.toFixed(1)} × ${stlNativeSize.y.toFixed(1)} × ${stlNativeSize.z.toFixed(1)} mm`
                    : `${lengthToDisplay(stlNativeSize.x, "in").toFixed(4)} × ${lengthToDisplay(stlNativeSize.y, "in").toFixed(4)} × ${lengthToDisplay(stlNativeSize.z, "in").toFixed(4)} in`
                  : "could not read — use a binary STL"}
              </p>
            )}
            <StockStlFitPreview
              stockWidthMm={answers.stockWidthMm}
              stockDepthMm={answers.stockDepthMm}
              marginMm={answers.stockMarginMm}
              patternXMm={answers.patternSizeMm.x}
              patternYMm={answers.patternSizeMm.y}
            />
            <button
              type="button"
              disabled={!stlNativeSize}
              onClick={autoFitPatternToStock}
              className="mt-3 w-full rounded-xl border border-teal-500/40 bg-teal-950/40 px-4 py-2.5 text-sm font-medium text-teal-100 hover:bg-teal-900/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Auto-fit on stock
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Fits to usable width/depth (top view) inside your margin with
              uniform scaling. If Z is still too tall, safety warnings below will
              flag it so you can reduce carve depth manually.
            </p>
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={answers.linkPatternSizes}
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, linkPatternSizes: e.target.checked }))
                }
                className="rounded border-white/20 bg-slate-900 text-teal-500"
              />
              Lock proportions (no squish or stretch)
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis} className="text-xs text-slate-400">
                  Carve {axis.toUpperCase()} ({dimSuffix})
                  <input
                    type="number"
                    min={0}
                    step={u === "mm" ? 0.1 : 0.0001}
                    disabled={patternCarveInputsDisabled}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-2 py-2 text-sm text-slate-100 disabled:opacity-40"
                    value={lengthToDisplay(answers.patternSizeMm[axis], u)}
                    onChange={(e) =>
                      setPatternField(
                        axis,
                        lengthFromDisplay(parseFloat(e.target.value) || 0, u),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">Machine & cutters</h3>
            <p className="mt-1 text-xs text-slate-500">
              Material drives safe feeds; the wizard writes Kiri milling ops (Contour
              surface slices for relief, Rough only when using two-step strategy) plus
              stock.
            </p>
            <select
              className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-teal-500/50"
              value={answers.machineId}
              onChange={(e) => {
                const machineId = e.target.value;
                setAnswers((a) => {
                  const t = coerceToolsForMachine(
                    machineId,
                    a.singleToolId,
                    a.roughToolId,
                    a.outlineToolId,
                  );
                  return { ...a, machineId, ...t };
                });
              }}
            >
              <option value={PROVER_PRESET.id}>{PROVER_PRESET.label}</option>
            </select>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Kiri’s iframe API merges bed limits and spindle into the machine you already
              selected in Kiri (“Any.Generic.Grbl” is common); it cannot yet switch the preset
              row there. Your travels and G-code prelude still match this SainSmart preset.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-slate-400">
                Material
                <select
                  className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                  value={answers.materialId}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, materialId: e.target.value }))
                  }
                >
                  {Object.entries(materials).map(([id, m]) => (
                    <option key={id} value={id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="mt-4 space-y-3 border-none p-0">
              <legend className="sr-only">Cutting strategy</legend>
              <p className="text-xs text-slate-500">
                One-bit imports as <strong className="font-medium text-slate-400">Outline</strong>
                {" "}
                then <strong className="font-medium text-slate-400">Contour</strong> with the same
                tool. Contour uses <strong className="font-medium text-slate-400">Inside only</strong>{" "}
                and leaves <strong className="font-medium text-slate-400">Clip to stock</strong> off
                so Kiri does not “or” the big board rectangle with your silhouette (which would
                clear the whole stock). Quality here maps to Precision, Flatness, Reduction, and
                Step over in Kiri.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                  <input
                    type="radio"
                    name="camToolStrategy"
                    className="border-white/20 bg-slate-900 text-teal-500"
                    checked={answers.camToolStrategy === "single"}
                    onChange={() =>
                      setAnswers((a) => ({
                        ...a,
                        camToolStrategy: "single" satisfies CamToolStrategy,
                      }))
                    }
                  />
                  One bit → Outline + Contour (same cutter)
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                  <input
                    type="radio"
                    name="camToolStrategy"
                    className="border-white/20 bg-slate-900 text-teal-500"
                    checked={answers.camToolStrategy === "rough_outline"}
                    onChange={() =>
                      setAnswers((a) => ({
                        ...a,
                        camToolStrategy: "rough_outline" satisfies CamToolStrategy,
                      }))
                    }
                  />
                  Rough bulk clear + contour finish (tool per phase)
                </label>
              </div>
              {answers.camToolStrategy === "single" ? (
                <label className="block text-xs text-slate-400">
                  Tool
                  <select
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                    value={answers.singleToolId}
                    onChange={(e) =>
                      setAnswers((a) => ({
                        ...a,
                        singleToolId: Number(e.target.value),
                      }))
                    }
                  >
                    {presetTools.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs text-slate-400">
                    Roughing tool
                    <select
                      className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                      value={answers.roughToolId}
                      onChange={(e) =>
                        setAnswers((a) => ({
                          ...a,
                          roughToolId: Number(e.target.value),
                        }))
                      }
                    >
                      {presetTools.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-400">
                    Finishing contour (surface detail)
                    <select
                      className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                      value={answers.outlineToolId}
                      onChange={(e) =>
                        setAnswers((a) => ({
                          ...a,
                          outlineToolId: Number(e.target.value),
                        }))
                      }
                    >
                      {presetTools.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </fieldset>
            <label className="mt-3 block text-xs text-slate-400">
              Quality vs speed (step-over, chord tolerance & flatness in Kiri)
              <select
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                value={answers.qualityId}
                onChange={(e) =>
                  setAnswers((a) => ({
                    ...a,
                    qualityId: e.target.value as typeof answers.qualityId,
                  }))
                }
              >
                {Object.entries(qualities).map(([id, q]) => (
                  <option key={id} value={id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">
              <strong className="font-medium text-slate-400">How this maps into Kiri:</strong>{" "}
              Precision ≈ chord tolerance (smaller = closer mesh follow). Flatness ≈ surfacing
              fidelity. Reduction = mesh simplify steps before contour (0 = keep most detail).
              Step over scales pass spacing × tool ø. Outline Z-step also tightens toward{" "}
              <span className="text-slate-400">Replica</span>.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              For engraved reliefs, prefer <span className="text-slate-400">Fine</span> or{" "}
              <span className="text-slate-400">Replica</span> — Replica is much slower but drives
              the numbers above toward a tighter STL match.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">
              Where on the board?
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              “Center” lines the model up with the middle of your stock in Kiri.
              Other spots need a quick drag in Kiri after import (see note below).
            </p>
            <select
              className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100"
              value={answers.patternPlacement}
              onChange={(e) =>
                setAnswers((a) => ({
                  ...a,
                  patternPlacement: e.target.value as PatternPlacement,
                }))
              }
            >
              {PLACEMENTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-white">
              Where is the board on the machine?
            </h3>
            <select
              className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100"
              value={answers.stockOnBed}
              onChange={(e) =>
                setAnswers((a) => ({
                  ...a,
                  stockOnBed: e.target.value as StockOnBed,
                }))
              }
            >
              {BED_ANCHOR.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-slate-500">
              {BED_ANCHOR.find((b) => b.id === answers.stockOnBed)?.hint}
            </p>
          </section>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-950/30 p-3 text-sm text-amber-100/90">
            <input
              type="checkbox"
              checked={answers.hasProbePlate}
              onChange={(e) =>
                setAnswers((a) => ({ ...a, hasProbePlate: e.target.checked }))
              }
              className="mt-0.5 rounded border-amber-400/40"
            />
            <span>
              I have a touch plate (metal pad) to measure how far down the bit
              reaches — show reminders on the Run screen.
            </span>
          </label>

          {safety.length > 0 && (
            <ul className="space-y-2 rounded-xl border border-amber-500/25 bg-amber-950/20 p-3 text-sm text-amber-100/90">
              {safety.map((s, i) => (
                <li key={i}>{s.message}</li>
              ))}
            </ul>
          )}

          {importStatus && (
            <p className="rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-slate-300">
              {importStatus}
            </p>
          )}
        </div>

        <footer className="relative z-20 flex shrink-0 flex-col gap-3 border-t border-white/10 bg-slate-900/95 px-6 py-4">
          {importBlockedReason && (
            <p
              ref={importHintRef}
              className="text-xs leading-snug text-amber-200/90"
            >
              {importBlockedReason}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {onSkipToMachine && (
              <button
                type="button"
                onClick={onSkipToMachine}
                className="order-first w-full rounded-xl border border-sky-500/40 bg-sky-950/40 px-4 py-3 text-sm font-medium text-sky-100 hover:bg-sky-900/55 sm:order-none sm:w-auto"
              >
                Skip to Send to machine
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Close (Kiri stays open)
            </button>
            <button
              type="button"
              aria-disabled={!canImport}
              aria-busy={importBusy}
              onClick={handleImportClick}
              title={
                importBusy
                  ? "Sending to Kiri — tap again to resend (previous queued steps are cancelled)."
                  : !canImport
                    ? "Fix the items in amber above, or click to jump to the STL field."
                    : undefined
              }
              className={`touch-manipulation rounded-xl bg-gradient-to-r from-teal-500 to-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-teal-900/40 ${importBusy ? "opacity-90" : ""} ${!canImport ? "opacity-60 ring-1 ring-amber-400/50" : ""}`}
            >
              {importBusy ? "Sending… (tap to resend)" : "Import into Kiri:Moto"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  if (!portalReady) return overlay;
  return createPortal(overlay, document.body);
}
