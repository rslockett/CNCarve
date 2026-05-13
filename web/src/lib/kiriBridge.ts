/** Communicate with embedded Kiri:Moto via postMessage (same protocol as grid.space frame helper). */

/**
 * Kiri iframe URL.
 *
 * **Default:** hosted `https://grid.space/kiri/`. That bundle ships the full Kiri runtime
 * (workers, three.js, slicer) and **does honor `op.expand`** on the outline op — confirmed in
 * the cnc-002.nc export where the ~2.2 mm expand we sent showed up in the carved silhouette.
 *
 * **Why not local?** `vendor/grid-apps/web/` only contains HTML/CSS; the bundled JS lives under
 * `web/lib/` in the upstream build artifact and is not in this repo, so a same-origin `/kiri/`
 * frame would load the UI shell with no engine (Slice/Preview/Animate all silently no-op).
 *
 * **Override:** set `NEXT_PUBLIC_KIRI_URL` to a full URL if you have a custom Kiri build.
 */
function kiriUrlFromEnv(): string {
  const raw =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_KIRI_URL?.trim() ?? ""
      : "";
  if (raw.length > 0) {
    return raw.endsWith("/") ? raw : `${raw}/`;
  }
  return "https://grid.space/kiri/";
}

/** Iframe `src`. */
export function getKiriUrl(): string {
  const u = kiriUrlFromEnv();
  return u.endsWith("/") ? u : `${u}/`;
}

/** `postMessage` `targetOrigin` — must match the iframe document’s origin. */
export function kiriPostMessageTargetOrigin(): string {
  const u = kiriUrlFromEnv();
  if (u.startsWith("http://") || u.startsWith("https://")) {
    try {
      return new URL(u).origin;
    } catch {
      return "https://grid.space";
    }
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "https://grid.space";
}

/** Legacy grid host (still accepted on inbound `postMessage` from some embeds). */
export const KIRI_ORIGIN = "https://grid.space";

/** True when `next dev` / `NODE_ENV=development` or `localStorage cnkiri.debug === "1"`. */
export function isKiriDebugEnabled(): boolean {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
    return true;
  }
  if (typeof window !== "undefined" && window.localStorage?.getItem("cnkiri.debug") === "1") {
    return true;
  }
  return false;
}

/** Safe console payload: avoid dumping huge ArrayBuffers. */
export function summarizeKiriPayload(data: unknown): unknown {
  if (data == null) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) {
    return data.length > 20
      ? { _array: `length ${data.length} (truncated)` }
      : data.map(summarizeKiriPayload);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v instanceof ArrayBuffer) {
      out[k] = { _type: "ArrayBuffer", byteLength: v.byteLength };
      continue;
    }
    if (ArrayBuffer.isView(v)) {
      out[k] = {
        _type: v.constructor.name,
        byteLength: v.byteLength,
      };
      continue;
    }
    if (v && typeof v === "object") {
      out[k] = summarizeKiriPayload(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

let kiriImportRunSeq = 0;
/** Bumped on each `importIntoKiri` so stale timeouts from a previous run never call `postToKiri`. */
let kiriImportGeneration = 0;

/** Call before remounting/removing the Kiri iframe so queued `importIntoKiri` timers become no-ops. */
export function invalidatePendingKiriImports(): void {
  kiriImportGeneration++;
}

/** Bump when STL→Kiri transport changes (check console to confirm you are not on a cached bundle). */
export const KIRI_BRIDGE_STL_TRANSPORT = "stl-parse-then-load-v7";

function kiriLog(phase: string, detail: unknown) {
  if (isKiriDebugEnabled()) console.info(`[CNCarve → Kiri] ${phase}`, detail);
}

/**
 * Kiri's frame shim can coerce plain ArrayBuffer via Float32Array (4-byte alignment).
 * Naive +2 byte padding breaks Kiri's STL binary check (expects exact 84 + 50*n).
 *
 * When alignment is needed, append one full dummy triangle (50 bytes) and increment
 * the STL triangle count in header byte 80..83. This keeps a valid binary STL while
 * making byteLength divisible by 4.
 */
function stlPayloadForKiriParse(stl: ArrayBuffer): ArrayBuffer {
  const src = stl.slice(0);
  if (src.byteLength % 4 === 0) return src;

  // Valid binary STL size is always 84 + 50*n, so misalignment is 2 bytes.
  if (src.byteLength < 84 || src.byteLength % 50 !== 34) return src;

  const inView = new DataView(src);
  const triCount = inView.getUint32(80, true);

  const out = new ArrayBuffer(src.byteLength + 50);
  new Uint8Array(out).set(new Uint8Array(src), 0);
  new DataView(out).setUint32(80, triCount + 1, true);
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export type KiriOutgoing =
  | { features?: Record<string, boolean> }
  | { mode?: string }
  | { view?: string }
  | { device?: Record<string, unknown> }
  | { process?: Record<string, unknown> }
  | { controller?: Record<string, unknown> }
  | { parse?: ArrayBuffer | Uint8Array; type?: string }
  | { load?: string }
  | { clear?: boolean }
  | { function?: string; callback?: boolean }
  | { event?: string }
  | { get?: string }
  | { progress?: number; message?: string };

export function postToKiri(
  target: HTMLIFrameElement | null | Window,
  payload: KiriOutgoing,
  transfer?: Transferable[],
): boolean {
  const w =
    target && typeof (target as Window).postMessage === "function"
      ? (target as Window)
      : (target as HTMLIFrameElement | null)?.contentWindow;
  if (!w) return false;
  const keys =
    payload && typeof payload === "object"
      ? Object.keys(payload as object).join(", ")
      : "?";
  const parseVal =
    "parse" in (payload as object)
      ? (payload as { parse?: ArrayBuffer | Uint8Array }).parse
      : undefined;
  const size =
    parseVal instanceof ArrayBuffer
      ? parseVal.byteLength
      : ArrayBuffer.isView(parseVal)
        ? parseVal.byteLength
        : undefined;
  kiriLog("postMessage", { keys, stlBytes: size });
  w.postMessage(payload, kiriPostMessageTargetOrigin(), transfer);
  return true;
}

/** True if the iframe has a window we can postMessage to. */
export function isKiriIframeReady(iframe: HTMLIFrameElement | null): boolean {
  return iframe?.contentWindow != null;
}

/**
 * Wire format matches GridSpace’s official embed helper:
 * https://github.com/GridSpace/grid-apps/blob/master/src/kiri/run/frame.js
 *
 * Documented pipeline: slice → prepare → export (see https://docs.grid.space/kiri-moto/apis ).
 * Calling export alone often never returns `export.done` because toolpaths are not prepared yet.
 *
 * Never combine `function: …` with `features` in one message — the handler runs `function`
 * before merging `features`, which would skip frame mode on cold embeds.
 */
function requestKiriFrameFunction(
  iframe: HTMLIFrameElement | null,
  name: "slice" | "prepare" | "export",
): boolean {
  const w = iframe?.contentWindow;
  if (!w) return false;

  const ok1 = postToKiri(iframe, {
    features: { frame: true, drop_layout: false },
  });
  if (!ok1) return false;

  window.setTimeout(() => {
    postToKiri(iframe, { function: name, callback: true });
  }, 200);

  return true;
}

/**
 * Match `kiri.frame.onevent` in frame.js: parent sends `{ event }` so Kiri forwards
 * completion callbacks to the embedding page.
 */
export function registerKiriFrameCallbacks(
  iframe: HTMLIFrameElement | null,
  events: string[],
): boolean {
  let ok = true;
  for (const event of events) {
    ok = postToKiri(iframe, { event }) && ok;
  }
  return ok;
}

export function requestKiriSlice(iframe: HTMLIFrameElement | null): boolean {
  return requestKiriFrameFunction(iframe, "slice");
}

export function requestKiriPrepare(iframe: HTMLIFrameElement | null): boolean {
  return requestKiriFrameFunction(iframe, "prepare");
}

export function requestKiriExport(iframe: HTMLIFrameElement | null): boolean {
  return requestKiriFrameFunction(iframe, "export");
}

/**
 * Abort in-flight worker jobs (matches `api.function.cancel` in Kiri). Use before starting a new
 * slice/prepare/export sequence so a timed-out export does not overlap the fallback pipeline.
 */
export function requestKiriCancel(iframe: HTMLIFrameElement | null): boolean {
  const w = iframe?.contentWindow;
  if (!w) return false;
  const ok1 = postToKiri(iframe, {
    features: { frame: true, drop_layout: false },
  });
  if (!ok1) return false;
  window.setTimeout(() => {
    postToKiri(iframe, { function: "cancel" });
  }, 200);
  return true;
}


/**
 * Push settings + STL into Kiri. Uses generous delays so the app finishes booting
 * and registers its message listener before we send mesh data (short sequences
 * often no-op if fired too early).
 */
export function importIntoKiri(
  iframe: HTMLIFrameElement | null,
  args: {
    device: Record<string, unknown>;
    process: Record<string, unknown>;
    controller: Record<string, unknown>;
    stlBuffer: ArrayBuffer;
  },
): boolean {
  const controllerWithMmUnits: Record<string, unknown> = {
    ...args.controller,
    units: "mm",
  };
  const w = iframe?.contentWindow;
  if (!w) {
    kiriLog("importIntoKiri", "aborted: iframe has no contentWindow");
    return false;
  }

  const runId = ++kiriImportRunSeq;
  const gen = ++kiriImportGeneration;
  const stockX = Number((args.process as { camStockX?: unknown }).camStockX);
  const stockY = Number((args.process as { camStockY?: unknown }).camStockY);
  const stockZ = Number((args.process as { camStockZ?: unknown }).camStockZ);
  const zAnchor = (args.process as { camZAnchor?: unknown }).camZAnchor;
  kiriLog("importIntoKiri", {
    runId,
    generation: gen,
    transport: KIRI_BRIDGE_STL_TRANSPORT,
    stlBytes: args.stlBuffer.byteLength,
    processStock: {
      camStockX: Number.isFinite(stockX) ? stockX : undefined,
      camStockY: Number.isFinite(stockY) ? stockY : undefined,
      camStockZ: Number.isFinite(stockZ) ? stockZ : undefined,
      camZAnchor: zAnchor,
    },
    note: "Use the same Window reference for every postMessage in this run (ref stability).",
  });

  const schedule = (ms: number, label: string, fn: () => void) =>
    window.setTimeout(() => {
      if (gen !== kiriImportGeneration) {
        kiriLog(`run ${runId} +${ms}ms`, `(skipped stale generation ${gen}≠${kiriImportGeneration}) ${label}`);
        return;
      }
      kiriLog(`run ${runId} +${ms}ms`, label);
      fn();
    }, ms);

  // Kiri applies all keys in one handler pass; order is: … parse … then clear.
  // Never send clear + parse in the same postMessage — clear would wipe the new mesh.
  schedule(0, "batch: features + CAM + ARRANGE + device/process/controller", () =>
    postToKiri(w, {
      features: { frame: true, drop_layout: false },
      mode: "CAM",
      view: "ARRANGE",
      device: args.device,
      process: args.process,
      controller: controllerWithMmUnits,
    }),
  );
  schedule(1500, "clear", () => postToKiri(w, { clear: true }));
  /**
   * Primary route: hand Kiri the raw STL bytes via `parse` (frame.js `data.parse` + `type:'stl'`).
   * This skips the `fetch(dataUrl)` round-trip that `data.load` requires — the previous data-URL
   * transport silently failed in some Chrome/grid.space combinations, leaving Kiri with **no
   * widget**. With no widget, Animate plays a stale/empty toolpath and the wood never carves —
   * exactly the "bit moves but nothing is being carved" symptom.
   */
  schedule(3500, "parse STL (direct ArrayBuffer route)", () => {
    const payload = stlPayloadForKiriParse(args.stlBuffer);
    kiriLog("stl parse", {
      transport: KIRI_BRIDGE_STL_TRANSPORT,
      method: "parse",
      rawBytes: args.stlBuffer.byteLength,
      sentBytes: payload.byteLength,
    });
    postToKiri(w, { parse: payload, type: "stl" });
  });
  /** Belt-and-braces: also send the data-URL `load` route in case `parse` is filtered. */
  schedule(8000, "load STL via named data URL (fallback)", () => {
    const payload = stlPayloadForKiriParse(args.stlBuffer);
    const dataUrl = `data:model/stl;name=model.stl;base64,${arrayBufferToBase64(payload)}`;
    kiriLog("stl load fallback", {
      transport: KIRI_BRIDGE_STL_TRANSPORT,
      method: "load",
      sentBytes: payload.byteLength,
      dataUrlLength: dataUrl.length,
    });
    postToKiri(w, { load: dataUrl });
  });
  // Some Kiri builds may not emit `parsed` back reliably; query widgets as fallback.
  schedule(10_000, "get widgets (post-parse check #1)", () =>
    postToKiri(w, { get: "widgets" }),
  );
  // Kiri can reset some CAM stock/limit UI on load; re-apply process shortly after.
  schedule(11_000, "process + device (re-apply after load)", () =>
    postToKiri(w, { process: args.process, device: args.device }),
  );
  schedule(11_300, "controller (force mm units after load + manifold for animate carve)", () =>
    postToKiri(w, { controller: controllerWithMmUnits }),
  );
  schedule(14_000, "process + device (re-apply after load #2)", () =>
    postToKiri(w, { process: args.process, device: args.device }),
  );
  schedule(18_000, "process + device (re-apply after load #3)", () =>
    postToKiri(w, { process: args.process, device: args.device }),
  );
  schedule(13_000, "get widgets (post-parse check #2)", () =>
    postToKiri(w, { get: "widgets" }),
  );

  return true;
}
