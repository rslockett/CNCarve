import type { JsonObject, WizardAnswers } from "./presets/types";
import { MACHINE_PRESETS, PROVER_PRESET } from "./presets/prover";

export type SafetyIssue = { level: "warn" | "error"; message: string };

/** Older CNCarve presets reused 1000/1002; Kiri’s stock table reserves those for square endmills. */
function migrateLegacyKiriToolId(machineId: string, toolId: number): number {
  if (machineId !== PROVER_PRESET.id) return toolId;
  if (toolId === 1000) return PROVER_PRESET.defaultDetailToolId;
  if (toolId === 1002) return 1004;
  return toolId;
}

const MATERIALS: Record<
  string,
  { label: string; factor: number; notes: string }
> = {
  softwood: {
    label: "Soft wood (pine, cedar)",
    factor: 1,
    notes: "Good starter material.",
  },
  hardwood: {
    label: "Hard wood (oak, maple)",
    factor: 0.65,
    notes: "Use shallower passes than soft wood.",
  },
  mdf: {
    label: "MDF / plywood",
    factor: 0.85,
    notes: "Use dust collection; avoid overheating.",
  },
  plastic: {
    label: "Plastic / acrylic",
    factor: 0.55,
    notes: "Risk of melting — slower feeds help.",
  },
  wax: {
    label: "Wax / modeling foam",
    factor: 1.2,
    notes: "Very soft — easy cuts.",
  },
};

const QUALITY = {
  fast: {
    tolerance: 0.082,
    stepScale: 1.35,
    label: "Faster (less detail)",
    /** Contour “Step over” as fraction of flute ø (Kiri multiplies by ø for spacing). */
    contourStep: 0.26,
    /** Outline Z depth per pass (mm scale); higher = fewer outline levels, rougher. */
    outlineDownMul: 1.12,
    outlineOver: 0.44,
    reduction: 3,
    flatness: 0.0019,
    contourFeedMul: 0.9,
  },
  balanced: {
    tolerance: 0.054,
    stepScale: 1,
    label: "Balanced",
    contourStep: 0.15,
    outlineDownMul: 1,
    outlineOver: 0.36,
    reduction: 2,
    flatness: 0.001,
    contourFeedMul: 0.84,
  },
  fine: {
    tolerance: 0.029,
    stepScale: 0.76,
    label: "Finer (slower)",
    contourStep: 0.085,
    outlineDownMul: 0.82,
    outlineOver: 0.28,
    reduction: 1,
    flatness: 0.00075,
    contourFeedMul: 0.78,
  },
  replica: {
    tolerance: 0.012,
    stepScale: 0.5,
    label: "Replica (very slow, max detail)",
    contourStep: 0.042,
    outlineDownMul: 0.62,
    outlineOver: 0.18,
    reduction: 0,
    flatness: 0.0004,
    contourFeedMul: 0.68,
  },
} as const;

export function listMaterials() {
  return MATERIALS;
}

/** Tool picks shown in the wizard — ids match Kiri `tools[].id`. */
export function listPresetTools(machineId: string): { id: number; name: string }[] {
  const p = getMachineOrDefault(machineId);
  return p.tools.map((t) => ({
    id: t.id as number,
    name: String(t.name ?? `Tool ${t.id}`),
  }));
}

function toolIdSet(preset: ReturnType<typeof getMachineOrDefault>): Set<number> {
  return new Set(preset.tools.map((t) => t.id as number));
}

function normalizeToolId(
  id: number,
  preset: ReturnType<typeof getMachineOrDefault>,
  fallback: number,
): number {
  const migrated = migrateLegacyKiriToolId(preset.id, id);
  const set = toolIdSet(preset);
  return set.has(migrated) ? migrated : fallback;
}

/** Clamp stored tool ids when machine preset changes. */
export function coerceToolsForMachine(
  machineId: string,
  singleToolId: number,
  roughToolId: number,
  outlineToolId: number,
): { singleToolId: number; roughToolId: number; outlineToolId: number } {
  const p = getMachineOrDefault(machineId);
  return {
    singleToolId: normalizeToolId(singleToolId, p, p.defaultDetailToolId),
    roughToolId: normalizeToolId(roughToolId, p, p.defaultRoughToolId),
    outlineToolId: normalizeToolId(outlineToolId, p, p.defaultDetailToolId),
  };
}

export function listQuality() {
  return QUALITY;
}

export function getMachineOrDefault(id: string) {
  return MACHINE_PRESETS[id] ?? PROVER_PRESET;
}

/**
 * Kiri:Moto CAM (from grid-apps / docs), mapped from wizard “Quality”:
 * - **Precision** (`camTolerance` / op `tolerance`) — mm chordal resolution for mesh slices;
 *   lower = follows STL facets tighter, more toolpath points, slower.
 * - **Flatness** (`camFlatness` / op `flatness`) — how closely parallel passes hug local surface
 *   shape; lower = stricter, more CPU/time.
 * - **Reduction** (`camContourReduce` / op `reduction`) — simplifies internal mesh before contouring;
 *   0 keeps the most detail; higher values coarsen (faster, less faithful on fine relief).
 * - **Step over** (`camContourOver` / op `step`) — spacing between contour passes as a multiple of
 *   tool flute diameter (per Kiri topo).
 * Outline Z step uses `outlineDown × outlineDownMul` so finer qualities take shallower outline cuts.
 */

/** Matches Kiri `createPopOp('outline', …)` record fields used in ops[]. */
function kiriOutlineOp(args: {
  tool: number;
  spindle: number;
  down: number;
  rate: number;
  plunge: number;
  step: number;
  steps: number;
}): JsonObject {
  return {
    type: "outline",
    tool: args.tool,
    direction: "climb",
    spindle: args.spindle,
    step: args.step,
    steps: args.steps,
    down: args.down,
    rate: args.rate,
    plunge: args.plunge,
    dogbones: false,
    revbones: false,
    omitthru: false,
    omitvoid: false,
    outside: true,
    inside: false,
    wide: false,
    ov_topz: 0,
    ov_botz: 0,
  };
}

/**
 * Kiri topo clipping: when **Inside only** is on, `clipTo` starts as the part silhouette.
 * If **Clip to stock** is also on, Kiri **appends** the stock rectangle to the same array and
 * `inClip()` treats that list as **OR** — a point inside the big rectangle passes even when it
 * is outside the silhouette, so contour **fills the whole stock XY**. For silhouette-only relief,
 * leave **`clipto` false** whenever **`inside` is true**.
 */

/** Matches Kiri `createPopOp('contour', …)` field names — step is fraction × tool ø for straight tools. */
function kiriContourOp(args: {
  tool: number;
  spindle: number;
  axis: "X" | "Y";
  step: number;
  rate: number;
  tolerance: number;
  flatness: number;
  reduction: number;
  /** When true, Kiri clips contour to the part silhouette (shadow) instead of expanding past it. */
  inside: boolean;
  /**
   * Maps to op `clipto` / process `camStockClipTo`. Must be **false** when `inside` is true —
   * otherwise stock rectangle OR‑combines with silhouette and wastes passes across the board.
   */
  clipToStock: boolean;
}): JsonObject {
  return {
    type: "contour",
    tool: args.tool,
    spindle: args.spindle,
    axis: args.axis,
    step: Math.max(0.01, Math.min(10, args.step)),
    rate: args.rate,
    leave: 0,
    tolerance: args.tolerance,
    flatness: args.flatness,
    reduction: args.reduction,
    bridging: 0,
    angle: 85,
    bottom: false,
    curves: false,
    inside: args.inside,
    clipto: args.clipToStock,
    filter: [],
  };
}

/** Map wizard answers + STL filename into Kiri partial settings */
export function mapWizardToKiri(answers: WizardAnswers): {
  device: JsonObject;
  process: JsonObject;
  controller: JsonObject;
  tools: JsonObject[];
} {
  const preset = getMachineOrDefault(answers.machineId);
  const mat = MATERIALS[answers.materialId] ?? MATERIALS.softwood;
  const q = QUALITY[answers.qualityId] ?? QUALITY.balanced;

  const roughToolIdNorm = normalizeToolId(
    answers.roughToolId,
    preset,
    preset.defaultRoughToolId,
  );
  const outlineToolIdNorm = normalizeToolId(
    answers.outlineToolId,
    preset,
    preset.defaultDetailToolId,
  );
  const singleToolIdNorm = normalizeToolId(
    answers.singleToolId,
    preset,
    preset.defaultDetailToolId,
  );

  /** Finish / contour cutter (surface passes). Roughing cutter when multi-step. */
  const finishTool =
    answers.camToolStrategy === "single" ? singleToolIdNorm : outlineToolIdNorm;
  const roughToolOnly =
    answers.camToolStrategy === "single" ? singleToolIdNorm : roughToolIdNorm;

  const singleBit = answers.camToolStrategy === "single";

  const f = mat.factor * q.stepScale;

  const roughDown = Math.max(0.5, Math.min(2.5, 1.5 * f));
  const outlineDown = Math.max(0.3, Math.min(1.2, roughDown * 0.6));
  const contourStepFrac = Math.max(0.01, Math.min(1, q.contourStep));
  const contourTolerance = Math.max(0.001, Math.min(10, q.tolerance));
  const contourFlatness = Math.max(0.0001, Math.min(1, q.flatness));

  const camFastFeed = Math.min(2500, Math.round(1200 * f));
  const camFastFeedZ = Math.min(400, Math.round(200 * f));

  const roughSpeed = Math.round(800 * f);
  const outlineSpeed = Math.round(650 * f);
  const spindle = Math.min(preset.spindleMaxRpm, Math.round(9000 * f));
  const contourSpeed = Math.min(
    2500,
    Math.max(
      150,
      Math.round(700 * mat.factor * q.stepScale * q.contourFeedMul),
    ),
  );

  const roughLeave = 0.22;
  /** Step-over fraction × tool ø (matches Kiri Rough op semantics). */
  const roughStepFrac = Math.max(0.2, Math.min(0.65, 0.42 / q.stepScale));

  const stockX = Math.max(1, answers.stockWidthMm);
  const stockY = Math.max(1, answers.stockDepthMm);
  const stockZ = Math.max(0.5, answers.stockThicknessMm);
  const centerStock = answers.patternPlacement === "center";

  const contourBase = {
    tool: finishTool,
    spindle,
    step: contourStepFrac,
    rate: contourSpeed,
    tolerance: contourTolerance,
    flatness: contourFlatness,
    reduction: q.reduction,
  };

  /** Single-bit outline takes shallower passes when quality asks for finer detail. */
  const outlineDownSingle = Math.max(
    0.22,
    Math.min(1.2, outlineDown * q.outlineDownMul),
  );
  const outlineOverKiri = Math.max(0.08, Math.min(0.65, q.outlineOver));

  const ops: JsonObject[] = [];
  if (singleBit) {
    ops.push(
      kiriOutlineOp({
        tool: finishTool,
        spindle,
        down: outlineDownSingle,
        rate: outlineSpeed,
        plunge: Math.round(120 * f),
        step: outlineOverKiri,
        steps: 1,
      }),
      kiriContourOp({
        ...contourBase,
        axis: "X",
        inside: true,
        clipToStock: false,
      }),
    );
  } else {
    ops.push({
      type: "rough",
      tool: roughToolOnly,
      spindle,
      down: roughDown,
      step: roughStepFrac,
      rate: roughSpeed,
      plunge: Math.round(150 * f),
      leave: roughLeave,
      voids: false,
      flats: false,
      inside: true,
      top: false,
    });
    ops.push(
      kiriContourOp({ ...contourBase, axis: "X", inside: false, clipToStock: true }),
      kiriContourOp({ ...contourBase, axis: "Y", inside: false, clipToStock: true }),
    );
  }

  const process: JsonObject = {
    processName: `CNCarve-${answers.qualityId}`,
    camTolerance: contourTolerance,
    camFlatness: contourFlatness,
    camStockClipTo: !singleBit,
    camMillDirection: "climb",
    camZAnchor: "top",
    camZClearance: 2,
    camZThru: 0,
    camFastFeed,
    camFastFeedZ,
    camRoughTool: singleBit ? finishTool : roughToolOnly,
    camRoughSpindle: spindle,
    camRoughDown: roughDown,
    camRoughOver: 0.45,
    camRoughSpeed: roughSpeed,
    camRoughPlunge: Math.round(150 * f),
    camOutlineTool: finishTool,
    camOutlineSpindle: spindle,
    camOutlineDown: singleBit ? outlineDownSingle : outlineDown,
    camOutlineOver: outlineOverKiri,
    camOutlineOverCount: 1,
    camOutlineSpeed: outlineSpeed,
    camOutlinePlunge: Math.round(120 * f),
    camOutlineDogbone: false,
    camOutlineRevbone: false,
    camOutlineOmitThru: false,
    camOutlineOmitVoid: false,
    camOutlineOut: true,
    camOutlineIn: false,
    camOutlineWide: false,
    camContourTool: finishTool,
    camContourSpindle: spindle,
    camContourOver: contourStepFrac,
    camContourSpeed: contourSpeed,
    camContourAngle: 85,
    camContourLeave: 0,
    camContourReduce: q.reduction,
    camContourBridge: 0,
    camContourBottom: false,
    camContourCurves: false,
    camContourIn: singleBit,
    camTraceTool: finishTool,
    camTraceSpindle: spindle,
    camTraceSpeed: Math.round(600 * f),
    camStockX: stockX,
    camStockY: stockY,
    camStockZ: stockZ,
    camStockOn: true,
    camStockOffset: true,
    camOriginTop: true,
    camDepthFirst: true,
    ctOriginCenter: centerStock,
    camOriginCenter: centerStock,
    ops,
  };

  const device: JsonObject = {
    ...preset.device,
    bedWidth: preset.bedWidth,
    bedDepth: preset.bedDepth,
    maxHeight: preset.maxHeight,
    originCenter: answers.stockOnBed === "centered",
  };

  const controller: JsonObject = {
    threaded: false,
    assembly: false,
    autoLayout: false,
    // Force mm in embedded Kiri for deterministic CAM sizing/stock mapping.
    units: "mm",
  };

  return {
    device,
    process,
    controller,
    tools: preset.tools as JsonObject[],
  };
}

export function validateSafety(
  answers: WizardAnswers,
): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const preset = getMachineOrDefault(answers.machineId);
  const coerced = coerceToolsForMachine(
    answers.machineId,
    answers.singleToolId,
    answers.roughToolId,
    answers.outlineToolId,
  );

  if (!answers.stlFileName) {
    issues.push({
      level: "warn",
      message: "No 3D model file selected yet. Pick an STL before carving.",
    });
  }

  if (answers.stockWidthMm > preset.bedWidth || answers.stockDepthMm > preset.bedDepth) {
    issues.push({
      level: "warn",
      message:
        "Stock is wider or deeper than this machine’s travel — use a smaller board or a larger machine preset.",
    });
  }

  if (answers.stockThicknessMm > preset.maxHeight) {
    issues.push({
      level: "error",
      message: "Stock is thicker than this machine’s Z travel — carving is not safe.",
    });
  }

  if (answers.stockMarginMm < 1) {
    issues.push({
      level: "warn",
      message:
        "Stock margin is very small — make sure the board is bigger than the model.",
    });
  }

  if (answers.patternPlacement !== "center") {
    issues.push({
      level: "warn",
      message:
        "For this placement, after import use Kiri’s Arrange view to slide the model to your tape marks (Kiri re-centers meshes on load).",
    });
  }

  if (answers.materialId === "plastic" && answers.qualityId === "fast") {
    issues.push({
      level: "warn",
      message:
        "Plastic can melt at fast settings — balanced or fine is safer.",
    });
  }

  if (
    preset.id === PROVER_PRESET.id &&
    answers.camToolStrategy === "rough_outline" &&
    coerced.roughToolId !== coerced.outlineToolId
  ) {
    issues.push({
      level: "warn",
      message:
        "Roughing and finishing contour use different tools — plan a tool change between operations and re-touch Z for the finishing bit.",
    });
  }

  if (
    preset.id === PROVER_PRESET.id &&
    answers.camToolStrategy === "single" &&
    coerced.singleToolId === PROVER_PRESET.defaultDetailToolId
  ) {
    issues.push({
      level: "warn",
      message:
        "Single-tool mode runs Outline (outside silhouette) then Contour along X with Inside-only clipping so finishing stays on your STL silhouette — pick Fine/Replica when you want Precision/Reduction/Flatness tighter in Kiri.",
    });
  }

  if (answers.qualityId === "replica") {
    issues.push({
      level: "warn",
      message:
        "Replica quality can take hours on large reliefs — check animation time in Kiri before running the job.",
    });
  }

  if (answers.materialId === "plastic" && answers.qualityId === "replica") {
    issues.push({
      level: "warn",
      message:
        "Very slow plastics cuts build heat — consider fine instead of replica, or add air/coolant to avoid melting.",
    });
  }

  if (
    answers.stlFileName &&
    Math.max(
      answers.patternSizeMm.x,
      answers.patternSizeMm.y,
      answers.patternSizeMm.z,
    ) < 1e-6
  ) {
    issues.push({
      level: "warn",
      message:
        "Carved size is still zero — upload a binary STL (sizes fill in automatically) or enter X/Y/Z.",
    });
  }

  return issues;
}

/** True when carved dimensions are non-zero (required before scaling STL for Kiri). */
export function isPatternSizeReady(answers: WizardAnswers): boolean {
  return (
    Math.max(
      answers.patternSizeMm.x,
      answers.patternSizeMm.y,
      answers.patternSizeMm.z,
    ) > 1e-6
  );
}

export function defaultWizardAnswers(): WizardAnswers {
  return {
    machineId: PROVER_PRESET.id,
    materialId: "softwood",
    camToolStrategy: "single",
    singleToolId: PROVER_PRESET.defaultDetailToolId,
    roughToolId: PROVER_PRESET.defaultRoughToolId,
    outlineToolId: PROVER_PRESET.defaultDetailToolId,
    qualityId: "balanced",
    displayUnits: "mm",
    stockMarginMm: 5,
    stockWidthMm: 100,
    stockDepthMm: 100,
    stockThicknessMm: 20,
    patternSizeMm: { x: 0, y: 0, z: 0 },
    linkPatternSizes: true,
    patternScaleAxis: "uniform",
    patternPlacement: "center",
    stockOnBed: "front_left",
    stlFileName: null,
    hasProbePlate: false,
  };
}
