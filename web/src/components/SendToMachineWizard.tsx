"use client";

import { useAppState } from "@/context/AppState";
import type { PatternPlacement, StockOnBed } from "@/lib/presets/types";
import { RunPanel } from "./RunPanel";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";

const GCODE_FILE_EXT = /\.(gcode|nc|ngc|tap|cnc|txt)$/i;
/** Browser holds the whole program in memory for USB streaming — cap avoids tab crashes. */
const MAX_GCODE_FILE_BYTES = 200 * 1024 * 1024;

type FetchStatus = "idle" | "loading" | "ready" | "error";

type Props = {
  iframeReady: boolean;
  fetchStatus: FetchStatus;
  onRequestKiriExport: () => void;
  /** Stop waiting for iframe `export.done` when the user loads a file or replaces G-code. */
  onCancelPendingKiriFetch: () => void;
};

/** Plain language: where to put XY zero on the real board vs Setup / Kiri. */
function xyTouchOffGuidance(
  stockOnBed: StockOnBed,
  patternPlacement: PatternPlacement,
): React.ReactNode {
  if (patternPlacement === "center") {
    return (
      <>
        <strong className="text-slate-200">Yes — that’s fine.</strong>{" "}
        <strong className="text-slate-200">Work zero</strong> means “this spot on the wood is X0 Y0.”
        You chose <strong className="text-slate-200">Center</strong> placement, so the job is
        centered in the stock box in Kiri —{" "}
        <strong className="text-slate-200">
          jog to about the middle of your real board (middle-ish is OK) and set XY zero there
        </strong>
        . Relief carving doesn’t need sub-millimeter XY touch-off; close is usually fine.
      </>
    );
  }

  if (stockOnBed === "centered") {
    return (
      <>
        Your <strong className="text-slate-200">board is centered</strong> on the table in Setup,
        but the carve is <strong className="text-slate-200">not</strong> in the middle of the stock
        in Kiri (you picked another placement). XY zero should be the{" "}
        <strong className="text-slate-200">same corner or edge</strong> on real wood as in the
        preview — usually <strong className="text-slate-200">not</strong> the geographic center of
        the block unless that happens to match the toolpath origin.
      </>
    );
  }

  return (
    <>
      You chose a <strong className="text-slate-200">corner / edge</strong> placement and stock
      anchored at the <strong className="text-slate-200">front-left</strong> of the bed. Jog so the
      bit is over the <strong className="text-slate-200">matching point</strong> on your board (often
      the front-left corner of the wood aligned with how you pictured the stock box in Kiri), then
      set XY zero there.
    </>
  );
}

export function SendToMachineWizard({
  iframeReady,
  fetchStatus,
  onRequestKiriExport,
  onCancelPendingKiriFetch,
}: Props) {
  const { answers, exportedGcode, setExportedGcode } = useAppState();
  const hasGcode = exportedGcode.trim().length > 0;

  const [step, setStep] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canGoMachine = hasGcode && fetchStatus !== "loading";

  const loadGcodeFromFile = useCallback(
    (file: File) => {
      setFileLoadError(null);
      if (!GCODE_FILE_EXT.test(file.name) && file.size > 0) {
        if (
          !window.confirm(
            `${file.name} does not look like a G-code extension. Load it anyway?`,
          )
        ) {
          return;
        }
      }
      if (file.size > MAX_GCODE_FILE_BYTES) {
        setFileLoadError(
          `This file is larger than ${Math.round(MAX_GCODE_FILE_BYTES / (1024 * 1024))} MB. The browser may not load huge programs — try simplifying the toolpath in Kiri, or split the job.`,
        );
        return;
      }
      if (
        file.size > 80 * 1024 * 1024 &&
        !window.confirm(
          `This file is ${Math.round(file.size / (1024 * 1024))} MB. Loading may take a moment and use a lot of memory. Continue?`,
        )
      ) {
        return;
      }
      void file.text().then(
        (text) => {
          onCancelPendingKiriFetch();
          setExportedGcode(text);
          setFileLoadError(null);
        },
        () => {
          setFileLoadError("Could not read that file.");
        },
      );
    },
    [onCancelPendingKiriFetch, setExportedGcode],
  );

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (f) loadGcodeFromFile(f);
    },
    [loadGcodeFromFile],
  );

  const downloadLoadedGcode = useCallback(() => {
    const text = exportedGcode.trim();
    if (!text) return;
    const blob = new Blob([exportedGcode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cncarve-job-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.nc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [exportedGcode]);

  const steps = useMemo(
    () => [
      { n: 1, label: "G-code" },
      { n: 2, label: "Machine" },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      {/* Step tabs */}
      <div className="flex gap-1 rounded-xl bg-slate-950/80 p-1 ring-1 ring-white/10">
        {steps.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => setStep(s.n)}
            className={`flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition ${
              step === s.n
                ? "bg-teal-600 text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <span className="block text-[10px] font-normal opacity-80">Step {s.n}</span>
            {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <section className="rounded-xl border border-white/10 bg-slate-950/60 p-4">
          <h3 className="text-base font-semibold text-white">Load toolpath into CNCarve</h3>
          <p className="mt-2 text-sm text-slate-400">
            Sync asks Kiri (over the iframe) to run the same export API as the toolbar. That only
            shows up in the console as CNCarve → Kiri lines. Clicking{" "}
            <strong className="text-slate-300">Export</strong> inside Kiri uses Kiri’s download UI —
            it does not send lines to CNCarve’s console; use the fallback below to load that file.
          </p>

          <div className="mt-4 rounded-xl border border-sky-500/35 bg-sky-950/25 p-4">
            <h4 className="text-sm font-semibold text-sky-200/95">1-click sync from Kiri</h4>
            {!iframeReady && (
              <p className="mt-2 text-sm text-amber-200/90">
                Wait until the Kiri 3D view is ready, then click sync.
              </p>
            )}
            <button
              type="button"
              disabled={!iframeReady || fetchStatus === "loading"}
              onClick={onRequestKiriExport}
              className="mt-3 w-full rounded-xl bg-sky-600 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {fetchStatus === "loading"
                ? "Syncing from Kiri…"
                : hasGcode && fetchStatus === "ready"
                  ? "Sync again from Kiri"
                  : "Sync G-code from Kiri"}
            </button>
            <p className="mt-2 text-xs text-slate-400">
              No download/upload needed when browser messaging is healthy.
            </p>
          </div>

          <details className="mt-4 rounded-xl border border-teal-500/30 bg-teal-950/20 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-teal-200/95">
              Fallback: export file from Kiri and drop it here
            </summary>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-slate-300">
              <li>
                In the Kiri toolbar, open <strong className="text-slate-200">Export</strong> and
                download your program (e.g. <code className="text-teal-300/90">.gcode</code>).
              </li>
              <li>
                Drop the file here, or use <strong className="text-slate-200">Choose file</strong>{" "}
                below.
              </li>
            </ol>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gcode,.nc,.ngc,.tap,.cnc,.txt,text/plain"
              className="sr-only"
              onChange={onFileInputChange}
            />
            <div
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragOver(false);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) loadGcodeFromFile(f);
              }}
              className={`mt-4 cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
                dragOver
                  ? "border-teal-400 bg-teal-950/40 text-teal-100"
                  : "border-white/15 bg-slate-950/40 text-slate-400 hover:border-white/25 hover:bg-slate-950/60"
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <p className="text-sm font-medium text-slate-200">
                Drop G-code file here or click to choose
              </p>
              <p className="mt-1 text-xs text-slate-500">
                .gcode, .nc, .ngc, .tap, … — up to ~{Math.round(MAX_GCODE_FILE_BYTES / (1024 * 1024))}{" "}
                MB (large relief jobs)
              </p>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 w-full rounded-xl border border-teal-500/40 bg-teal-950/50 py-2.5 text-sm font-medium text-teal-100 hover:bg-teal-900/60"
            >
              Choose file…
            </button>
            {fileLoadError && (
              <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
                {fileLoadError}
              </p>
            )}
          </details>

          {fetchStatus === "loading" && (
            <p className="mt-3 flex items-center gap-2 text-sm text-teal-300">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />
              Waiting for iframe export… use the file method above if this hangs.
            </p>
          )}

          {fetchStatus === "ready" && hasGcode && (
            <p className="mt-3 rounded-lg bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200 ring-1 ring-emerald-500/30">
              G-code is loaded ({Math.round(exportedGcode.length / 1024)} KB). Continue to touch-off
              when you are at the machine.
            </p>
          )}

          {hasGcode && (
            <button
              type="button"
              onClick={downloadLoadedGcode}
              className="mt-3 w-full rounded-xl border border-emerald-500/40 bg-emerald-950/40 py-2.5 text-sm font-medium text-emerald-100 hover:bg-emerald-900/50"
            >
              Download current G-code (.nc)
            </button>
          )}

          {fetchStatus === "error" && (
            <p className="mt-3 text-sm text-rose-300">
              Automatic transfer failed or timed out — use{" "}
              <strong className="text-rose-200">Export in Kiri → drop the file</strong> above, or
              paste below.
            </p>
          )}

          <details className="mt-4 text-sm text-slate-500">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-300">
              Paste or edit G-code manually
            </summary>
            <textarea
              className="mt-2 min-h-[120px] w-full rounded-lg border border-white/10 bg-slate-950/80 p-2 font-mono text-xs text-slate-200"
              placeholder=";(Paste G-code here)"
              value={exportedGcode}
              onChange={(e) => {
                onCancelPendingKiriFetch();
                setExportedGcode(e.target.value);
              }}
            />
            <p className="mt-1 text-xs">
              Editing here cancels a stuck automatic fetch and marks the job ready when the text is
              non-empty.
            </p>
          </details>

          <button
            type="button"
            disabled={!canGoMachine}
            onClick={() => setStep(2)}
            className="mt-5 w-full rounded-xl bg-teal-600 py-3 text-sm font-semibold text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next: machine controls
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <div className="rounded-xl border border-teal-500/25 bg-teal-950/20 px-3 py-3 text-xs leading-relaxed text-slate-300">
            <p className="font-semibold text-teal-200">Touch-off quick guide (no separate tab)</p>
            <p className="mt-1">
              XY zero must match the CAM origin location on your stock.{" "}
              <strong className="text-slate-100">XY:</strong>{" "}
              {xyTouchOffGuidance(answers.stockOnBed, answers.patternPlacement)}
            </p>
            <p className="mt-1">
              <strong className="text-slate-100">Z:</strong> use paper trick, then click
              <strong className="text-slate-100"> Set X/Y/Z zero</strong> in controls below.
            </p>
          </div>
          <RunPanel gcodeSourceHint="step 1" />
          <button
            type="button"
            onClick={() => setStep(1)}
            className="w-full rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:bg-white/5"
          >
            Back to G-code
          </button>
        </section>
      )}
    </div>
  );
}
