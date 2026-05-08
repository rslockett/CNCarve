import {
  bboxFromVertices,
  encodeBinaryStlWithNormals,
  parseBinaryStl,
  scaleVertices,
} from "./stl";
import type { WizardAnswers } from "./presets/types";

export type PatternSize = { x: number; y: number; z: number };

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
): { buffer: ArrayBuffer; nativeSize: PatternSize; finalSize: PatternSize } {
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
    const target =
      patternScaleAxis === "uniform"
        ? Math.max(patternSizeMm.x, patternSizeMm.y, patternSizeMm.z)
        : patternScaleAxis === "x"
          ? patternSizeMm.x
          : patternScaleAxis === "y"
            ? patternSizeMm.y
            : patternScaleAxis === "z"
              ? patternSizeMm.z
              : Math.max(patternSizeMm.x, patternSizeMm.y, patternSizeMm.z);
    const base =
      patternScaleAxis === "uniform"
        ? Math.max(nativeSize.x, nativeSize.y, nativeSize.z)
        : patternScaleAxis === "x"
          ? nativeSize.x
          : patternScaleAxis === "y"
            ? nativeSize.y
            : patternScaleAxis === "z"
              ? nativeSize.z
              : Math.max(nativeSize.x, nativeSize.y, nativeSize.z);
    const r = target / base;
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
  };
}
