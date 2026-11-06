/// <reference lib="webworker" />
/** Runs the relief engine off the main thread so the page stays responsive. */
import { buildTimeline } from "../carveTime";
import { lineSeconds, type MotionSettings } from "./motionTime";
import { generateCarve, type ReliefInput, type ReliefResult } from "./reliefCam";

export type ReliefWorkerRequest = Omit<ReliefInput, "onProgress"> & {
  /** The machine's speed / acceleration settings, for the time estimate. */
  motion: MotionSettings;
};

/** The engine's result, with times worked out from GRBL's motion rules. */
export type TimedResult = ReliefResult & {
  program: ReliefResult["program"] & { timeline: number[] };
};

export type ReliefWorkerMessage =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; result: TimedResult }
  | { type: "error"; message: string };

self.onmessage = (ev: MessageEvent<ReliefWorkerRequest>) => {
  const post = (m: ReliefWorkerMessage, transfer: Transferable[] = []) =>
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
  try {
    const { motion, ...input } = ev.data;
    const result = generateCarve({
      ...input,
      onProgress: (fraction, label) => post({ type: "progress", fraction: fraction * 0.92, label }),
    });
    // Time: simulate GRBL's planner (acceleration, corners, per-axis limits) on the program.
    // The G-code itself is untouched; only the estimate changes.
    post({ type: "progress", fraction: 0.95, label: "Working out the carving time" });
    const p = result.program;
    const sec = lineSeconds(p.gcode, motion);
    const timeline = buildTimeline(sec);
    const sectionMinutes = p.sections.map((s, i) => {
      const end = p.sections[i + 1]?.start ?? sec.length;
      let t = 0;
      for (let k = s.start; k < end; k++) t += sec[k];
      return t / 60;
    });
    let lead = 0; // setup lines before the first section (spindle start dwell)
    for (let k = 0; k < (p.sections[0]?.start ?? 0); k++) lead += sec[k];
    if (sectionMinutes.length) sectionMinutes[0] += lead / 60;
    const timed: TimedResult = {
      ...result,
      program: {
        ...p,
        estMinutes: timeline[timeline.length - 1] / 60,
        sectionMinutes,
        timeline,
      },
    };
    const pv = timed.preview;
    post({ type: "done", result: timed }, [pv.target.buffer, pv.carved.buffer, pv.work.buffer]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
