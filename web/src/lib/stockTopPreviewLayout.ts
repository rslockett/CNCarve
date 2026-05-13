import type { PatternPlacement } from "@/lib/presets/types";

/** 2D footprint in the stock top plane (STL X → horizontal, STL Y → vertical on screen, y grows downward). */
export type BBox2d = { minX: number; minY: number; maxX: number; maxY: number };

/** Axis-aligned XY bounds of triangle vertices (every 3 floats = x,y,z). */
export function bbox2dFromVerticesXY(vertices: Float32Array): BBox2d {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return { minX, minY, maxX, maxY };
}

const cx = (b: BBox2d) => (b.minX + b.maxX) / 2;
const cy = (b: BBox2d) => (b.minY + b.maxY) / 2;

/**
 * Translation (mm) applied in the stock top plane so the mesh sits like the wizard placement.
 * Coordinates: origin top-left of stock, x → right, y → down (same as the SVG fit preview).
 * Kiri re-centers on load when origin-center is on; for "center" this matches. Other placements
 * are the intended layout before manual Arrange in Kiri.
 */
export function meshPlacementOffsetMm(
  placement: PatternPlacement,
  stockWidthMm: number,
  stockDepthMm: number,
  marginMm: number,
  bbox: BBox2d,
): { ox: number; oy: number } {
  const w = Math.max(stockWidthMm, 1e-6);
  const d = Math.max(stockDepthMm, 1e-6);
  const m = Math.max(0, marginMm);
  const innerL = m;
  const innerR = w - m;
  const innerT = m;
  const innerB = d - m;

  const bx = cx(bbox);
  const by = cy(bbox);

  switch (placement) {
    case "center":
      return { ox: w / 2 - bx, oy: d / 2 - by };
    case "front_left":
      return { ox: innerL - bbox.minX, oy: innerB - bbox.maxY };
    case "front_right":
      return { ox: innerR - bbox.maxX, oy: innerB - bbox.maxY };
    case "back_left":
      return { ox: innerL - bbox.minX, oy: innerT - bbox.minY };
    case "back_right":
      return { ox: innerR - bbox.maxX, oy: innerT - bbox.minY };
    case "left":
      return { ox: innerL - bbox.minX, oy: d / 2 - by };
    case "right":
      return { ox: innerR - bbox.maxX, oy: d / 2 - by };
    case "front":
      return { ox: w / 2 - bx, oy: innerB - bbox.maxY };
    case "back":
      return { ox: w / 2 - bx, oy: innerT - bbox.minY };
    default:
      return { ox: w / 2 - bx, oy: d / 2 - by };
  }
}

/** True iff translated mesh bbox lies fully inside the margin inset of the stock. */
export function meshFitsStockWithMargin(
  bbox: BBox2d,
  ox: number,
  oy: number,
  stockWidthMm: number,
  stockDepthMm: number,
  marginMm: number,
): boolean {
  const m = Math.max(0, marginMm);
  const minX = bbox.minX + ox;
  const maxX = bbox.maxX + ox;
  const minY = bbox.minY + oy;
  const maxY = bbox.maxY + oy;
  return (
    minX >= m - 1e-5 &&
    maxX <= stockWidthMm - m + 1e-5 &&
    minY >= m - 1e-5 &&
    maxY <= stockDepthMm - m + 1e-5
  );
}
