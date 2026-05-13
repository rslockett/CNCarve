import { bboxFromVertices } from "./stl";

/**
 * Pick contour **axis** for single-bit relief: one full 3D contour pass (Kiri op axis X or Y).
 *
 * - **Contour Y** steps the tool across **X** (more slices when the mesh is wide in X).
 * - **Contour X** steps across **Y**.
 *
 * We score triangle edges in the scaled mesh: relief-heavy edges (large |Δz|) that run mostly
 * along **X** benefit from **Contour Y** (many X steps cross them). Same for Y / Contour X.
 * When the mesh is flat or ambiguous, we pick the axis with **fewer contour passes** (shorter
 * march) for time.
 */
export function chooseSingleBitContourAxis(vertices: Float32Array): "X" | "Y" {
  let scoreX = 0;
  let scoreY = 0;
  for (let t = 0; t + 8 < vertices.length; t += 9) {
    const ax = vertices[t],
      ay = vertices[t + 1],
      az = vertices[t + 2];
    const bx = vertices[t + 3],
      by = vertices[t + 4],
      bz = vertices[t + 5];
    const cx = vertices[t + 6],
      cy = vertices[t + 7],
      cz = vertices[t + 8];
    const edges: [number, number, number][] = [
      [bx - ax, by - ay, bz - az],
      [cx - bx, cy - by, cz - bz],
      [ax - cx, ay - cy, az - cz],
    ];
    for (const [dx, dy, dz] of edges) {
      const hLen = Math.hypot(dx, dy);
      if (hLen < 1e-9) continue;
      const w = Math.abs(dz);
      if (w < 1e-9) continue;
      scoreX += (w * dx * dx) / hLen;
      scoreY += (w * dy * dy) / hLen;
    }
  }

  const rel = 1.02;
  if (scoreX > scoreY * rel) return "Y";
  if (scoreY > scoreX * rel) return "X";

  const bb = bboxFromVertices(vertices);
  const spanX = Math.max(bb.max[0] - bb.min[0], 1e-9);
  const spanY = Math.max(bb.max[1] - bb.min[1], 1e-9);
  // Contour Y → pass count ~ spanX / step; Contour X ~ spanY / step — prefer fewer passes.
  return spanX <= spanY ? "Y" : "X";
}
