/**
 * Turn Setup answers (machine, bit, wood, quality, board) into relief-engine settings.
 *
 * Feeds and layer depths are tuned for a stock 3018 spindle. Hardwood (factor 0.65) gives the
 * values tested on the first San Damiano cross: 0.8 mm layers, roughing ~450 mm/min,
 * detail ~600 mm/min, plunge 100 mm/min.
 */

import type { JsonObject, WizardAnswers } from "../presets/types";
import { getMachineOrDefault, listMaterials } from "../wizard";
import type { BitShape, ReliefCamParams, ReliefPlacement } from "./reliefCam";

const MM_PER_IN = 25.4;

function toolMm(tool: JsonObject, key: string, fallbackMm: number): number {
  const raw = Number(tool[key]);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMm;
  return tool.metric ? raw : raw * MM_PER_IN;
}

/** The single bit this job uses (Setup's one-bit pick, or the detail bit for two-bit setups). */
export function reliefToolId(answers: WizardAnswers): number {
  return answers.camToolStrategy === "single" ? answers.singleToolId : answers.outlineToolId;
}

export function bitShapeFromTool(tool: JsonObject | undefined): BitShape {
  if (!tool) return { type: "vee", halfAngleDeg: 10, tipDiameterMm: 0.1, diameterMm: 3.175 };
  const diameterMm = toolMm(tool, "flute_diam", 3.175);
  const type = String(tool.type ?? "");
  if (type === "tapermill") {
    const half = Number(tool.taper_angle);
    const tip = Number(tool.taper_tip);
    return {
      type: "vee",
      halfAngleDeg: Number.isFinite(half) && half > 0 && half < 80 ? half : 10,
      // taper_tip uses the tool's own units
      tipDiameterMm: Number.isFinite(tip) && tip >= 0 ? (tool.metric ? tip : tip * MM_PER_IN) : 0.1,
      diameterMm,
    };
  }
  if (type === "ballmill") return { type: "ball", diameterMm };
  return { type: "flat", diameterMm };
}

export function describeBit(bit: BitShape): string {
  if (bit.type === "vee")
    return `${Math.round(bit.halfAngleDeg * 2)}° V-bit, ${bit.tipDiameterMm} mm tip`;
  if (bit.type === "ball") return `${bit.diameterMm.toFixed(2)} mm ball nose`;
  return `${bit.diameterMm.toFixed(2)} mm flat end mill`;
}

const round10 = (v: number) => Math.max(10, Math.round(v / 10) * 10);

/** Detail pass spacing by quality tier, as a fraction of what each bit type needs. */
const FINISH_STEP: Record<WizardAnswers["qualityId"], { vee: number; ball: number; flat: number }> = {
  fast: { vee: 0.15, ball: 0.12, flat: 0.3 },
  balanced: { vee: 0.1, ball: 0.08, flat: 0.2 },
  fine: { vee: 0.075, ball: 0.06, flat: 0.15 },
  replica: { vee: 0.05, ball: 0.04, flat: 0.1 },
};

export type ReliefSettings = {
  bit: BitShape;
  bitLabel: string;
  params: ReliefCamParams;
  placement: ReliefPlacement;
  materialLabel: string;
};

export function deriveReliefSettings(
  answers: WizardAnswers,
  designSizeMm: { x: number; y: number },
): ReliefSettings {
  const preset = getMachineOrDefault(answers.machineId);
  const toolRow = preset.tools.find((t) => (t.id as number) === reliefToolId(answers));
  const bit = bitShapeFromTool(toolRow);
  const mat = listMaterials()[answers.materialId] ?? { label: "Wood", factor: 1 };
  const f = mat.factor;

  const roughLayerMm = Math.round(Math.min(1.5, Math.max(0.3, 1.23 * f)) * 100) / 100;
  let roughStepMm: number;
  if (bit.type === "vee") {
    // Ridges left between rough passes stay ~1.4 layers tall — the next layer clears them.
    const t = Math.tan((bit.halfAngleDeg * Math.PI) / 180);
    roughStepMm = bit.tipDiameterMm + 2 * t * 1.4 * roughLayerMm;
  } else {
    roughStepMm = 0.4 * bit.diameterMm;
  }
  roughStepMm = Math.round(roughStepMm * 100) / 100;

  const tier = FINISH_STEP[answers.qualityId] ?? FINISH_STEP.balanced;
  const finishStepMm =
    bit.type === "vee" ? tier.vee : bit.type === "ball" ? tier.ball * bit.diameterMm : tier.flat * bit.diameterMm;

  // Two grid pixels per detail pass, but keep big carvings under ~3 million pixels.
  const area = Math.max(1, designSizeMm.x * designSizeMm.y);
  const resMm = Math.min(0.3, Math.max(0.025, finishStepMm / 2, Math.sqrt(area / 3_000_000)));

  return {
    bit,
    bitLabel: describeBit(bit),
    materialLabel: mat.label,
    params: {
      finishStepMm,
      roughStepMm,
      roughLayerMm,
      leaveMm: 0.2,
      topSkimMm: 0.1,
      bandMm: 1.5,
      floorBelowMm: 0.5,
      feedRough: round10(700 * f),
      feedFinish: round10(900 * f),
      feedPlunge: round10(150 * f),
      // GRBL caps S at the machine's own maximum ($30), so asking for the spindle's top speed
      // gives full speed whether $30 is 1000 (PROVer default) or 10000.
      spindleS: Math.round(preset.spindleMaxRpm),
      safeZ: 3,
      clearZ: 1,
      regions: 3,
      resMm,
    },
    placement: {
      where: answers.patternPlacement,
      stockWidthMm: answers.stockWidthMm,
      stockDepthMm: answers.stockDepthMm,
      marginMm: answers.stockMarginMm,
    },
  };
}
