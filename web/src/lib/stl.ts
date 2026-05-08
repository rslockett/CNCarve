/**
 * Binary STL read/write: triangle soup as Float32Array (9 floats per triangle).
 */

export type BBox = {
  min: [number, number, number];
  max: [number, number, number];
};

export function bboxFromVertices(vertices: Float32Array): BBox {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i],
      y = vertices[i + 1],
      z = vertices[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

export function parseBinaryStl(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  if (buffer.byteLength < 84) {
    throw new Error("File is too small to be a binary STL.");
  }
  const triCount = view.getUint32(80, true);
  const expect = 84 + triCount * 50;
  if (expect > buffer.byteLength + 16) {
    throw new Error("STL triangle count does not match file size.");
  }
  const out = new Float32Array(triCount * 9);
  let off = 84;
  let w = 0;
  for (let t = 0; t < triCount; t++) {
    off += 12; // skip normal
    for (let v = 0; v < 3; v++) {
      out[w++] = view.getFloat32(off, true);
      off += 4;
      out[w++] = view.getFloat32(off, true);
      off += 4;
      out[w++] = view.getFloat32(off, true);
      off += 4;
    }
    off += 2; // attribute
  }
  return out;
}

/** Encode triangle vertices (Float32Array length n*9) as binary STL */
export function encodeBinaryStl(vertices: Float32Array): ArrayBuffer {
  const triCount = vertices.length / 9;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const u8 = new Uint8Array(buf);
  u8.fill(0, 0, 80);
  const enc = new TextEncoder();
  const header = enc.encode("CNCarve");
  u8.set(header.slice(0, 80), 0);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    dv.setFloat32(off, 0, true);
    off += 4;
    dv.setFloat32(off, 0, true);
    off += 4;
    dv.setFloat32(off, 0, true);
    off += 4;
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(off, vertices[t * 9 + k], true);
      off += 4;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

function triangleNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Recompute facet normals in STL buffer (optional polish) */
export function encodeBinaryStlWithNormals(vertices: Float32Array): ArrayBuffer {
  const triCount = vertices.length / 9;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const u8 = new Uint8Array(buf);
  u8.fill(0, 0, 80);
  const enc = new TextEncoder();
  u8.set(enc.encode("CNCarve").slice(0, 80), 0);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const [nx, ny, nz] = triangleNormal(
      vertices[i],
      vertices[i + 1],
      vertices[i + 2],
      vertices[i + 3],
      vertices[i + 4],
      vertices[i + 5],
      vertices[i + 6],
      vertices[i + 7],
      vertices[i + 8],
    );
    dv.setFloat32(off, nx, true);
    off += 4;
    dv.setFloat32(off, ny, true);
    off += 4;
    dv.setFloat32(off, nz, true);
    off += 4;
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(off, vertices[i + k], true);
      off += 4;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

export function scaleVertices(
  vertices: Float32Array,
  sx: number,
  sy: number,
  sz: number,
): Float32Array {
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i] * sx;
    out[i + 1] = vertices[i + 1] * sy;
    out[i + 2] = vertices[i + 2] * sz;
  }
  return out;
}

export function translateVertices(
  vertices: Float32Array,
  tx: number,
  ty: number,
  tz: number,
): void {
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] += tx;
    vertices[i + 1] += ty;
    vertices[i + 2] += tz;
  }
}
