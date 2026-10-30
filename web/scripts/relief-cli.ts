// Command-line runner for the CNCarve relief engine (testing / batch use).
// Uses fixed test settings: 20° V-bit with a 0.1 mm tip, hardwood feeds, centred on a 70 × 110 mm board.
//
// From web/:
//   ./node_modules/.bin/tsc scripts/relief-cli.ts --outDir /tmp/relief-cli --module commonjs \
//     --target es2020 --moduleResolution node --types node --skipLibCheck
//   node /tmp/relief-cli/scripts/relief-cli.js <file.stl> <height-mm> <out-dir>
// Set RELIEF_DUMP=1 to also write the target / simulated height maps for inspection.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseBinaryStl, bboxFromVertices, scaleVertices } from "../src/lib/stl";
import { generateReliefJobs } from "../src/lib/relief/reliefCam";

const [stl, heightMm, outDir] = process.argv.slice(2);
const buf = readFileSync(stl);
let v = parseBinaryStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const bb = bboxFromVertices(v);
const s = Number(heightMm) / (bb.max[1] - bb.min[1]);
v = scaleVertices(v, s, s, s);
const t0 = Date.now();
const r = generateReliefJobs({
  vertices: v,
  bit: { type: "vee", halfAngleDeg: 10, tipDiameterMm: 0.1, diameterMm: 3.175 },
  params: {
    finishStepMm: 0.1, roughStepMm: 0.5, roughLayerMm: 0.8, leaveMm: 0.2, topSkimMm: 0.1,
    bandMm: 1.5, floorBelowMm: 0.5, feedRough: 450, feedFinish: 600, feedPlunge: 100,
    spindleS: 1000, safeZ: 3, clearZ: 1, regions: 3, resMm: 0.05,
  },
  placement: { where: "center", stockWidthMm: 70, stockDepthMm: 110, marginMm: 5 },
  onProgress: (f, l) =>
    process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(1)}s ${Math.round(f * 100)}% ${l}\n`),
});
mkdirSync(outDir, { recursive: true });
for (const j of r.jobs) {
  writeFileSync(`${outDir}/${j.fileName}`, j.gcode);
  console.log(`${j.fileName.padEnd(28)} ~${j.estMinutes.toFixed(1).padStart(6)} min ${String(j.lines).padStart(7)} lines`);
}
console.log(JSON.stringify({ ...r.summary, seconds: (Date.now() - t0) / 1000 }, null, 1));
if (process.env.RELIEF_DUMP) {
  const p = r.preview;
  writeFileSync(`${outDir}/target.f32`, Buffer.from(p.target.buffer));
  writeFileSync(`${outDir}/carved.f32`, Buffer.from(p.carved.buffer));
  writeFileSync(`${outDir}/work.u8`, Buffer.from(p.work.buffer));
  writeFileSync(`${outDir}/grid.json`, JSON.stringify({ w: p.width, h: p.height, res: p.res, workMinX: r.summary.workMinX, workMinY: r.summary.workMinY }));
}
