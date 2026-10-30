/// <reference lib="webworker" />
/** Runs the relief engine off the main thread so the page stays responsive. */
import { generateCarve, type ReliefInput, type ReliefResult } from "./reliefCam";

export type ReliefWorkerRequest = Omit<ReliefInput, "onProgress">;

export type ReliefWorkerMessage =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; result: ReliefResult }
  | { type: "error"; message: string };

self.onmessage = (ev: MessageEvent<ReliefWorkerRequest>) => {
  const post = (m: ReliefWorkerMessage, transfer: Transferable[] = []) =>
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
  try {
    const result = generateCarve({
      ...ev.data,
      onProgress: (fraction, label) => post({ type: "progress", fraction, label }),
    });
    const p = result.preview;
    post({ type: "done", result }, [p.target.buffer, p.carved.buffer, p.work.buffer]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
