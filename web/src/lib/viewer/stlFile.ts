/**
 * Read any STL: binary, or text ("ASCII") like some ArtCAM exports.
 * Returns triangle soup (9 floats per triangle).
 */
import { parseBinaryStl } from "../stl";

/** True when the file is a text STL (binary size check fails and it starts with "solid"). */
export function isTextStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return true;
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, 5)).toLowerCase();
  const tris = new DataView(buffer).getUint32(80, true);
  const binaryFits = 84 + tris * 50 <= buffer.byteLength + 16 && 84 + tris * 50 >= buffer.byteLength - 16;
  return head === "solid" && !binaryFits;
}

export function parseAnyStl(buffer: ArrayBuffer): Float32Array {
  return isTextStl(buffer) ? parseTextStl(buffer) : parseBinaryStl(buffer);
}

/** Text STL: read in chunks (files can be hundreds of MB), collecting "vertex x y z" lines. */
function parseTextStl(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer);
  const dec = new TextDecoder("latin1");
  let out = new Float32Array(1 << 20);
  let n = 0;
  const push = (v: number) => {
    if (n === out.length) {
      const bigger = new Float32Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[n++] = v;
  };
  const CHUNK = 8 << 20;
  let carry = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const text = carry + dec.decode(bytes.subarray(start, Math.min(bytes.length, start + CHUNK)));
    // Keep any unfinished last line for the next chunk.
    const cut = start + CHUNK < bytes.length ? text.lastIndexOf("\n") : text.length;
    const body = text.slice(0, cut);
    carry = text.slice(cut);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      push(+m[1]);
      push(+m[2]);
      push(+m[3]);
    }
  }
  const usable = n - (n % 9);
  if (usable === 0) throw new Error("No triangles found in this STL.");
  return out.slice(0, usable);
}
