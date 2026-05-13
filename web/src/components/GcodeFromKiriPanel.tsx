"use client";

import { useAppState } from "@/context/AppState";
import type React from "react";
import { useCallback, useRef, useState } from "react";

const GCODE_FILE_EXT = /\.(gcode|nc|ngc|tap|cnc|txt)$/i;
const MAX_GCODE_FILE_BYTES = 200 * 1024 * 1024;

export type GcodeFromKiriPanelProps = {
  onCancelPendingKiriFetch: () => void;
  compact?: boolean;
  /** Light, dense layout to sit beside Kiri’s UI */
  appearance?: "default" | "kiri";
};

function KiriExportToolbarIllustration({
  className,
  light,
}: {
  className?: string;
  light?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 280 36"
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        width="280"
        height="36"
        rx="4"
        className={light ? "fill-zinc-200 stroke-zinc-400/80" : "fill-slate-800/90 stroke-white/15"}
        strokeWidth="1"
      />
      <text x="8" y="15" className={light ? "fill-zinc-500 text-[8px]" : "fill-slate-500 text-[10px]"}>
        Arrange · Slice · Preview
      </text>
      <rect
        x="198"
        y="7"
        width="58"
        height="22"
        rx="3"
        className={light ? "fill-teal-600 stroke-teal-700/40" : "fill-teal-600/90 stroke-teal-400/60"}
        strokeWidth="1"
      />
      <text x="208" y="22" className="fill-white text-[9px] font-semibold">
        Export
      </text>
    </svg>
  );
}

function FileToPanelIllustration({ className, light }: { className?: string; light?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 160 36" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect
        x="4"
        y="6"
        width="52"
        height="24"
        rx="3"
        className={light ? "fill-white stroke-zinc-400" : "fill-slate-700 stroke-white/20"}
        strokeWidth="1"
      />
      <text x="12" y="22" className={light ? "fill-zinc-500 text-[8px] font-mono" : "fill-slate-400 text-[10px] font-mono"}>
        .nc
      </text>
      <path
        d="M62 18 L88 18 M80 13 L88 18 L80 23"
        className={light ? "stroke-teal-600" : "stroke-teal-400"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="96"
        y="7"
        width="60"
        height="22"
        rx="3"
        className={
          light
            ? "fill-teal-50 stroke-teal-500/60"
            : "fill-teal-950/80 stroke-teal-500/50"
        }
        strokeWidth="1"
        strokeDasharray="3 2"
      />
      <text x="106" y="22" className={light ? "fill-teal-800 text-[8px] font-medium" : "fill-teal-200/90 text-[9px] font-medium"}>
        Drop
      </text>
    </svg>
  );
}

export function GcodeFromKiriPanel({
  onCancelPendingKiriFetch,
  compact,
  appearance = "default",
}: GcodeFromKiriPanelProps) {
  const { exportedGcode, setExportedGcode } = useAppState();
  const [dragOver, setDragOver] = useState(false);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kiri = appearance === "kiri";

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
          `This file is larger than ${Math.round(MAX_GCODE_FILE_BYTES / (1024 * 1024))} MB. Try simplifying the toolpath in Kiri, or split the job.`,
        );
        return;
      }
      if (
        file.size > 80 * 1024 * 1024 &&
        !window.confirm(
          `This file is ${Math.round(file.size / (1024 * 1024))} MB. Loading may take a moment. Continue?`,
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

  if (kiri) {
    return (
      <div className="rounded border border-zinc-300/90 bg-zinc-50/90 p-2">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="mb-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
              Kiri
            </p>
            <KiriExportToolbarIllustration className="h-auto w-full" light />
          </div>
          <div>
            <p className="mb-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
              Here
            </p>
            <FileToPanelIllustration className="mx-auto h-auto w-full max-w-[9.5rem]" light />
          </div>
        </div>

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
          className={`mt-1.5 cursor-pointer rounded border border-dashed px-2 py-2.5 text-center transition ${
            dragOver
              ? "border-teal-500 bg-teal-50"
              : "border-zinc-400 bg-white hover:border-teal-500/70"
          }`}
          onClick={() => fileInputRef.current?.click()}
        >
          <p className="text-[11px] font-medium text-zinc-800">Drop file or click</p>
          <p className="mt-0.5 text-[9px] text-zinc-500">.gcode .nc .ngc · max ~200 MB</p>
        </div>
        {fileLoadError && (
          <p className="mt-1.5 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-900">
            {fileLoadError}
          </p>
        )}
        {exportedGcode.trim().length > 0 && (
          <p className="mt-1.5 rounded border border-emerald-300/80 bg-emerald-50/90 px-2 py-1 text-center text-[10px] text-emerald-900">
            {Math.round(exportedGcode.length / 1024)} KB loaded
          </p>
        )}
      </div>
    );
  }

  const p = compact ? "text-xs" : "text-sm";
  const h = compact ? "text-sm" : "text-base";
  const box = compact ? "p-3" : "p-4";

  return (
    <div className={`rounded-xl border border-teal-500/35 bg-teal-950/25 ${box}`}>
      <h4 className={`${h} font-semibold text-teal-100`}>Load G-code from Kiri (file export)</h4>
      <p className={`mt-2 ${p} leading-relaxed text-slate-400`}>
        Use Kiri’s own <strong className="text-slate-200">Export</strong> button — it saves a file to
        your computer. Then load that file here (drag-and-drop or click the area below).
      </p>

      <div className={`mt-3 grid gap-3 ${compact ? "sm:grid-cols-1" : "sm:grid-cols-2"}`}>
        <div className="rounded-lg border border-white/10 bg-slate-950/50 p-2">
          <p className="mb-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Step 1 — in Kiri
          </p>
          <KiriExportToolbarIllustration className="h-auto w-full max-w-[min(100%,20rem)]" />
          <p className={`mt-2 ${compact ? "text-[11px]" : "text-xs"} text-slate-500`}>
            After Preview/Animate, click <strong className="text-slate-300">Export</strong> and save
            your <code className="text-teal-300/90">.gcode</code> or <code className="text-teal-300/90">.nc</code> file.
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/50 p-2">
          <p className="mb-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Step 2 — here
          </p>
          <FileToPanelIllustration className="mx-auto h-auto w-full max-w-[12rem]" />
          <p className={`mt-2 ${compact ? "text-[11px]" : "text-xs"} text-slate-500`}>
            Drop the saved file into the box below.
          </p>
        </div>
      </div>

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
        className={`mt-3 cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
          dragOver
            ? "border-teal-400 bg-teal-950/50 text-teal-100"
            : "border-white/15 bg-slate-950/50 text-slate-400 hover:border-teal-500/40 hover:bg-slate-950/70"
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <p className={`font-medium text-slate-200 ${compact ? "text-xs" : "text-sm"}`}>
          Drop G-code file here or click to choose
        </p>
        <p className={`mt-1 text-slate-500 ${compact ? "text-[10px]" : "text-xs"}`}>
          .gcode, .nc, .ngc, .tap — up to ~{Math.round(MAX_GCODE_FILE_BYTES / (1024 * 1024))} MB
        </p>
      </div>
      {fileLoadError && (
        <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {fileLoadError}
        </p>
      )}
      {exportedGcode.trim().length > 0 && (
        <p className="mt-2 rounded-lg bg-emerald-950/40 px-2 py-1.5 text-center text-[11px] text-emerald-200/95 ring-1 ring-emerald-500/25">
          Loaded {Math.round(exportedGcode.length / 1024)} KB — open{" "}
          <strong className="text-emerald-100">Companion</strong> (CNC strip, bottom-left) for
          touch-off and send.
        </p>
      )}
    </div>
  );
}
