"use client";

import { useAppState } from "@/context/AppState";
import {
  importIntoKiri,
  invalidatePendingKiriImports,
  isKiriDebugEnabled,
  isKiriIframeReady,
  KIRI_ORIGIN,
  KIRI_URL,
  registerKiriFrameCallbacks,
  requestKiriCancel,
  requestKiriExport,
  requestKiriPrepare,
  requestKiriSlice,
  summarizeKiriPayload,
} from "@/lib/kiriBridge";
import { isWebGlLikelyAvailable } from "@/lib/webglCheck";
import { buildStlForKiri } from "@/lib/stockTransform";
import type { WizardAnswers } from "@/lib/presets/types";
import { isPatternSizeReady, mapWizardToKiri } from "@/lib/wizard";
import { useCallback, useEffect, useRef, useState } from "react";
import { SendToMachineWizard } from "./SendToMachineWizard";
import { SetupWizard } from "./SetupWizard";

/** Kiri Frame API uses `loaded` after mesh import; some builds may use `parsed`. */
const KIRI_MESH_IMPORT_EVENTS = new Set(["loaded", "parsed"]);
/**
 * FDM demo uses `slice.done`; GridSpace docs list `slice.end`.
 * CAM / preview often finishes as `preview.end` or legacy `print` — not `slice.done`.
 * @see https://docs.grid.space/kiri-moto/apis (Events table)
 */
const KIRI_SLICE_DONE = new Set([
  "slice.done",
  "slice.end",
  "preview.end",
  "print",
]);
const KIRI_PREPARE_DONE = new Set(["prepare.done", "prepare.end"]);

const KIRI_DEBUG_TOAST_HINT =
  ' Logs: F12 → Console → localStorage.setItem("cnkiri.debug","1") → reload → Import again (watch for lines tagged [Kiri → CNCarve] and [CNCarve → Kiri]).';

/** Total wait cap; export-first path usually finishes in 1–3 min when Preview already ran in Kiri. */
const KIRI_SYNC_MAX_WAIT_MS = 20 * 60 * 1000;
/** If `export` alone yields no `export.done`, run full slice → prepare → export (cold path). */
/** If `export.done` never arrives, fall back to full slice → prepare → export. Keep this above typical “Export after Preview” time (~1–2 min) to avoid double work. */
const KIRI_EXPORT_FIRST_FALLBACK_MS = 180_000;
/** Large CAM meshes can exceed 75s for slice/preview before `slice.done` / `prepare.done` callbacks. */
const KIRI_SLICE_PHASE_FALLBACK_MS = 240_000;
/** After cancel, let Kiri’s worker settle before slice (ms). */
const KIRI_CANCEL_BEFORE_SLICE_MS = 600;

function formatSyncElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function FullWorkspace() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const importWatchdogRef = useRef<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(true);
  const [dock, setDock] = useState<null | "send">(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [kiriFrameLoaded, setKiriFrameLoaded] = useState(false);
  /** Remount iframe to recover from WebGL context loss (Kiri needs WebGL; without it postMessage import breaks internally). */
  const [kiriIframeKey, setKiriIframeKey] = useState(0);
  const [machinePanelPos, setMachinePanelPos] = useState({ x: 24, y: 72 });
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null);

  const { answers, stlBuffer, setExportedGcode, exportedGcode } = useAppState();
  /** Always use the latest buffer at click time (avoids stale closure if context updates same tick). */
  const stlBufferRef = useRef<ArrayBuffer | null>(null);
  stlBufferRef.current = stlBuffer;

  const gcodeFetchTimeoutRef = useRef<number | null>(null);
  const gcodeFetchRetryRef = useRef<number | null>(null);
  const gcodeFetchAttemptsRef = useRef(0);
  /** True only after "Load G-code from Kiri" — ignores stray `export.done` from Kiri during STL import. */
  const expectingKiriGcodeRef = useRef(false);
  /**
   * `export_quick` = one postMessage export (like UI Export after Preview).
   * Full `slice` → `prepare` → `export` only if that fails or times out.
   */
  const kiriExportPipelineRef = useRef<
    "idle" | "export_quick" | "slice" | "prepare" | "export"
  >("idle");
  const slicePhaseFallbackRef = useRef<number | null>(null);
  const preparePhaseFallbackRef = useRef<number | null>(null);
  const exportQuickFallbackRef = useRef<number | null>(null);
  const kiriSyncStartedAtRef = useRef<number>(0);
  const clearGcodeFetchTimeout = useCallback(() => {
    if (gcodeFetchTimeoutRef.current != null) {
      window.clearTimeout(gcodeFetchTimeoutRef.current);
      gcodeFetchTimeoutRef.current = null;
    }
    if (gcodeFetchRetryRef.current != null) {
      window.clearTimeout(gcodeFetchRetryRef.current);
      gcodeFetchRetryRef.current = null;
    }
    if (slicePhaseFallbackRef.current != null) {
      window.clearTimeout(slicePhaseFallbackRef.current);
      slicePhaseFallbackRef.current = null;
    }
    if (preparePhaseFallbackRef.current != null) {
      window.clearTimeout(preparePhaseFallbackRef.current);
      preparePhaseFallbackRef.current = null;
    }
    if (exportQuickFallbackRef.current != null) {
      window.clearTimeout(exportQuickFallbackRef.current);
      exportQuickFallbackRef.current = null;
    }
    gcodeFetchAttemptsRef.current = 0;
    expectingKiriGcodeRef.current = false;
    kiriExportPipelineRef.current = "idle";
  }, []);

  type GcodeFetchStatus = "idle" | "loading" | "ready" | "error";
  const [gcodeFetchStatus, setGcodeFetchStatus] =
    useState<GcodeFetchStatus>("idle");

  useEffect(() => {
    if (exportedGcode.trim().length === 0) {
      setGcodeFetchStatus((s) => (s === "loading" ? "loading" : "idle"));
      return;
    }
    setGcodeFetchStatus("ready");
  }, [exportedGcode]);

  /** While Kiri is generating G-code, refresh status so long runs don’t look frozen. */
  useEffect(() => {
    if (gcodeFetchStatus !== "loading" || !expectingKiriGcodeRef.current) {
      return;
    }
    const tick = () => {
      if (!expectingKiriGcodeRef.current) return;
      const elapsedSec = (Date.now() - kiriSyncStartedAtRef.current) / 1000;
      const phase = kiriExportPipelineRef.current;
      const elapsed = formatSyncElapsed(elapsedSec);
      if (phase === "export_quick") {
        setImportStatus(
          `Kiri: exporting G-code (same as Export after Preview)… Elapsed ${elapsed}. If you already previewed in Kiri, this is often ~1–2 minutes.`,
        );
      } else if (phase === "slice") {
        setImportStatus(
          `Kiri: slicing / preview… Elapsed ${elapsed}. Full recompute — can take a few minutes on big meshes.`,
        );
      } else if (phase === "prepare") {
        setImportStatus(
          `Kiri: preparing toolpaths… Elapsed ${elapsed}.`,
        );
      } else if (phase === "export") {
        setImportStatus(
          `Kiri: writing G-code… Elapsed ${elapsed}. Usually a few minutes; very large programs can take longer.`,
        );
      }
    };
    tick();
    const id = window.setInterval(tick, 12_000);
    return () => window.clearInterval(id);
  }, [gcodeFetchStatus]);

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const fromKiriFrame = iframeRef.current?.contentWindow === ev.source;
      const fromKiriOrigin =
        ev.origin === KIRI_ORIGIN || ev.origin === "https://www.grid.space";
      if (!fromKiriFrame && !fromKiriOrigin) return;
      if (fromKiriOrigin) setKiriFrameLoaded(true);
      const debug = isKiriDebugEnabled();
      const raw = ev.data;
      if (debug) {
        const summary =
          raw !== null && typeof raw === "object"
            ? summarizeKiriPayload(raw)
            : raw;
        console.info("[Kiri → CNCarve]", summary);
      } else if (raw !== null && typeof raw === "object") {
        const pe = (raw as Record<string, unknown>).event;
        if (pe === "loaded" || pe === "parsed" || pe === "ready") {
          console.info("[Kiri → CNCarve]", { event: pe, hint: "Full traffic: set cnkiri.debug=1" });
        }
      }

      if (raw === null || typeof raw !== "object") {
        if (debug && raw !== undefined) {
          console.info("[Kiri → CNCarve] non-object payload", raw);
        }
        return;
      }

      const d = raw as Record<string, unknown>;
      if (Array.isArray(d.widgets)) {
        const count = d.widgets.length;
        if (count > 0) {
          setImportBusy(false);
          setImportStatus("Model loaded in Kiri — widget list confirms the import.");
          if (debug) {
            console.info("[CNCarve] Kiri widget check confirmed import.", {
              count,
            });
          }
        } else if (debug) {
          console.info("[CNCarve] Kiri widget check returned no models yet.");
        }
      }
      const topEvent =
        typeof d.event === "string"
          ? (d.event as string)
          : d.data != null &&
              typeof d.data === "object" &&
              "event" in (d.data as object) &&
              typeof (d.data as { event?: unknown }).event === "string"
            ? String((d.data as { event: string }).event)
            : null;

      if (topEvent && debug && expectingKiriGcodeRef.current) {
        console.info("[CNCarve] Kiri pipeline event:", topEvent);
      }

      if (typeof d.event === "string" || topEvent) {
        const evName = (typeof d.event === "string" ? d.event : topEvent) as string;
        if (KIRI_MESH_IMPORT_EVENTS.has(evName)) {
          setImportBusy(false);
          setImportStatus("Model loaded in Kiri — you should see it on the platform.");
          if (debug) {
            console.info(`[CNCarve] Kiri mesh import confirmed (${evName}).`, d.data);
          }
        }
        if (
          expectingKiriGcodeRef.current &&
          KIRI_SLICE_DONE.has(evName) &&
          kiriExportPipelineRef.current === "slice"
        ) {
          if (slicePhaseFallbackRef.current != null) {
            window.clearTimeout(slicePhaseFallbackRef.current);
            slicePhaseFallbackRef.current = null;
          }
          kiriExportPipelineRef.current = "prepare";
          setImportStatus("Kiri slice/preview finished — preparing toolpaths…");
          requestKiriPrepare(iframeRef.current);
          preparePhaseFallbackRef.current = window.setTimeout(() => {
            preparePhaseFallbackRef.current = null;
            if (
              !expectingKiriGcodeRef.current ||
              kiriExportPipelineRef.current !== "prepare"
            ) {
              return;
            }
            if (isKiriDebugEnabled()) {
              console.info(
                "[CNCarve] No prepare.done from Kiri — calling export (fallback)",
              );
            }
            kiriExportPipelineRef.current = "export";
            setImportStatus(
              "Prepare callback missing — generating G-code (fallback)…",
            );
            requestKiriExport(iframeRef.current);
          }, 180_000);
        }
        if (
          expectingKiriGcodeRef.current &&
          KIRI_PREPARE_DONE.has(evName) &&
          kiriExportPipelineRef.current === "prepare"
        ) {
          if (preparePhaseFallbackRef.current != null) {
            window.clearTimeout(preparePhaseFallbackRef.current);
            preparePhaseFallbackRef.current = null;
          }
          kiriExportPipelineRef.current = "export";
          setImportStatus("Kiri prepare finished — generating G-code…");
          requestKiriExport(iframeRef.current);
        }
        if (evName === "export.done" && expectingKiriGcodeRef.current) {
          clearGcodeFetchTimeout();
          const raw = d.data;
          const gcode =
            typeof raw === "string"
              ? raw
              : raw != null &&
                  typeof raw === "object" &&
                  "data" in (raw as object)
                ? String((raw as { data?: unknown }).data ?? "")
                : "";
          if (gcode.length > 0) {
            setExportedGcode(gcode);
            setGcodeFetchStatus("ready");
            setImportStatus("G-code ready — continue in Send to machine.");
            setDock("send");
          } else {
            setGcodeFetchStatus("error");
            setImportStatus(
              "Kiri returned empty G-code — run Preview in Kiri, then try Load again or paste G-code.",
            );
          }
        }
        if (evName.endsWith(".error")) {
          setImportBusy(false);
          kiriExportPipelineRef.current = "idle";
          clearGcodeFetchTimeout();
          setGcodeFetchStatus((s) => (s === "loading" ? "error" : s));
          const detail =
            d.data != null && typeof d.data === "string"
              ? d.data
              : "";
          setImportStatus(
            detail
              ? `Kiri reported ${evName}: ${detail}`
              : `Kiri reported ${evName} — check the browser console (F12) for details.`,
          );
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [setExportedGcode, clearGcodeFetchTimeout]);

  /** Very large G-code strings can fail structured clone / postMessage limits; Kiri then never delivers `export.done`. */
  useEffect(() => {
    function onMsgErr() {
      if (!expectingKiriGcodeRef.current) return;
      console.warn(
        "[CNCarve] messageerror while waiting for Kiri — payload may be too large for iframe postMessage, or the message was invalid.",
      );
      setImportStatus(
        "The browser could not take G-code from Kiri through the iframe bridge (common with very large programs). In Kiri use Export → save the file → drop it into Send to machine → Fallback.",
      );
    }
    window.addEventListener("messageerror", onMsgErr);
    return () => window.removeEventListener("messageerror", onMsgErr);
  }, []);

  const handleFetchFromKiri = useCallback(() => {
    if (!isKiriIframeReady(iframeRef.current)) {
      setImportStatus("Kiri’s iframe isn’t ready — wait for the CAM view to load.");
      return;
    }
    clearGcodeFetchTimeout();
    kiriSyncStartedAtRef.current = Date.now();
    setGcodeFetchStatus("loading");
    expectingKiriGcodeRef.current = true;
    registerKiriFrameCallbacks(iframeRef.current, [
      "slice.done",
      "slice.end",
      "prepare.done",
      "prepare.end",
      "export.done",
      "preview.end",
      "print",
    ]);

    const scheduleExportFallbackAfterPrepare = () => {
      if (preparePhaseFallbackRef.current != null) {
        window.clearTimeout(preparePhaseFallbackRef.current);
        preparePhaseFallbackRef.current = null;
      }
      preparePhaseFallbackRef.current = window.setTimeout(() => {
        preparePhaseFallbackRef.current = null;
        if (
          !expectingKiriGcodeRef.current ||
          kiriExportPipelineRef.current !== "prepare"
        ) {
          return;
        }
        if (isKiriDebugEnabled()) {
          console.info(
            "[CNCarve] No prepare.done from Kiri — calling export (fallback)",
          );
        }
        kiriExportPipelineRef.current = "export";
        setImportStatus("Kiri: generating G-code…");
        requestKiriExport(iframeRef.current);
      }, 180_000);
    };

    const retryPipeline = () => {
      if (!expectingKiriGcodeRef.current) return;
      if (!isKiriIframeReady(iframeRef.current)) return;
      if (gcodeFetchAttemptsRef.current >= 3) return;
      if (kiriExportPipelineRef.current !== "slice") return;
      gcodeFetchAttemptsRef.current += 1;
      kiriExportPipelineRef.current = "slice";
      requestKiriSlice(iframeRef.current);
      setImportStatus(
        `Still stuck on slice — restarting slice (attempt ${gcodeFetchAttemptsRef.current}/3).`,
      );
      gcodeFetchRetryRef.current = window.setTimeout(retryPipeline, 120_000);
    };

    const attachFullSlicePipelineTimers = () => {
      slicePhaseFallbackRef.current = window.setTimeout(() => {
        slicePhaseFallbackRef.current = null;
        if (
          !expectingKiriGcodeRef.current ||
          kiriExportPipelineRef.current !== "slice"
        ) {
          return;
        }
        if (isKiriDebugEnabled()) {
          console.info(
            "[CNCarve] No slice/preview.done from Kiri — calling prepare (fallback)",
          );
        }
        kiriExportPipelineRef.current = "prepare";
        setImportStatus(
          "Slice/preview callback missing — preparing toolpaths (fallback)…",
        );
        requestKiriPrepare(iframeRef.current);
        scheduleExportFallbackAfterPrepare();
      }, KIRI_SLICE_PHASE_FALLBACK_MS);
      gcodeFetchRetryRef.current = window.setTimeout(retryPipeline, 120_000);
    };

    const startFullRecomputeFromSlice = () => {
      if (exportQuickFallbackRef.current != null) {
        window.clearTimeout(exportQuickFallbackRef.current);
        exportQuickFallbackRef.current = null;
      }
      kiriExportPipelineRef.current = "slice";
      setImportStatus(
        "Stopping in-flight Kiri work, then slice → prepare → export (avoids overlapping export + slice).",
      );
      requestKiriCancel(iframeRef.current);
      window.setTimeout(() => {
        if (
          !expectingKiriGcodeRef.current ||
          kiriExportPipelineRef.current !== "slice"
        ) {
          return;
        }
        setImportStatus(
          "Kiri: slicing / preview… (then prepare → G-code). Large meshes can take several minutes.",
        );
        const okSlice = requestKiriSlice(iframeRef.current);
        if (!okSlice) {
          expectingKiriGcodeRef.current = false;
          kiriExportPipelineRef.current = "idle";
          setGcodeFetchStatus("error");
          setImportStatus("Could not reach Kiri — try again.");
          return;
        }
        attachFullSlicePipelineTimers();
      }, KIRI_CANCEL_BEFORE_SLICE_MS);
    };

    // 1) Same as clicking Export after Preview — avoids redoing ~30s slice when toolpath already exists.
    kiriExportPipelineRef.current = "export_quick";
    const ok = requestKiriExport(iframeRef.current);
    if (!ok) {
      expectingKiriGcodeRef.current = false;
      kiriExportPipelineRef.current = "idle";
      setGcodeFetchStatus("error");
      setImportStatus("Could not reach Kiri — try again.");
      return;
    }
    gcodeFetchAttemptsRef.current = 1;
    setImportStatus(
      "Kiri: exporting G-code (like Export after Preview). If you already ran Preview, this is usually ~1–2 minutes.",
    );

    exportQuickFallbackRef.current = window.setTimeout(() => {
      exportQuickFallbackRef.current = null;
      if (
        !expectingKiriGcodeRef.current ||
        kiriExportPipelineRef.current !== "export_quick"
      ) {
        return;
      }
      if (isKiriDebugEnabled()) {
        console.info(
          "[CNCarve] export-only timed out — starting full slice → prepare → export",
        );
      }
      startFullRecomputeFromSlice();
    }, KIRI_EXPORT_FIRST_FALLBACK_MS);

    gcodeFetchTimeoutRef.current = window.setTimeout(() => {
      gcodeFetchTimeoutRef.current = null;
      setGcodeFetchStatus((s) => (s === "loading" ? "error" : s));
      setImportStatus(
        "Timed out waiting for Kiri G-code over the iframe bridge. Reference: https://github.com/GridSpace/grid-apps/blob/master/src/kiri/run/frame.js — or use Export in Kiri → drop file.",
      );
      clearGcodeFetchTimeout();
    }, KIRI_SYNC_MAX_WAIT_MS);
  }, [clearGcodeFetchTimeout]);

  useEffect(
    () => () => {
      if (importWatchdogRef.current) {
        clearTimeout(importWatchdogRef.current);
        importWatchdogRef.current = null;
      }
      if (gcodeFetchTimeoutRef.current) {
        window.clearTimeout(gcodeFetchTimeoutRef.current);
        gcodeFetchTimeoutRef.current = null;
      }
      if (gcodeFetchRetryRef.current) {
        window.clearTimeout(gcodeFetchRetryRef.current);
        gcodeFetchRetryRef.current = null;
      }
      if (slicePhaseFallbackRef.current) {
        window.clearTimeout(slicePhaseFallbackRef.current);
        slicePhaseFallbackRef.current = null;
      }
      if (preparePhaseFallbackRef.current) {
        window.clearTimeout(preparePhaseFallbackRef.current);
        preparePhaseFallbackRef.current = null;
      }
      if (exportQuickFallbackRef.current) {
        window.clearTimeout(exportQuickFallbackRef.current);
        exportQuickFallbackRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current || dragRef.current.id !== ev.pointerId) return;
      setMachinePanelPos({
        x: Math.max(8, ev.clientX - dragRef.current.dx),
        y: Math.max(8, ev.clientY - dragRef.current.dy),
      });
    };
    const onUp = (ev: PointerEvent) => {
      if (dragRef.current?.id === ev.pointerId) dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const restartKiriWorkspace = useCallback(() => {
    invalidatePendingKiriImports();
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setKiriIframeKey((k) => k + 1);
    setKiriFrameLoaded(false);
    setImportBusy(false);
    setImportStatus(
      "Restarting Kiri — wait until the grid/3D view shows in the background, then tap Import again. If the view stays black, reload the whole page.",
    );
  }, [clearGcodeFetchTimeout]);

  const openSetup = useCallback(() => {
    if (importWatchdogRef.current) {
      clearTimeout(importWatchdogRef.current);
      importWatchdogRef.current = null;
    }
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setImportBusy(false);
    setWizardOpen(true);
  }, [clearGcodeFetchTimeout]);

  const openMachineCompanion = useCallback(() => {
    if (importWatchdogRef.current) {
      clearTimeout(importWatchdogRef.current);
      importWatchdogRef.current = null;
    }
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setImportBusy(false);
    setWizardOpen(false);
    setDock("send");
  }, [clearGcodeFetchTimeout]);

  const skipToMachineFromSetup = useCallback(() => {
    if (importWatchdogRef.current) {
      clearTimeout(importWatchdogRef.current);
      importWatchdogRef.current = null;
    }
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setImportBusy(false);
    setWizardOpen(false);
    setDock("send");
    setImportStatus(
      "Send to machine is open — load your G-code in step 1, then use steps 2–3 to touch off and stream over USB.",
    );
  }, [clearGcodeFetchTimeout]);

  const handleImportToKiri = useCallback((answersOverride?: WizardAnswers) => {
    const effectiveAnswers = answersOverride ?? answers;
    const buffer = stlBufferRef.current;
    if (!buffer?.byteLength) {
      setImportStatus(
        "Choose an STL file in the setup panel first — if you just picked one, wait a second and tap Import again while the file finishes loading.",
      );
      return;
    }
    if (!isPatternSizeReady(effectiveAnswers)) {
      setImportStatus(
        "Set carved size first — upload a binary STL so sizes fill in, or enter X/Y/Z under STL size.",
      );
      return;
    }
    if (!isWebGlLikelyAvailable()) {
      setImportStatus(
        "3D view (WebGL) is not available — often after many tabs or a lost GPU context. Reload this tab, close heavy tabs, then click Restart Kiri workspace and try Import again.",
      );
      return;
    }
    // Only require a real iframe window. Do not gate on `load` events — onLoad/bfcache can skip firing,
    // which blocked Import even though Kiri was ready (regression users saw as a “dead” button).
    if (!isKiriIframeReady(iframeRef.current)) {
      setImportStatus(
        "Kiri’s frame is not available — refresh the page. If this persists, check that the page is not blocking iframes.",
      );
      return;
    }
    if (importWatchdogRef.current) {
      clearTimeout(importWatchdogRef.current);
      importWatchdogRef.current = null;
    }
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setImportBusy(true);
    setImportStatus(
      "Sending to Kiri… this can take several seconds on first load; the button will unlock when the model is loaded or if something fails.",
    );
    try {
      // Validates binary STL, pattern size, and scaling math.
      const built = buildStlForKiri(buffer, effectiveAnswers);
      // Always send wizard-scaled STL so Kiri matches requested dimensions.
      const stlForKiri = built.buffer;
      const payload = mapWizardToKiri(effectiveAnswers);
      const ok = importIntoKiri(iframeRef.current, {
        device: payload.device as Record<string, unknown>,
        process: payload.process as Record<string, unknown>,
        controller: payload.controller as Record<string, unknown>,
        stlBuffer: stlForKiri,
      });
      if (!ok) {
        setImportBusy(false);
        setImportStatus("Could not reach Kiri’s iframe — refresh the page and try again.");
        return;
      }
      setWizardOpen(false);
      setDock("send");
      const stockNote =
        effectiveAnswers.displayUnits === "in"
          ? " Note: Kiri may display values in inches or millimeters depending on its local UI mode."
          : "";
      setImportStatus(
        `Sending wizard-scaled STL to Kiri — you should see the mesh in a few seconds. Machine companion is open so you can export/load G-code next.${stockNote}`,
      );
      importWatchdogRef.current = window.setTimeout(() => {
        importWatchdogRef.current = null;
        setImportBusy((busy) => {
          if (busy) {
            setImportStatus((prev) =>
              prev?.includes("Model loaded in Kiri")
                ? prev
                : `No confirmation from Kiri yet — check the iframe for the model, or try Import again after it finishes loading.${isKiriDebugEnabled() ? "" : KIRI_DEBUG_TOAST_HINT}`,
            );
          }
          return false;
        });
      }, 15_000);
    } catch (e) {
      setImportStatus(e instanceof Error ? e.message : String(e));
      setImportBusy(false);
    }
  }, [answers, clearGcodeFetchTimeout]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-slate-950 text-slate-100">
      <iframe
        key={kiriIframeKey}
        ref={iframeRef}
        title="Kiri:Moto"
        src={KIRI_URL}
        aria-hidden={wizardOpen}
        className={`absolute inset-0 z-0 h-full w-full border-0 ${wizardOpen ? "pointer-events-none" : ""}`}
        allow="fullscreen"
        onLoad={() => setKiriFrameLoaded(true)}
      />

      <div className="pointer-events-auto absolute bottom-4 left-4 z-30 group">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/80 px-2 py-2 shadow-lg backdrop-blur-md transition-all duration-200 group-hover:bg-slate-900/92">
          <span className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-semibold tracking-wide text-slate-200">
            CNC
          </span>
          <div className="max-w-0 overflow-hidden opacity-0 transition-all duration-200 group-hover:ml-1 group-hover:max-w-xs group-hover:opacity-100">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openSetup}
                className="whitespace-nowrap rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700"
              >
                Setup
              </button>
              <button
                type="button"
                onClick={openMachineCompanion}
                className="whitespace-nowrap rounded-lg bg-teal-700/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-600"
              >
                Companion
              </button>
            </div>
          </div>
        </div>
      </div>

      {!dock && !wizardOpen && (
        <button
          type="button"
          onClick={openMachineCompanion}
          className="pointer-events-auto absolute bottom-4 right-4 z-30 rounded-xl border border-white/15 bg-slate-900/90 px-4 py-2 text-sm font-medium text-white shadow-xl backdrop-blur-md hover:bg-slate-800"
        >
          Open companion
        </button>
      )}

      {!wizardOpen && importStatus && (
        <div
          className="pointer-events-auto absolute bottom-16 left-1/2 z-30 w-[min(92vw,28rem)] -translate-x-1/2 rounded-xl border border-white/15 bg-slate-900/95 px-4 py-3 text-center text-sm text-slate-200 shadow-xl backdrop-blur-md md:bottom-6"
          role="status"
        >
          {importStatus}
          <button
            type="button"
            className="ml-2 text-xs text-teal-400 underline hover:text-teal-300"
            onClick={() => setImportStatus(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {!wizardOpen && (
        <button
          type="button"
          onClick={openSetup}
          className="pointer-events-auto absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-teal-600 px-5 py-2.5 text-sm font-medium text-white shadow-xl shadow-teal-950/50 hover:bg-teal-500 md:hidden"
        >
          Open setup
        </button>
      )}

      <SetupWizard
        open={wizardOpen}
        onDismiss={() => setWizardOpen(false)}
        onImportToKiri={handleImportToKiri}
        onSkipToMachine={skipToMachineFromSetup}
        importStatus={importStatus}
        importBusy={importBusy}
      />

      {dock && (
        <div
          className="pointer-events-auto absolute z-40 flex h-[min(88dvh,56rem)] w-[min(96vw,32rem)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95 shadow-2xl backdrop-blur-md"
          style={{ left: machinePanelPos.x, top: machinePanelPos.y }}
        >
          <div
            className="flex cursor-move items-center justify-between border-b border-white/10 px-4 py-3"
            onPointerDown={(ev) => {
              const rect = (ev.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
              dragRef.current = { id: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
            }}
          >
            <div className="w-full">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Machine companion</h2>
                <button
                  type="button"
                  onClick={() => setDock(null)}
                  className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  Close
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-slate-800/80 p-2">
                <button
                  type="button"
                  onClick={openSetup}
                  className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-teal-900/30 hover:bg-teal-500"
                >
                  Setup
                </button>
                <button
                  type="button"
                  onClick={() => setDock("send")}
                  className="rounded-xl bg-white/15 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/25"
                >
                  Send to machine
                </button>
                <button
                  type="button"
                  onClick={restartKiriWorkspace}
                  title="Full reload of embedded Kiri — use after WebGL errors or a black 3D view"
                  className="rounded-xl border border-amber-500/40 bg-amber-950/50 px-4 py-2 text-sm font-medium text-amber-100 ring-1 ring-amber-500/30 hover:bg-amber-900/60"
                >
                  Restart Kiri
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <SendToMachineWizard
              iframeReady={isKiriIframeReady(iframeRef.current)}
              fetchStatus={gcodeFetchStatus}
              onRequestKiriExport={handleFetchFromKiri}
              onCancelPendingKiriFetch={clearGcodeFetchTimeout}
            />
          </div>
        </div>
      )}
    </div>
  );
}
