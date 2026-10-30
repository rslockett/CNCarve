/// <reference lib="webworker" />
/**
 * Runs the relief engine off the main thread so the page stays responsive.
 * If any single job would run longer than ~45 minutes, the carving is split into more pieces
 * (short jobs are the main defence against USB drops and power hiccups).
 */
import {
  generateReliefJobs,
  type BitShape,
  type ReliefCamParams,
  type ReliefPlacement,
  type ReliefResult,
} from "./reliefCam";

export type ReliefWorkerRequest = {
  vertices: Float32Array;
  bit: BitShape;
  params: ReliefCamParams;
  placement: ReliefPlacement;
};

export type ReliefWorkerMessage =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; result: ReliefResult }
  | { type: "error"; message: string };

const MAX_JOB_MINUTES = 45;

self.onmessage = (ev: MessageEvent<ReliefWorkerRequest>) => {
  const post = (m: ReliefWorkerMessage, transfer: Transferable[] = []) =>
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
  try {
    const { vertices, bit, params, placement } = ev.data;
    let regions = params.regions;
    let result: ReliefResult;
    for (;;) {
      result = generateReliefJobs({
        vertices,
        bit,
        params: { ...params, regions },
        placement,
        onProgress: (fraction, label) => post({ type: "progress", fraction, label }),
      });
      const longest = Math.max(...result.jobs.map((j) => j.estMinutes));
      if (longest <= MAX_JOB_MINUTES || regions >= 12) break;
      regions = Math.min(12, Math.ceil(regions * (longest / MAX_JOB_MINUTES)) + 1);
      post({ type: "progress", fraction: 0.05, label: `Splitting into ${regions} shorter pieces` });
    }
    const p = result.preview;
    post({ type: "done", result }, [p.target.buffer, p.carved.buffer, p.work.buffer]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
