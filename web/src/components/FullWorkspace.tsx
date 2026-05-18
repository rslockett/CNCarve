"use client";

import { useAppState } from "@/context/AppState";
import {
  getKiriUrl,
  importIntoKiri,
  invalidatePendingKiriImports,
  isKiriDebugEnabled,
  isKiriIframeReady,
  kiriPostMessageTargetOrigin,
  KIRI_ORIGIN,
  registerKiriFrameCallbacks,
  requestKiriCancel,
  requestKiriExport,
  requestKiriPrepare,
  requestKiriSlice,
  summarizeKiriPayload,
} from "@/lib/kiriBridge";
import { isWebGlLikelyAvailable } from "@/lib/webglCheck";
import { buildStlForKiri } from "@/lib/stockTransform";
import { chooseSingleBitContourAxis } from "@/lib/contourAxisChoice";
import type { WizardAnswers } from "@/lib/presets/types";
import { isPatternSizeReady, mapWizardToKiri } from "@/lib/wizard";
import { useCallback, useEffect, useRef, useState } from "react";
import { MachinePopout } from "./MachinePopout";
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

/** Total wait cap; export-first path usually finishes in 1–3 min when Preview already ran in Kiri. */
const KIRI_SYNC_MAX_WAIT_MS = 20 * 60 * 1000;
/** If `export` alone yields no `export.done`, run full slice → prepare → export (cold path). */
/** If `export.done` never arrives, fall back to full slice → prepare → export. Keep this above typical “Export after Preview” time (~1–2 min) to avoid double work. */
const KIRI_EXPORT_FIRST_FALLBACK_MS = 180_000;
/** Large CAM meshes can exceed 75s for slice/preview before `slice.done` / `prepare.done` callbacks. */
const KIRI_SLICE_PHASE_FALLBACK_MS = 240_000;
/** After cancel, let Kiri’s worker settle before slice (ms). */
const KIRI_CANCEL_BEFORE_SLICE_MS = 600;

/**
 * Kiri’s left column (tabs / stock / limits / …) sits in the iframe; we can’t read its width
 * cross-origin, so we reserve a conservative strip and place the companion to the right of it.
 * Must stay in sync with the companion shell `max-w-[26rem]` for horizontal clamping.
 */
const KIRI_LEFT_STACK_RESERVE_PX = 252;
const GCODE_COMPANION_GAP_PX = 10;
/** Kiri’s `#mid` starts at ~45px; Arrange / Slice / … sit in the first rows — start the companion below that chrome. */
const GCODE_COMPANION_TOP_PX = 124;
const GCODE_COMPANION_MAX_WIDTH_PX = 26 * 16;

function defaultGcodeCompanionX(): number {
  if (typeof window === "undefined") {
    return KIRI_LEFT_STACK_RESERVE_PX + GCODE_COMPANION_GAP_PX;
  }
  const panelW = Math.min(window.innerWidth * 0.94, GCODE_COMPANION_MAX_WIDTH_PX);
  const preferred = KIRI_LEFT_STACK_RESERVE_PX + GCODE_COMPANION_GAP_PX;
  const maxLeft = Math.max(8, window.innerWidth - panelW - 8);
  return Math.min(preferred, maxLeft);
}

function getDefaultGcodeCompanionPos(): { x: number; y: number } {
  return { x: defaultGcodeCompanionX(), y: GCODE_COMPANION_TOP_PX };
}

export function FullWorkspace() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const importWatchdogRef = useRef<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(true);
  const [dock, setDock] = useState<null | "send">(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  /**
   * Most recent widget count reported by Kiri (via `{get:"widgets"}`). Used to detect the
   * silent-fail mode where Kiri's iframe loads but the STL never arrives — animate then plays
   * a stale/empty toolpath and the user sees "stock visible, bit moves, nothing carves".
   * `null` until Kiri replies at least once.
   */
  const [kiriWidgetCount, setKiriWidgetCount] = useState<number | null>(null);
  const kiriWidgetCountRef = useRef<number | null>(null);
  kiriWidgetCountRef.current = kiriWidgetCount;
  const [kiriFrameLoaded, setKiriFrameLoaded] = useState(false);
  /** Remount iframe to recover from WebGL context loss (Kiri needs WebGL; without it postMessage import breaks internally). */
  const [kiriIframeKey, setKiriIframeKey] = useState(0);
  const [companionPhase, setCompanionPhase] = useState<"gcode" | "machine">("gcode");
  const [gcodePanelPos, setGcodePanelPos] = useState(() => getDefaultGcodeCompanionPos());
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

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const fromKiriFrame = iframeRef.current?.contentWindow === ev.source;
      const fromKiriOrigin =
        ev.origin === kiriPostMessageTargetOrigin() ||
        ev.origin === KIRI_ORIGIN ||
        ev.origin === "https://www.grid.space";
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
        /**
         * Update the **ref** synchronously here. React state batching delays `setKiriWidgetCount`
         * by at least one render — which can land AFTER the 15s import watchdog reads the ref —
         * producing a false "Kiri did not load the STL" banner even though the model is sitting
         * right there in the platform (exact symptom from the latest screenshot).
         */
        kiriWidgetCountRef.current = count;
        setKiriWidgetCount(count);
        if (count > 0) {
          setImportBusy(false);
          setImportStatus(null);
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
          setImportStatus(null);
          /**
           * `parsed`/`loaded` is the canonical "STL is on the platform" signal Kiri sends right
           * after `data.parse` / `data.load` succeeds. Treat that as proof of at least one
           * widget so the 15s watchdog never fires a false "did not load" banner just because
           * the explicit `{get:'widgets'}` reply hasn't landed yet. (Sync ref + state both.)
           */
          if (kiriWidgetCountRef.current === null || kiriWidgetCountRef.current < 1) {
            kiriWidgetCountRef.current = 1;
            setKiriWidgetCount((prev) => (prev != null && prev >= 1 ? prev : 1));
          }
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
            setImportStatus(null);
            setCompanionPhase("gcode");
            setDock("send");
          } else {
            setGcodeFetchStatus("error");
            console.warn(
              "[CNCarve] Kiri returned empty G-code — run Preview in Kiri, then try Load again or paste G-code.",
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
          console.warn(
            detail
              ? `[CNCarve] Kiri reported ${evName}: ${detail}`
              : `[CNCarve] Kiri reported ${evName} — see browser console (F12).`,
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
        "[CNCarve] Could not take G-code from Kiri through the iframe bridge (common with very large programs). Use Export in Kiri → drop the file into Companion.",
      );
    }
    window.addEventListener("messageerror", onMsgErr);
    return () => window.removeEventListener("messageerror", onMsgErr);
  }, []);

  const handleFetchFromKiri = useCallback(() => {
    if (!isKiriIframeReady(iframeRef.current)) {
      console.warn("[CNCarve] Kiri’s iframe isn’t ready — wait for the CAM view to load.");
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
      if (isKiriDebugEnabled()) {
        console.info(
          `[CNCarve] Still stuck on slice — restarting slice (attempt ${gcodeFetchAttemptsRef.current}/3).`,
        );
      }
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
      requestKiriCancel(iframeRef.current);
      window.setTimeout(() => {
        if (
          !expectingKiriGcodeRef.current ||
          kiriExportPipelineRef.current !== "slice"
        ) {
          return;
        }
        const okSlice = requestKiriSlice(iframeRef.current);
        if (!okSlice) {
          expectingKiriGcodeRef.current = false;
          kiriExportPipelineRef.current = "idle";
          setGcodeFetchStatus("error");
          console.warn("[CNCarve] Could not reach Kiri — try again.");
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
      console.warn("[CNCarve] Could not reach Kiri — try again.");
      return;
    }
    gcodeFetchAttemptsRef.current = 1;

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
      console.warn(
        "[CNCarve] Timed out waiting for Kiri G-code over the iframe bridge — use Export in Kiri → drop file into Companion.",
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
      setGcodePanelPos({
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
    setImportStatus(null);
  }, [clearGcodeFetchTimeout]);

  const openSetup = useCallback(() => {
    if (importWatchdogRef.current) {
      clearTimeout(importWatchdogRef.current);
      importWatchdogRef.current = null;
    }
    clearGcodeFetchTimeout();
    setGcodeFetchStatus((s) => (s === "loading" ? "idle" : s));
    setImportBusy(false);
    setImportStatus(null);
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
    setImportStatus(null);
    setWizardOpen(false);
    setCompanionPhase("gcode");
    setGcodePanelPos(getDefaultGcodeCompanionPos());
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
    setImportStatus(null);
    setWizardOpen(false);
    setCompanionPhase("gcode");
    setGcodePanelPos(getDefaultGcodeCompanionPos());
    setDock("send");
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
    setKiriWidgetCount(null);
    setImportStatus(null);
    try {
      // Validates binary STL, pattern size, and scaling math.
      const built = buildStlForKiri(buffer, effectiveAnswers);
      // Always send wizard-scaled STL so Kiri matches requested dimensions.
      const stlForKiri = built.buffer;
      const payload = mapWizardToKiri(
        effectiveAnswers,
        effectiveAnswers.camToolStrategy === "single"
          ? { singleBitContourAxis: chooseSingleBitContourAxis(built.vertices) }
          : undefined,
      );
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
      setImportStatus(null);
      setCompanionPhase("gcode");
      setGcodePanelPos(getDefaultGcodeCompanionPos());
      setDock("send");
      importWatchdogRef.current = window.setTimeout(() => {
        importWatchdogRef.current = null;
        setImportBusy(false);
        if ((kiriWidgetCountRef.current ?? 0) === 0 && isKiriDebugEnabled()) {
          console.warn(
            "[CNCarve] Import watchdog: no Kiri widgets reported after 15s (model may still have loaded — check the 3D view).",
          );
        }
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
        src={getKiriUrl()}
        aria-hidden={wizardOpen}
        className={`absolute inset-0 z-0 h-full w-full border-0 ${wizardOpen ? "pointer-events-none" : ""}`}
        allow="fullscreen"
        onLoad={() => setKiriFrameLoaded(true)}
      />

      <div className="pointer-events-auto absolute bottom-4 left-4 z-30">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-slate-900/90 px-2 py-2 shadow-lg backdrop-blur-md">
          <span className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-semibold tracking-wide text-slate-200">
            CNC
          </span>
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
              className="whitespace-nowrap rounded-lg bg-teal-700/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-600"
            >
              Companion
            </button>
          </div>
        </div>
      </div>

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
        onDismiss={() => {
          setWizardOpen(false);
          setImportStatus(null);
        }}
        onImportToKiri={handleImportToKiri}
        onSkipToMachine={skipToMachineFromSetup}
        importStatus={importStatus}
        importBusy={importBusy}
      />

      {dock === "send" && companionPhase === "gcode" && (
        <div
          className="pointer-events-auto absolute z-40 flex max-h-[min(92dvh,52rem)] w-[min(94vw,26rem)] max-w-[26rem] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-900/96 text-slate-100 shadow-2xl backdrop-blur-md"
          style={{
            left: gcodePanelPos.x,
            top: gcodePanelPos.y,
          }}
        >
          <div
            className="flex shrink-0 cursor-move items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5"
            onPointerDown={(ev) => {
              const rect = (ev.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
              dragRef.current = { id: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
            }}
          >
            <h2 className="text-sm font-semibold text-white">Machine companion</h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={restartKiriWorkspace}
                title="Reload embedded Kiri after WebGL errors or a black 3D view"
                className="rounded-lg border border-amber-500/45 bg-amber-950/55 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900/70"
              >
                Restart Kiri
              </button>
              <button
                type="button"
                onClick={() => {
                  setDock(null);
                  setCompanionPhase("gcode");
                }}
                className="rounded-lg px-2.5 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 [scrollbar-gutter:stable]">
            <SendToMachineWizard
              onCancelPendingKiriFetch={clearGcodeFetchTimeout}
              onEnterMachine={() => setCompanionPhase("machine")}
            />
          </div>
        </div>
      )}

      {dock === "send" && companionPhase === "machine" && (
        <MachinePopout
          onBackToGcode={() => setCompanionPhase("gcode")}
          onCloseDock={() => {
            setDock(null);
            setCompanionPhase("gcode");
          }}
        />
      )}
    </div>
  );
}
