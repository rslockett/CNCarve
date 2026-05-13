import type { MachinePreset } from "./types";
import { huhaoTapermill1003ForKiri, proverKitEngraveVeeTapermill1007ForKiri } from "../huhaoVeeBit";

/**
 * SainSmart 3018-ProVER–style hobby mill preset.
 *
 * **Tool ids** follow Kiri:Moto’s built-in CAM tool table (see `conf.template.tools` in
 * grid-apps). CNCarve only sends tool *numbers* in `process.ops`; Kiri resolves names
 * from its own saved tool list. Using the same ids as stock Kiri (e.g. 1003 = “vee 1/8”)
 * keeps contour ops on the correct bit instead of accidentally selecting “end 1/4”.
 */
export const PROVER_PRESET: MachinePreset = {
  id: "sainsmart-3018-prover",
  label: "SainSmart 3018 ProVER (and similar 3018 routers)",
  bedWidth: 300,
  bedDepth: 180,
  maxHeight: 45,
  /** Kiri stock id → ⅛″ flat (“end 1/8”) */
  defaultRoughToolId: 1001,
  /** Default finishing V: **1007** = ProVER box kit narrow engraving vee (short shank). Pick **1003** for HUHAO. */
  defaultDetailToolId: 1007,
  spindleMaxRpm: 10000,

  device: {
    new: false,
    mode: "CAM",
    /** Shown inside Kiri’s device editor; iframe API does not rename the preset dropdown row. */
    deviceName: "SainSmart 3018 ProVER",
    noclone: false,
    internal: 0,
    bedHeight: 2.5,
    bedWidth: 300,
    bedDepth: 180,
    maxHeight: 45,
    originCenter: false,
    spindleMax: 10000,
    gcodeSpace: true,
    gcodeStrip: false,
    gcodePre: [
      "G21 ; millimeters",
      "G90 ; absolute positioning",
      "G0 F1000 ; default rapid",
    ],
    gcodePost: ["M5 ; spindle off", "M30 ; end"],
    gcodeDwell: ["G4 P{time}"],
    gcodeSpindle: ["M3 S{speed}"],
    /**
     * No `M6` here — stock GRBL 1.1 rejects `M6` with error:20, and single-bit jobs do not need a
     * tool change line. Kiri still emits spindle `M3` from `gcodeSpindle` when `spindleMax` is set.
     */
    gcodeChange: ["; (single tool — no M6; pause here only if you physically swap the bit)"],
    gcodeFExt: "nc",
  },

  /**
   * **1007** = ProVER kit narrow engraving vee (approx. **20° included**, not published by SainSmart);
   * **1003** = HUHAO 20° aftermarket spec (longer shank). Both `metric: true` (mm). Outline silhouette
   * expand uses whichever tapermill you select (`wizard.ts`). **1001** / **1004** stay inch-based.
   */
  tools: [
    {
      id: 1001,
      number: 2,
      type: "endmill",
      name: '⅛" flat end mill',
      metric: false,
      shaft_diam: 0.125,
      shaft_len: 1,
      flute_diam: 0.125,
      flute_len: 1.5,
      taper_tip: 0,
    },
    proverKitEngraveVeeTapermill1007ForKiri(),
    huhaoTapermill1003ForKiri(),
    {
      id: 1004,
      number: 5,
      type: "ballmill",
      name: '⅛" ball nose (optional)',
      metric: false,
      shaft_diam: 0.125,
      shaft_len: 1,
      flute_diam: 0.125,
      flute_len: 1.5,
      taper_tip: 0,
    },
  ],
};

export const MACHINE_PRESETS: Record<string, MachinePreset> = {
  [PROVER_PRESET.id]: PROVER_PRESET,
};
