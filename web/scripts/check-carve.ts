// Safety check for a carving program, the way the app makes it.
//
//   npx tsx scripts/check-carve.ts <file.stl> <height-mm, 0 = size in the file> <finish> [wood]
//   finish: asBefore | standard | smoothest     wood: hardwood (default) | softwood | mdf
//
// 1. Makes the program with the app's settings (20° V-bit, balanced quality).
// 2. Same cuts as "asBefore" (same grid):
//    - roughing: carved into a virtual board, at every point it leaves at least as much wood
//      above the finished surface as "asBefore" does (or at least 0.15 mm, the planned skin less
//      a margin). The new
//      roughing glides across short, already-cut gaps; there it can reach the planned depth
//      where the old one stopped a few hundredths short, but never below it;
//    - detail: every cutting move identical (unless the new modes put the rows closer together).
// 3. No collisions: replays the whole program into a virtual board (0.06 mm grid, the bit's full
//    cone at exact positions) and measures how close every fast move gets to the wood. Straight
//    lifts are skipped: the bit rises through the space it just cut.
// Exits with code 1 if anything fails.
import { readFileSync } from "node:fs";
import { parseBinaryStl } from "../src/lib/stl";
import { orientForCarving } from "../src/lib/relief/fit";
import { generateCarve, type FinishMode } from "../src/lib/relief/reliefCam";
import { deriveReliefSettings } from "../src/lib/relief/settings";

const [stl, heightArg, finishArg = "standard", wood = "hardwood"] = process.argv.slice(2);
const finish = finishArg as FinishMode;
const MIN_GAP = 0.1; // mm: a fast move closer than this to the wood fails the check

const buf = readFileSync(stl);
const o = orientForCarving(parseBinaryStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const sc = Number(heightArg) > 0 ? Number(heightArg) / o.size.y : 1;
const verts = o.vertices.map((v) => v * sc);
const size = { x: o.size.x * sc, y: o.size.y * sc };
const settings = deriveReliefSettings(
  { machineId: "sainsmart-3018-prover", toolId: 1003, materialId: wood, qualityId: "balanced" },
  size,
  finish,
);
if (settings.bit.type !== "vee") throw new Error("This check is for V-bits.");
const bit = settings.bit;
const board = { widthMm: 300, depthMm: 200, thicknessMm: 19 };
const make = (f: FinishMode) =>
  generateCarve({ vertices: new Float32Array(verts), bit, params: { ...settings.params, finish: f }, board }).program;
const prog = make(finish);
let failed = false;
console.log(`${stl.split("/").pop()}  ${size.x.toFixed(0)} × ${size.y.toFixed(0)} mm  finish ${finish}  ${prog.lineCount} lines`);

// ---- virtual board ----
const RES = 0.06, t = Math.tan((bit.halfAngleDeg * Math.PI) / 180), TIP = bit.tipDiameterMm / 2;
const lines = prog.gcode.split("\n");
let minZ = 0;
for (const l of lines) {
  const z = /Z(-?[\d.]+)/.exec(l);
  if (z) minZ = Math.min(minZ, +z[1]);
}
// The cone is above any wood beyond this (the deepest the tip goes, plus a margin).
const R = Math.min(bit.diameterMm / 2, TIP + (-minZ + 0.5) * t);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const l of lines) {
  const x = /X(-?[\d.]+)/.exec(l), y = /Y(-?[\d.]+)/.exec(l);
  if (x) { minX = Math.min(minX, +x[1]); maxX = Math.max(maxX, +x[1]); }
  if (y) { minY = Math.min(minY, +y[1]); maxY = Math.max(maxY, +y[1]); }
}
const pad = 2;
const W = Math.ceil((maxX - minX + 2 * pad) / RES), H = Math.ceil((maxY - minY + 2 * pad) / RES);
const k = Math.ceil(R / RES);
const fx = (x: number) => (x - minX + pad) / RES, fy = (y: number) => (y - minY + pad) / RES;
const cone = (r: number) => (r > TIP ? (r - TIP) / t : 0);
function cut(g: Float32Array, x: number, y: number, z: number) {
  const X = fx(x), Y = fy(y);
  for (let j = Math.max(0, Math.floor(Y - k)); j <= Math.min(H - 1, Math.ceil(Y + k)); j++)
    for (let i = Math.max(0, Math.floor(X - k)); i <= Math.min(W - 1, Math.ceil(X + k)); i++) {
      const r = Math.hypot(i - X, j - Y) * RES;
      if (r > R) continue;
      const v = z + cone(r), q = j * W + i;
      if (v < g[q]) g[q] = v;
    }
}
function gap(g: Float32Array, x: number, y: number, z: number) {
  const X = fx(x), Y = fy(y);
  let best = 1e9;
  for (let j = Math.max(0, Math.floor(Y - k)); j <= Math.min(H - 1, Math.ceil(Y + k)); j++)
    for (let i = Math.max(0, Math.floor(X - k)); i <= Math.min(W - 1, Math.ceil(X + k)); i++) {
      const r = Math.hypot(i - X, j - Y) * RES;
      if (r > R) continue;
      const c = z + cone(r) - g[j * W + i];
      if (c < best) best = c;
    }
  return best;
}
/**
 * Replay a program into a fresh board. `only` limits which sections cut. With `check`, every fast
 * move below the board top is measured against the wood as it is at that moment.
 */
function replay(gcode: string, only: (section: string) => boolean, check = false) {
  const g = new Float32Array(W * H); // board top = 0
  let x = 0, y = 0, z = 3, section = "";
  const res = { worst: 1e9, worstLine: "", close: 0, checked: 0 };
  for (const l of gcode.split("\n")) {
    if (l.startsWith("(SECTION")) { section = l.slice(9, -1); continue; }
    if (!(l.startsWith("G0") || l.startsWith("G1"))) continue;
    const X = /X(-?[\d.]+)/.exec(l), Y = /Y(-?[\d.]+)/.exec(l), Z = /Z(-?[\d.]+)/.exec(l);
    const nx = X ? +X[1] : x, ny = Y ? +Y[1] : y, nz = Z ? +Z[1] : z;
    const fast = l.startsWith("G0") || l.includes(" F1000");
    const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y, nz - z) / RES));
    const straightUp = nx === x && ny === y && nz >= z;
    const cutting = !fast && only(section);
    if (cutting || (check && fast && !straightUp && Math.min(z, nz) < 0))
      for (let s = 0; s <= steps; s++) {
        const f = s / steps, px = x + (nx - x) * f, py = y + (ny - y) * f, pz = z + (nz - z) * f;
        if (cutting) cut(g, px, py, pz);
        else if (pz < 0) {
          const d = gap(g, px, py, pz);
          res.checked++;
          if (d < res.worst) { res.worst = d; res.worstLine = `${section}: ${l}`; }
          if (d < MIN_GAP) res.close++;
        }
      }
    x = nx; y = ny; z = nz;
  }
  return { g, ...res };
}

// ---- 3 first: the whole program (finished surface + collisions) ----
const c = replay(prog.gcode, () => true, true);

// ---- 2. same cuts as before ----
if (finish !== "asBefore") {
  const old = make("asBefore").gcode;
  const roughOnly = (s: string) => s.startsWith("Roughing - layer");
  const a = replay(old, roughOnly).g, b = replay(prog.gcode, roughOnly).g, done = c.g;
  // At every point of the carving: the new roughing leaves at least as much wood above the
  // finished surface as the old one did, or at least 0.15 mm (the planned 0.2 mm skin less a
  // margin). On steep walls both are 0 (the roughing cone already is the finished wall).
  let worst = 1e9, deeper = 0, bad = 0;
  for (let q = 0; q < a.length; q++) {
    deeper = Math.max(deeper, a[q] - b[q]);
    if (done[q] >= 0) continue; // untouched board
    const need = Math.min(a[q] - done[q], 0.15) - 0.01;
    const margin = b[q] - done[q] - need;
    if (margin < worst) worst = margin;
    if (margin < 0) bad++;
  }
  const ok = bad === 0;
  console.log(
    `  roughing stays clear of the finished surface everywhere: ${ok ? "yes" : `NO (${bad} points)`} (at most ${deeper.toFixed(3)} mm deeper than "as before", always above the planned skin)`,
  );
  if (!ok) failed = true;

  const cuts = (g: string) => {
    const out: string[] = [];
    let on = false;
    for (const l of g.split("\n")) {
      if (l.startsWith("(SECTION")) on = l.includes("Detail");
      if (on && l.startsWith("G1") && !l.includes(" F1000") && /[XY]/.test(l)) out.push(l.replace(/ F\d+$/, ""));
    }
    return out;
  };
  const rowsY = (c: string[]) => new Set(c.map((l) => /Y(-?[\d.]+)/.exec(l)?.[1])).size;
  const da = cuts(old), db = cuts(prog.gcode);
  if (rowsY(da) === rowsY(db)) {
    const same = da.length === db.length && da.every((l, i) => l === db[i]);
    console.log(`  detail cuts identical to "as before": ${same ? "yes" : "NO"} (${da.length} cutting moves)`);
    if (!same) failed = true;
  } else console.log(`  detail rows closer together than "as before": ${rowsY(db)} rows instead of ${rowsY(da)}`);
}

// ---- 3. no collisions ----
console.log(`  fast moves below the board top: ${c.checked} points checked, closest to the wood ${c.worst === 1e9 ? "-" : c.worst.toFixed(3)} mm (${c.worstLine})`);
console.log(`  closer than ${MIN_GAP} mm: ${c.close}`);
if (c.close > 0) failed = true;
console.log(failed ? "  FAILED" : "  passed");
process.exit(failed ? 1 : 0);
