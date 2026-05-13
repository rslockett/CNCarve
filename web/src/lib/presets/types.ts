/** Shapes aligned with Kiri:Moto device/process/controller + CAM tools */

export type JsonObject = Record<string, unknown>;

export type PatternPlacement =
  | "center"
  | "front_left"
  | "front_right"
  | "back_left"
  | "back_right"
  | "left"
  | "right"
  | "front"
  | "back";

export type StockOnBed = "front_left" | "centered";

export type DisplayUnits = "mm" | "in";

export type PatternScaleAxis = "uniform" | "x" | "y" | "z";

/** Single cutter: outline perimeter then contour detail; dual: bulk rough then contour passes. */
export type CamToolStrategy = "single" | "rough_outline";

export interface MachinePreset {
  id: string;
  label: string;
  /** Bed / travel in mm */
  bedWidth: number;
  bedDepth: number;
  maxHeight: number;
  /** Default assumed tool id when user picks “starter kit” */
  defaultRoughToolId: number;
  defaultDetailToolId: number;
  /** Conservative spindle max RPM hint for feeds UI */
  spindleMaxRpm: number;
  device: JsonObject;
  /** Full tools table fragment used by CAM */
  tools: JsonObject[];
}

export interface WizardAnswers {
  machineId: string;
  materialId: string;
  camToolStrategy: CamToolStrategy;
  /** Used when camToolStrategy === "single" — same id for rough + outline in Kiri */
  singleToolId: number;
  /** Used when camToolStrategy === "rough_outline" */
  roughToolId: number;
  /** Finish / contour tool (Kiri milling surface passes) when using rough_outline */
  outlineToolId: number;
  qualityId: "fast" | "balanced" | "fine" | "replica";
  /** How dimension fields are labeled and edited; stored numbers remain mm. */
  displayUnits: DisplayUnits;
  /** Extra space around pattern vs stock edges (mm) */
  stockMarginMm: number;
  /** Physical stock size (mm) */
  stockWidthMm: number;
  stockDepthMm: number;
  stockThicknessMm: number;
  /** Target carved size (mm) — with link or per-axis */
  patternSizeMm: { x: number; y: number; z: number };
  linkPatternSizes: boolean;
  /** When linked, which driving axis or uniform max */
  patternScaleAxis: PatternScaleAxis;
  patternPlacement: PatternPlacement;
  stockOnBed: StockOnBed;
  stlFileName: string | null;
  hasProbePlate: boolean;
  /**
   * Plan preview only: mirror mesh in Y about the placed mesh’s depth midpoint (XZ plane).
   * Does **not** change the binary STL sent to Kiri — import matches the scaled file geometry.
   */
  patternTopViewMirrorY: boolean;
}
