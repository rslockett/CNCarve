import {
  bboxFromVertices,
  encodeBinaryStlWithNormals,
  parseBinaryStl,
  scaleVertices,
} from "./stl";
import type { WizardAnswers } from "./presets/types";

export type PatternSize = { x: number; y: number; z: number };

type ReliefAxis = "x" | "y" | "z";

/**
 * STL axis treated as **carve depth** (smallest bbox edge). Tie-break prefers Z, then Y, then X
 * so flat relief exports (thin Z) map to stock thickness as users expect.
 */
export function reliefThicknessAxis(box: PatternSize): ReliefAxis {
  const ranked: { ax: ReliefAxis; v: number }[] = [
    { ax: "x", v: box.x },
    { ax: "y", v: box.y },
    { ax: "z", v: box.z },
  ];
  ranked.sort((a, b) => {
    if (Math.abs(a.v - b.v) > 1e-6) return a.v - b.v;
    const order: Record<ReliefAxis, number> = { z: 0, y: 1, x: 2 };
    return order[a.ax] - order[b.ax];
  });
  return ranked[0].ax;
}

/**
 * Top-down footprint on the stock (stock width × depth), aligned with how we scale the mesh:
 * bed plane uses STL X×Y when thickness is Z; otherwise maps the two non-thickness axes to
 * width/depth without sorting edges (sorting caused “fat” silhouettes on some exports).
 */
export function patternFootprintOnStockTopMm(box: PatternSize): {
  widthMm: number;
  depthMm: number;
} {
  const t = reliefThicknessAxis(box);
  if (t === "z") {
    return {
      widthMm: Math.max(box.x, 1e-6),
      depthMm: Math.max(box.y, 1e-6),
    };
  }
  if (t === "y") {
    return {
      widthMm: Math.max(box.x, 1e-6),
      depthMm: Math.max(box.z, 1e-6),
    };
  }
  return {
    widthMm: Math.max(box.y, 1e-6),
    depthMm: Math.max(box.z, 1e-6),
  };
}

/** Carve-depth extent along the relief axis (for stock thickness checks and auto-fit). */
export function patternThicknessHeuristicMm(box: PatternSize): number {
  const t = reliefThicknessAxis(box);
  return Math.max(1e-6, box[t]);
}

/**
 * Uniform scale so the mesh fits usable stock (margins applied). Always scales X, Y, and Z by
 * the same factor so proportions are preserved.
 */
export function uniformScaleToFitStock(
  nat: PatternSize,
  stockWidthMm: number,
  stockDepthMm: number,
  stockThicknessMm: number,
  marginMm: number,
): number {
  const m = Math.max(0, marginMm);
  const usableW = Math.max(1, stockWidthMm - 2 * m);
  const usableD = Math.max(1, stockDepthMm - 2 * m);
  const usableZ = Math.max(0.5, stockThicknessMm - m);
  const fp = patternFootprintOnStockTopMm(nat);
  const thick = patternThicknessHeuristicMm(nat);
  return Math.min(
    usableW / fp.widthMm,
    usableD / fp.depthMm,
    usableZ / thick,
  );
}

/**
 * True when the mesh’s native bounding box (footprint + thickness heuristic) cannot sit
 * inside the stock with the given margin — same basis as Auto-fit’s usable width/depth/Z.
 */
export function nativeMeshExceedsStock(
  nat: PatternSize,
  stockWidthMm: number,
  stockDepthMm: number,
  stockThicknessMm: number,
  marginMm: number,
): boolean {
  const fp = patternFootprintOnStockTopMm(nat);
  const thick = patternThicknessHeuristicMm(nat);
  const m = Math.max(0, marginMm);
  const usableW = Math.max(1e-6, stockWidthMm - 2 * m);
  const usableD = Math.max(1e-6, stockDepthMm - 2 * m);
  const usableZ = Math.max(0.5, stockThicknessMm - m);
  return (
    fp.widthMm > usableW + 1e-3 ||
    fp.depthMm > usableD + 1e-3 ||
    thick > usableZ + 1e-3
  );
}

function isLikelyBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const n = new DataView(buffer).getUint32(80, true);
  return n > 0 && n < 50_000_000 && 84 + n * 50 <= buffer.byteLength + 4;
}

export function readNativeStlSize(stlBuffer: ArrayBuffer): PatternSize | null {
  try {
    if (!isLikelyBinaryStl(stlBuffer)) return null;
    const vertices = parseBinaryStl(stlBuffer);
    const nat = bboxFromVertices(vertices);
    return {
      x: Math.max(nat.max[0] - nat.min[0], 1e-6),
      y: Math.max(nat.max[1] - nat.min[1], 1e-6),
      z: Math.max(nat.max[2] - nat.min[2], 1e-6),
    };
  } catch {
    return null;
  }
}

/**
 * Scale STL mesh for target pattern size. Kiri re-centers the mesh after import.
 */
export function buildStlForKiri(
  stlBuffer: ArrayBuffer,
  answers: WizardAnswers,
): {
  buffer: ArrayBuffer;
  nativeSize: PatternSize;
  finalSize: PatternSize;
  /** Scaled triangle soup (9 floats per triangle), same coordinates as `buffer`. */
  vertices: Float32Array;
} {
  if (!isLikelyBinaryStl(stlBuffer)) {
    throw new Error(
      "This does not look like a binary STL. Please export a binary STL from your CAD program.",
    );
  }

  let vertices = parseBinaryStl(stlBuffer);
  const nat = bboxFromVertices(vertices);
  const nativeSize: PatternSize = {
    x: Math.max(nat.max[0] - nat.min[0], 1e-6),
    y: Math.max(nat.max[1] - nat.min[1], 1e-6),
    z: Math.max(nat.max[2] - nat.min[2], 1e-6),
  };

  const { patternSizeMm, linkPatternSizes, patternScaleAxis } = answers;

  if (
    Math.max(patternSizeMm.x, patternSizeMm.y, patternSizeMm.z) < 1e-9
  ) {
    throw new Error(
      "Carved size is zero — upload a binary STL or set X, Y, and Z under STL size.",
    );
  }

  if (!linkPatternSizes) {
    if (
      patternSizeMm.x < 1e-9 ||
      patternSizeMm.y < 1e-9 ||
      patternSizeMm.z < 1e-9
    ) {
      throw new Error(
        "With proportions unlocked, each carved axis (X, Y, Z) must be greater than zero.",
      );
    }
  }

  let sx: number, sy: number, sz: number;
  if (linkPatternSizes) {
    const kx = patternSizeMm.x / nativeSize.x;
    const ky = patternSizeMm.y / nativeSize.y;
    const kz = patternSizeMm.z / nativeSize.z;
    const r =
      patternScaleAxis === "uniform"
        ? Math.min(kx, ky, kz)
        : patternScaleAxis === "x"
          ? kx
          : patternScaleAxis === "y"
            ? ky
            : patternScaleAxis === "z"
              ? kz
              : Math.min(kx, ky, kz);
    sx = sy = sz = r;
  } else {
    sx = patternSizeMm.x / nativeSize.x;
    sy = patternSizeMm.y / nativeSize.y;
    sz = patternSizeMm.z / nativeSize.z;
  }

  vertices = scaleVertices(vertices, sx, sy, sz);
  const after = bboxFromVertices(vertices);
  const finalSize: PatternSize = {
    x: after.max[0] - after.min[0],
    y: after.max[1] - after.min[1],
    z: after.max[2] - after.min[2],
  };

  return {
    buffer: encodeBinaryStlWithNormals(vertices),
    nativeSize,
    finalSize,
    vertices,
  };
}
