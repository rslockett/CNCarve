import type { JsonObject, WizardAnswers } from "./presets/types";
import { MACHINE_PRESETS, PROVER_PRESET } from "./presets/prover";
import {
  deriveReliefContourParams,
  fluteDiameterMmFromPresetTool,
  type ReliefCamQualityId,
} from "./reliefCamOpt";

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

/**
 * Per-tier **feeds / material scaling** and labels. Contour **step** and outline step-over come from
 * `reliefCamOpt.ts` (scallop proxy × tool Ø); **tolerance / flatness** stay explicit per tier there
 * (Kiri uses tolerance as XY slice pitch — must not track coarse step or previews voxelize).
 */
const QUALITY = {
  fast: {
    stepScale: 1.30,
    label: "Quick — fastest, light ridges",
    outlineDownMul: 1.20,
    contourFeedMul: 1.04,
  },
  balanced: {
    stepScale: 1.22,
    label: "Balanced — everyday default",
    outlineDownMul: 1.16,
    contourFeedMul: 1.02,
  },
  fine: {
    stepScale: 1.14,
    label: "Sharper — finer detail",
    outlineDownMul: 1.14,
    contourFeedMul: 1.04,
  },
  replica: {
    stepScale: 0.98,
    label: "Showpiece — slowest, tightest",
    outlineDownMul: 0.98,
    contourFeedMul: 0.92,
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
 * **Reduced** mm of axial pad past relief floor for outline. Old value 1.0 + 0.95 (cone axial pad)
 * inflated `cutDepthMm` by ~2 mm — that pushed `expand` to ~2.2 mm when actual cone radius needed
 * only ~1.0 mm, producing a moat ~1 mm too wide on each side.
 */
const OUTLINE_PAST_MESH_MM = 0.25;
/** Tiny axial pad in the cone-radius estimate; the real cut depth is `patternDepth + this`. */
const OUTLINE_CONE_AXIAL_PAD_MM = 0.15;
const OUTLINE_MIN_CLEARANCE_ABOVE_STOCK_FLOOR_MM = 0.35;

function presetToolById(machineId: string, toolId: number): JsonObject | undefined {
  const p = getMachineOrDefault(machineId);
  return p.tools.find((x) => (x.id as number) === toolId) as JsonObject | undefined;
}

/** V-bits / taper balls widen with depth — silhouette outline expand uses this. */
export function toolWidensWithDepth(machineId: string, toolId: number): boolean {
  const t = presetToolById(machineId, toolId);
  const ty = String(t?.type ?? "");
  return ty === "tapermill" || ty === "taperball";
}

/**
 * `ov_botz` in Kiri = `bottom_stock + ov_botz` for outline Z bottom. We want outline to go as deep
 * as the relief floor (+ a tiny axial pad) so the V-bit fully clears the perimeter. The outline
 * is **offset outward** (via `expand` / `outlineSilhouetteExpandMm`) to account for the V-bit
 * cone getting wider as it cuts deeper — that's what prevents the outline from eating the edge
 * of the STL design.
 */
function reliefOutlineOvBotZ(stockThicknessMm: number, patternDepthMm: number): number | undefined {
  if (patternDepthMm < 0.12) return undefined;
  const deepestMm = patternDepthMm + OUTLINE_PAST_MESH_MM;
  const cappedDepth = Math.min(
    deepestMm,
    stockThicknessMm - OUTLINE_MIN_CLEARANCE_ABOVE_STOCK_FLOOR_MM,
  );
  const ov = stockThicknessMm - cappedDepth;
  if (ov < 0.05) return undefined;
  return ov;
}

/**
 * Millimeters of **outside** clearance for the outline trace on tapered tools.
 *
 * `tr_over` in Kiri = XY offset from part shadow to **tool center**. For a V-bit cutting at
 * `patternDepthMm`, the cone radius at that depth is `coneR`. Setting `tr_over = coneR + 0.08`
 * means the cone’s inner edge lands exactly 0.08 mm outside the design boundary — no more eating
 * into the design, no excessive gap that prevents popping the piece free.
 */
export function outlineSilhouetteExpandMm(
  machineId: string,
  finishToolId: number,
  patternDepthMm: number,
): number | undefined {
  const tool = presetToolById(machineId, finishToolId);
  if (!tool || patternDepthMm < 0.08) return undefined;
  const ty = String(tool.type ?? "");
  if (ty !== "tapermill" && ty !== "taperball") return undefined;

  const metric = !!tool.metric;
  const u = metric ? 1 : 25.4;
  const fluteD = Number(tool.flute_diam) * u;
  const fluteL = Number(tool.flute_len) * u;
  const tip = Number(tool.taper_tip ?? 0) * u;
  if (!(fluteD > 0 && fluteL > 0)) return undefined;

  const depthRelief = Math.min(Math.max(0, patternDepthMm), 120);
  const cutDepthMm = Math.min(
    fluteL,
    depthRelief + OUTLINE_PAST_MESH_MM + OUTLINE_CONE_AXIAL_PAD_MM,
  );

  const radialHalf = Math.max(1e-6, (fluteD - tip) / 2);
  const gammaFromFlute = Math.atan2(radialHalf, fluteL);
  const taperHalfDeg = Number(tool.taper_angle);
  const gammaFromSpec =
    Number.isFinite(taperHalfDeg) && taperHalfDeg > 0.05 && taperHalfDeg < 89
      ? (taperHalfDeg * Math.PI) / 180
      : gammaFromFlute;
  const gamma = Math.max(gammaFromFlute, gammaFromSpec);
  const tipR = Math.max(0, tip / 2);
  const coneR = Math.min(fluteD / 2, tipR + cutDepthMm * Math.tan(gamma));

  return Math.min(18, Math.max(0.08, coneR + 0.08));
}

/**
 * Kiri:Moto CAM (from grid-apps / docs), mapped from wizard "Quality":
 * - **Precision** (`camTolerance` / op `tolerance`) — mm chordal resolution for mesh slices;
 *   lower = follows STL facets tighter, more toolpath points, slower.
 * - **Flatness** (`camFlatness` / op `flatness`) — how closely parallel passes hug local surface
 *   shape; lower = stricter, more CPU/time.
 * - **Reduction** (`camContourReduce` / op `reduction`) — simplifies internal mesh before contouring;
 *   0 keeps the most detail; higher values coarsen (faster, less faithful on fine relief).
 * - **Step over** (`camContourOver` / op `step`) — spacing between contour passes as a multiple of
 *   tool flute diameter (per Kiri topo). CNCarve derives step from a **constant-cusp** proxy in
 *   `reliefCamOpt.ts`; tolerance / flatness are tier tables (slice resolution), only capped vs pass width.
 * Outline Z step uses `outlineDown × outlineDownMul` so finer qualities take shallower outline cuts.
 */

/**
 * Creates an outline operation for relief carving using Kiri's **Area** op type.
 *
 * **Why Area instead of Outline?**
 * The built-in `outline` op type on hosted Kiri (grid.space) ignores the `expand` field,
 * which we need for V-bit offset. However, the `area` op type supports `tr_over` directly
 * in trace mode, allowing us to specify a custom outward offset.
 *
 * When configured with:
 * - `mode: "trace"` — traces around polygon boundaries
 * - `shadow: true` — uses the part's 2D silhouette (same as outline would)
 * - `drape: true` — follows the 3D surface, stepping down with the relief
 * - `base: true` — uses the base shadow at all Z levels
 * - `tr_type: "outside"` — traces outside the silhouette
 * - `tr_over: expandMm` — our calculated V-bit offset!
 *
 * This achieves the same result as the patched outline op but works on hosted Kiri.
 */
function kiriOutlineOp(args: {
  tool: number;
  spindle: number;
  down: number;
  rate: number;
  plunge: number;
  step: number;
  steps: number;
  ovBotz?: number;
  expandMm?: number;
}): JsonObject {
  const rec: JsonObject = {
    type: "area",
    mode: "trace",
    shadow: true,
    drape: true,
    base: true,
    tr_type: "outside",
    tool: args.tool,
    direction: "climb",
    spindle: args.spindle,
    over: args.step,
    steps: args.steps,
    down: args.down,
    rate: args.rate,
    plunge: args.plunge,
    dogbones: false,
    revbones: false,
    omitthru: false,
    thru: true,
    ov_topz: 0,
    ov_botz: 0,
  };
  if (args.ovBotz !== undefined && args.ovBotz >= 0.05) {
    rec.ov_botz = args.ovBotz;
  }
  // V-bit offset: tr_over tells OpArea how far to offset the trace from the silhouette
  if (args.expandMm !== undefined && args.expandMm >= 0.02) {
    rec.tr_over = args.expandMm;
  }
  return rec;
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
export function mapWizardToKiri(
  answers: WizardAnswers,
): {
  device: JsonObject;
  process: JsonObject;
  controller: JsonObject;
  tools: JsonObject[];
} {
  const preset = getMachineOrDefault(answers.machineId);
  const mat = MATERIALS[answers.materialId] ?? MATERIALS.softwood;
  const q = QUALITY[answers.qualityId] ?? QUALITY.balanced;
  const qualityId: ReliefCamQualityId =
    answers.qualityId === "fast" ||
    answers.qualityId === "balanced" ||
    answers.qualityId === "fine" ||
    answers.qualityId === "replica"
      ? answers.qualityId
      : "balanced";

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

  const stockX = Math.max(1, answers.stockWidthMm);
  const stockY = Math.max(1, answers.stockDepthMm);
  const stockZ = Math.max(0.5, answers.stockThicknessMm);
  const centerStock = answers.patternPlacement === "center";

  const patternDepthMm = Math.max(0, answers.patternSizeMm.z);
  const px = Math.max(0, answers.patternSizeMm.x);
  const py = Math.max(0, answers.patternSizeMm.y);
  const patternSpanMm =
    Math.max(px, py) >= 2 ? Math.max(px, py) : Math.min(stockX, stockY) * 0.72;

  const finishToolRow = presetToolById(answers.machineId, finishTool);
  const fluteMm = fluteDiameterMmFromPresetTool(finishToolRow);
  const camDerived = deriveReliefContourParams({
    qualityId,
    fluteDiameterMm: fluteMm,
    patternSpanMm,
    patternDepthMm,
  });
  const contourStepFrac = Math.max(0.01, Math.min(1, camDerived.contourStep));
  const contourTolerance = Math.max(0.001, Math.min(10, camDerived.tolerance));
  const contourFlatness = Math.max(0.0001, Math.min(1, camDerived.flatness));
  const contourReduction = camDerived.reduction;

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

  const outlineOvBotz = reliefOutlineOvBotZ(stockZ, patternDepthMm);
  const silhouetteExpandMm = outlineSilhouetteExpandMm(
    answers.machineId,
    finishTool,
    patternDepthMm,
  );

  const contourBase = {
    tool: finishTool,
    spindle,
    step: contourStepFrac,
    rate: contourSpeed,
    tolerance: contourTolerance,
    flatness: contourFlatness,
    reduction: contourReduction,
  };

  /** Single-bit outline takes shallower passes when quality asks for finer detail. */
  const outlineDownSingle = Math.max(
    0.22,
    Math.min(1.2, outlineDown * q.outlineDownMul),
  );
  const outlineOverKiri = Math.max(0.08, Math.min(0.65, camDerived.outlineOver));

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
        ovBotz: outlineOvBotz,
        expandMm: silhouetteExpandMm,
      }),
      /**
       * Relief needs **both** X and Y contour passes. Sending only one axis used to grey out the
       * other Contour toggle in hosted Kiri and Preview/Animate ran outline (Area trace) only.
       */
      kiriContourOp({ ...contourBase, axis: "X", inside: true, clipToStock: false }),
      kiriContourOp({ ...contourBase, axis: "Y", inside: true, clipToStock: false }),
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
    camEaseDown: true,
    /** Keep both on for single-bit relief — Kiri greys/disables contour when one axis flag is off. */
    camContourXOn: true,
    camContourYOn: true,
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
    camContourReduce: contourReduction,
    camContourBridge: 0,
    camContourBottom: false,
    camContourCurves: false,
    camContourIn: singleBit,
    camRoundCorners: true,
    camArcEnabled: false,
    camArcResolution: 1,
    camArcTolerance: 0.005,
    camTraceTool: finishTool,
    camTraceSpindle: spindle,
    camTraceSpeed: Math.round(600 * f),
    camStockX: stockX,
    camStockY: stockY,
    camStockZ: stockZ,
    camStockOn: true,
    /**
     * **MUST be false** — `camStockOffset: true` makes Kiri interpret `camStockX/Y/Z` as
     * **offsets added to the part bounds**, not absolute board sizes. With it on, a user-set
     * 100×100×20 mm board became 145×163×25 mm in cnc-003.nc (part 44.88+100 etc.) and every
     * downstream depth/clearance calculation broke — including the outline going to Z = −10.7
     * mm when the relief is only 5 mm deep. We always want **absolute** stock so the user's
     * configured board dimensions are honored exactly.
     */
    camStockOffset: false,
    camOriginTop: true,
    camDepthFirst: true,
    ctOriginCenter: centerStock,
    camOriginCenter: centerStock,
    ops,
  };

  const device: JsonObject = {
    ...preset.device,
    /**
     * Kiri's CAM exporter only emits `M3 S…` when `spindleMax` is non-zero (`export.js` gates on
     * `spindleMax && newSpindle && …`). The hosted iframe can merge in a saved device profile with
     * `spindleMax: 0`, which produces G-code with **no M3 at all** (only `M6` / rapids / cuts) —
     * the spindle never spins. Always force this from our machine preset so exports stay sane.
     */
    spindleMax: Math.max(1, Math.round(preset.spindleMaxRpm)),
    bedWidth: preset.bedWidth,
    bedDepth: preset.bedDepth,
    maxHeight: preset.maxHeight,
    originCenter: answers.stockOnBed === "centered",
  };

  const meshDetailBase =
    answers.qualityId === "replica" || answers.qualityId === "fine"
      ? "best"
      : answers.qualityId === "fast"
        ? "fair"
        : "good";

  const controller: JsonObject = {
    threaded: false,
    assembly: false,
    autoLayout: false,
    // Force mm in embedded Kiri for deterministic CAM sizing/stock mapping.
    units: "mm",
    // Always keep import detail ≥ meshDetailBase — coarsening here made Preview/Animate look voxelized.
    detail: meshDetailBase,
    /**
     * Enables CSG stock-slice subtraction during CAM Animate so the wood **visually carves out**
     * as the bit traces the toolpath (without this, the bit moves but stock stays solid — the
     * complaint where "the little bit moves but nothing is being carved into the wood"). Kiri’s
     * `anim-3d` worker checks `settings.controller.manifold` and only builds the slices when true.
     */
    manifold: true,
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
        "Single-tool mode runs Outline then Contour on your silhouette. Use Sharper or Showpiece when you want tighter Kiri precision settings.",
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
    singleToolId: 1003,
    roughToolId: PROVER_PRESET.defaultRoughToolId,
    outlineToolId: 1003,
    qualityId: "balanced",
    displayUnits: "in",
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
    patternTopViewMirrorY: true,
  };
}
