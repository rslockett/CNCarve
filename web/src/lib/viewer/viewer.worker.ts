/// <reference lib="webworker" />
/**
 * Turns an STL into a top-down height map for the viewer, off the main thread.
 * The carved face is turned up the same way Simple carve does it.
 */
import { orientForCarving } from "../relief/fit";
import { rasterizeRelief } from "../relief/heightmap";
import { encodeBinaryStl } from "../stl";
import { isTextStl, parseAnyStl } from "./stlFile";

export type ViewerRequest =
  | { type: "view"; id: string; buffer: ArrayBuffer; longSidePx: number }
  /** Make a binary STL of the (face-up) model at this size, in the file's units. */
  | { type: "export"; id: string; buffer: ArrayBuffer; size: { x: number; y: number; z: number } };

export type ViewerResult = {
  id: string;
  /** Height map: z in the model's units, mask = inside the piece. Row 0 = top of the piece. */
  w: number;
  h: number;
  res: number;
  z: Float32Array;
  mask: Uint8Array;
  zMin: number;
  zMax: number;
  /** Size in the file's units (usually mm): width, height, depth. */
  size: { x: number; y: number; z: number };
  triangles: number;
  text: boolean;
  note: string | null;
  /** The model as a binary STL (only when the file was text), for Simple carve. */
  binary: ArrayBuffer | null;
};

export type ViewerMessage =
  | { type: "done"; result: ViewerResult }
  | { type: "exported"; id: string; stl: ArrayBuffer }
  | { type: "error"; id: string; message: string };

self.onmessage = (ev: MessageEvent<ViewerRequest>) => {
  const post = (m: ViewerMessage, transfer: Transferable[] = []) =>
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
  const req = ev.data;
  if (req.type === "export") {
    try {
      // Same face-up turn as when viewing, then stretch each axis to the asked size.
      const o = orientForCarving(parseAnyStl(req.buffer));
      const fx = req.size.x / (o.size.x || 1),
        fy = req.size.y / (o.size.y || 1),
        fz = req.size.z / (o.size.z || 1);
      const v = o.vertices;
      for (let i = 0; i < v.length; i += 3) {
        v[i] *= fx;
        v[i + 1] *= fy;
        v[i + 2] *= fz;
      }
      // A mirror-free stretch keeps triangle winding, so the solid stays the right way out.
      const stl = encodeBinaryStl(v);
      post({ type: "exported", id: req.id, stl }, [stl]);
    } catch (e) {
      post({ type: "error", id: req.id, message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  const { id, buffer, longSidePx } = req;
  try {
    const text = isTextStl(buffer);
    const raw = parseAnyStl(buffer);
    const o = orientForCarving(raw);
    const res = Math.max(o.size.x, o.size.y) / longSidePx;
    const hm = rasterizeRelief(o.vertices, res, 0);
    // rasterizeRelief puts row 0 at the lowest Y; flip so row 0 is the top of the piece.
    const { width: w, height: h } = hm;
    const z = new Float32Array(w * h),
      mask = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      z.set(hm.z.subarray((h - 1 - j) * w, (h - j) * w), j * w);
      mask.set(hm.mask.subarray((h - 1 - j) * w, (h - j) * w), j * w);
    }
    const binary = text ? encodeBinaryStl(raw) : null;
    const result: ViewerResult = {
      id,
      w,
      h,
      res,
      z,
      mask,
      zMin: hm.zMin,
      zMax: hm.zMax,
      size: o.size,
      triangles: raw.length / 9,
      text,
      note: o.note,
      binary,
    };
    post({ type: "done", result }, [z.buffer, mask.buffer, ...(binary ? [binary] : [])]);
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};
