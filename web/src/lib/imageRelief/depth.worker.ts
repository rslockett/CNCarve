/// <reference lib="webworker" />
/**
 * Photo → depth, entirely on this computer.
 *
 * Uses Depth Anything V2 Small (Apache-2.0, free for any use). The model file is downloaded once
 * from the public Hugging Face model library and kept in the browser's cache, so later runs work
 * offline. Nothing about the picture ever leaves the computer, and there is no account or cost.
 */
import * as ort from "onnxruntime-web/wasm";

export type DepthRequest = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * One pass per entry: the shortest side the model sees (multiple of 14). 518 gets the overall
   * shape right; a second, larger pass (e.g. 1036) picks up lettering and fine borders.
   */
  sides: number[];
};
export type DepthMap = { data: Float32Array; width: number; height: number };
export type DepthMessage =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; maps: DepthMap[] }
  | { type: "error"; message: string };

const MODEL_URL =
  "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx";
const ORT_VERSION = "1.30.0";
const CACHE = "cncarve-models-v1";
/** The model sees the picture at about this size (shortest side), in steps of 14 pixels. */
const SIDE = 518;
const MAX_SIDE = 798;

const post = (m: DepthMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function fetchModel(): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) {
      post({ type: "progress", fraction: 0.3, label: "Loading the depth model" });
      return await hit.arrayBuffer();
    }
  } catch {
    cache = null; // private window etc. — just download each time
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the depth model (${res.status}). Check the internet connection and try again.`);
  const total = Number(res.headers.get("content-length")) || 99_000_000;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    post({
      type: "progress",
      fraction: 0.3 * Math.min(1, got / total),
      label: `Downloading the depth model, one time only (${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB)`,
    });
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    await cache?.put(MODEL_URL, new Response(buf.slice(), { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    /* storage full — still works, just downloads again next time */
  }
  return buf.buffer;
}

let session: ort.InferenceSession | null = null;

async function getSession() {
  if (session) return session;
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const cores = (self.navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores)) : 1;
  const model = await fetchModel();
  post({ type: "progress", fraction: 0.35, label: "Starting the depth model" });
  session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return session;
}

/** Bilinear resample of RGBA into the model's normalised CHW input. */
function toInput(rgba: Uint8ClampedArray, w: number, h: number, W: number, H: number): Float32Array {
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(fy),
      y1 = Math.min(h - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(fx),
        x1 = Math.min(w - 1, x0 + 1),
        tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgba[(y0 * w + x0) * 4 + c],
          b = rgba[(y0 * w + x1) * 4 + c],
          d = rgba[(y1 * w + x0) * 4 + c],
          e = rgba[(y1 * w + x1) * 4 + c];
        const v = ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) / 255;
        out[c * W * H + y * W + x] = (v - mean[c]) / std[c];
      }
    }
  }
  return out;
}

// One request at a time; if several arrive while busy, only the newest is worked on.
let waiting: DepthRequest | null = null;
let busy = false;
self.onmessage = async (ev: MessageEvent<DepthRequest>) => {
  waiting = ev.data;
  if (busy) return;
  busy = true;
  while (waiting) {
    const req = waiting;
    waiting = null;
    await handle(req);
  }
  busy = false;
};

async function handle(req: DepthRequest) {
  try {
    const { rgba, width, height, sides } = req;
    post({ type: "progress", fraction: 0, label: "Getting the depth model ready" });
    const s = await getSession();
    const maps: DepthMap[] = [];
    for (let p = 0; p < sides.length; p++) {
      const side = sides[p];
      const maxSide = Math.round((side * MAX_SIDE) / SIDE);
      // Shortest side ≈ `side`, both sides multiples of 14 (the model works in 14-pixel patches).
      const k = Math.min(side / Math.min(width, height), maxSide / Math.max(width, height));
      const W = Math.max(14, Math.round((width * k) / 14) * 14);
      const H = Math.max(14, Math.round((height * k) / 14) * 14);
      const span = 0.6 / sides.length;
      post({
        type: "progress",
        fraction: 0.4 + p * span,
        label:
          p === 0
            ? "Working out the overall shape"
            : "Working out the fine detail and lettering (the slow part — up to a few minutes on a Raspberry Pi)",
      });
      const input = new ort.Tensor("float32", toInput(rgba, width, height, W, H), [1, 3, H, W]);
      const out = await s.run({ [s.inputNames[0]]: input });
      const t = out[s.outputNames[0]];
      const dims = t.dims;
      maps.push({
        data: Float32Array.from(t.data as Float32Array),
        width: dims[dims.length - 1],
        height: dims[dims.length - 2],
      });
    }
    post({ type: "done", maps }, maps.map((m) => m.data.buffer));
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
