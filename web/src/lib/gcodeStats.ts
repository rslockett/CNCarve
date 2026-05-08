export type ParsedMotion = {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  feed: number;
  sourceLine: number;
  rapid: boolean;
  durationSec: number;
};

export type GcodeStats = {
  motions: ParsedMotion[];
  streamableLines: number;
  totalDurationSec: number;
};

function stripComments(line: string): string {
  const noParen = line.replace(/\([^)]*\)/g, "");
  const semi = noParen.indexOf(";");
  return semi >= 0 ? noParen.slice(0, semi).trim() : noParen.trim();
}

function extractWords(line: string): string[] {
  const compact = line.replace(/\s+/g, "");
  const matches = compact.match(/[A-Z][+\-]?\d*\.?\d*/gi) ?? [];
  return matches.map((m) => m.toUpperCase());
}

export function parseGcodeStats(gcode: string): GcodeStats {
  const filtered = gcode
    .split(/\r?\n/)
    .map(stripComments)
    .filter((line) => line.length > 0 && line !== "%");

  let x = 0;
  let y = 0;
  let z = 0;
  let feed = 600;
  let absolute = true;
  let streamableLines = 0;
  const motions: ParsedMotion[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const words = extractWords(filtered[i]);
    if (words.length === 0) continue;
    streamableLines += 1;

    if (words.includes("G90")) absolute = true;
    if (words.includes("G91")) absolute = false;

    for (const w of words) {
      if (w.startsWith("F")) {
        const n = Number(w.slice(1));
        if (Number.isFinite(n) && n > 0) feed = n;
      }
    }

    const isLinear = words.some((w) => w === "G0" || w === "G00" || w === "G1" || w === "G01");
    if (!isLinear) continue;

    const rapid = words.some((w) => w === "G0" || w === "G00");
    const sx = x;
    const sy = y;
    const sz = z;
    let nx = x;
    let ny = y;
    let nz = z;
    for (const w of words) {
      const axis = w[0];
      const n = Number(w.slice(1));
      if (!Number.isFinite(n)) continue;
      if (axis === "X") nx = absolute ? n : nx + n;
      if (axis === "Y") ny = absolute ? n : ny + n;
      if (axis === "Z") nz = absolute ? n : nz + n;
    }

    const dx = nx - sx;
    const dy = ny - sy;
    const dz = nz - sz;
    const dist = Math.hypot(dx, dy, dz);
    const motionFeed = rapid ? Math.max(feed, 2500) : Math.max(feed, 1);
    const durationSec = dist > 0 ? (dist / motionFeed) * 60 : 0;

    x = nx;
    y = ny;
    z = nz;

    if (dist > 0) {
      motions.push({
        x1: sx,
        y1: sy,
        z1: sz,
        x2: nx,
        y2: ny,
        z2: nz,
        sourceLine: i + 1,
        rapid,
        feed: motionFeed,
        durationSec,
      });
    }
  }

  const totalDurationSec = motions.reduce((sum, m) => sum + m.durationSec, 0);
  return { motions, streamableLines, totalDurationSec };
}

export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
