// Command-line runner for the CNCarve relief engine (testing / batch use).
// Uses fixed test settings: 20° V-bit with a 0.1 mm tip, hardwood feeds, 70 × 110 × 10 mm board.
//
// From web/:
//   ./node_modules/.bin/tsc scripts/relief-cli.ts --outDir /tmp/relief-cli --module commonjs \
//     --target es2020 --moduleResolution node --types node --skipLibCheck
//   node /tmp/relief-cli/scripts/relief-cli.js <file.stl> <height-mm> <out-dir>
// Set RELIEF_DUMP=1 to also write the target / simulated height maps for inspection.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseBinaryStl, bboxFromVertices, scaleVertices } from "../src/lib/stl";
import { generateCarve } from "../src/lib/relief/reliefCam";
import { parseGrblGcodeLines } from "../src/lib/grblSerial";

const [stl, heightMm, outDir] = process.argv.slice(2);
const buf = readFileSync(stl);
let v = parseBinaryStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const bb = bboxFromVertices(v);
const s = Number(heightMm) / (bb.max[1] - bb.min[1]);
v = scaleVertices(v, s, s, s);
const t0 = Date.now();
const r = generateCarve({
  vertices: v,
  bit: { type: "vee", halfAngleDeg: 10, tipDiameterMm: 0.1, diameterMm: 3.175 },
  params: {
    finishStepMm: 0.1, roughStepMm: 0.5, roughLayerMm: 0.8, leaveMm: 0.2, topSkimMm: 0.1,
    bandMm: 1.5, floorBelowMm: 0.5, feedRough: 460, feedFinish: 590, feedPlunge: 100,
    spindleS: 10000, safeZ: 3, clearZ: 1, resMm: 0.05,
  },
  board: { widthMm: 70, depthMm: 110, thicknessMm: 10 },
  name: stl.split("/").pop(),
  onProgress: (f: number, l: string) =>
    process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(1)}s ${Math.round(f * 100)}% ${l}\n`),
});
mkdirSync(outDir, { recursive: true });
const p = r.program;
writeFileSync(`${outDir}/carve.nc`, p.gcode);
writeFileSync(`${outDir}/trace.nc`, p.traceGcode);

// Recovery checks: numbering matches what GRBL receives, every restart point is a sideways
// rapid (at whatever height the bit already is — after homing that's the very top).
const lines = parseGrblGcodeLines(p.gcode);
const checks: string[] = [];
if (lines.length !== p.lineCount) checks.push(`line count ${lines.length} != ${p.lineCount}`);
for (const i of p.restartPoints) {
  const l = lines[i];
  if (!/^G0 X-?[\d.]+ Y-?[\d.]+$/.test(l)) checks.push(`restart ${i} is "${l}"`);
  const next = lines[i + 1], plunge = lines[i + 2];
  if (!/^G0 Z/.test(next) || !/^G1 Z-?[\d.]+ F\d+$/.test(plunge)) checks.push(`restart ${i} not followed by G0 Z / G1 Z F: ${next} | ${plunge}`);
  if (checks.length > 5) break;
}
for (let k = 1; k < p.restartPoints.length; k++)
  if (p.restartPoints[k] <= p.restartPoints[k - 1]) { checks.push("restart points not ascending"); break; }
// Largest gap between restart points = most lines that could be re-run (air) after a stop.
let gap = 0;
for (let k = 1; k < p.restartPoints.length; k++) gap = Math.max(gap, p.restartPoints[k] - p.restartPoints[k - 1]);

console.log(JSON.stringify({
  lines: p.lineCount, restartPoints: p.restartPoints.length, largestSegmentLines: gap,
  sections: p.sections.map((x, i) => `${x.label} @${x.start} ~${p.sectionMinutes[i].toFixed(0)}min`),
  estMinutes: Math.round(p.estMinutes), recoveryChecks: checks.length ? checks : "all pass",
  ...r.summary, seconds: (Date.now() - t0) / 1000,
}, null, 1));

if (process.env.RELIEF_DUMP) {
  const pv = r.preview;
  writeFileSync(`${outDir}/target.f32`, Buffer.from(pv.target.buffer));
  writeFileSync(`${outDir}/carved.f32`, Buffer.from(pv.carved.buffer));
  writeFileSync(`${outDir}/work.u8`, Buffer.from(pv.work.buffer));
  writeFileSync(`${outDir}/grid.json`, JSON.stringify({ w: pv.width, h: pv.height, res: pv.res }));
}
