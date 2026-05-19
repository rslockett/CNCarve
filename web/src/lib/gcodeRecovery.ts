/**
 * G-code job recovery: modal state scanning, UGS-style resume preamble, and localStorage
 * persistence so a mid-job USB disconnect can be recovered after rehoming.
 *
 * Recovery flow (requires homing switches):
 *   1. Disconnect detected → saveJobState() called with last-acked line
 *   2. User reconnects, app shows recovery banner
 *   3. User clicks "Recover" → $H (home cycle) → buildResumePreamble() sent → stream from N
 *
 * The home cycle restores machine coordinates; G54 WCS survived in GRBL EEPROM, so after
 * homing the work coordinate origin is exactly where the user set it before the job.
 */

export type GcodeModalState = {
  units: "G21" | "G20";
  distMode: "G90" | "G91";
  feedMode: "G94" | "G93";
  wcs: "G54" | "G55" | "G56" | "G57" | "G58" | "G59";
  plane: "G17" | "G18" | "G19";
  spindleMode: "M3" | "M4" | null;
  rpm: number;
  feedRate: number;
  x: number;
  y: number;
  z: number;
  /** Highest Z seen in lines 0..N — used as safe retract height in preamble. */
  maxZ: number;
};

type SavedJobState = {
  lineIndex: number;
  gcodeHash: number;
  savedAt: number;
  lineCount: number;
};

const JOB_STATE_KEY = "cncarve:jobState";

function simpleHash(s: string): number {
  // Fingerprint = polynomial hash over a sample (first+last 500 chars) XOR'd with length.
  const sample = s.length <= 1000 ? s : s.slice(0, 500) + s.slice(-500);
  let h = 0;
  for (let i = 0; i < sample.length; i++) {
    h = (Math.imul(31, h) + sample.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) ^ (s.length & 0xffff_ffff)) >>> 0;
}

function stripComments(line: string): string {
  const noParen = line.replace(/\([^)]*\)/g, "");
  const si = noParen.indexOf(";");
  return (si >= 0 ? noParen.slice(0, si) : noParen).trim().toUpperCase();
}

function parseWords(raw: string): { letter: string; value: number }[] {
  const result: { letter: string; value: number }[] = [];
  const re = /([A-Z])(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    result.push({ letter: m[1], value: parseFloat(m[2]) });
  }
  return result;
}

/**
 * Dry-run G-code lines 0..upToIndex-1 through a modal state tracker (UGS RunFromProcessor style).
 * Returns the machine state *before* line `upToIndex` executes — i.e. where the tool is and what
 * modes are active when that line is about to run.
 */
export function scanGcodeModalState(lines: string[], upToIndex: number): GcodeModalState {
  const st: GcodeModalState = {
    units: "G21",
    distMode: "G90",
    feedMode: "G94",
    wcs: "G54",
    plane: "G17",
    spindleMode: null,
    rpm: 0,
    feedRate: 0,
    x: 0,
    y: 0,
    z: 0,
    maxZ: 0,
  };

  const limit = Math.min(upToIndex, lines.length);
  for (let i = 0; i < limit; i++) {
    const raw = stripComments(lines[i]);
    if (!raw) continue;

    const words = parseWords(raw);
    const gCodes: number[] = [];
    const mCodes: number[] = [];
    let lineX: number | null = null;
    let lineY: number | null = null;
    let lineZ: number | null = null;
    let lineS: number | null = null;
    let lineF: number | null = null;

    for (const w of words) {
      switch (w.letter) {
        case "G": gCodes.push(w.value); break;
        case "M": mCodes.push(w.value); break;
        case "X": lineX = w.value; break;
        case "Y": lineY = w.value; break;
        case "Z": lineZ = w.value; break;
        case "S": lineS = w.value; break;
        case "F": lineF = w.value; break;
      }
    }

    for (const g of gCodes) {
      if (g === 20) st.units = "G20";
      else if (g === 21) st.units = "G21";
      else if (g === 90) st.distMode = "G90";
      else if (g === 91) st.distMode = "G91";
      // G90.1/G91.1 arc modes intentionally ignored (not needed for position preamble)
      else if (g === 93) st.feedMode = "G93";
      else if (g === 94) st.feedMode = "G94";
      else if (g === 54) st.wcs = "G54";
      else if (g === 55) st.wcs = "G55";
      else if (g === 56) st.wcs = "G56";
      else if (g === 57) st.wcs = "G57";
      else if (g === 58) st.wcs = "G58";
      else if (g === 59) st.wcs = "G59";
      else if (g === 17) st.plane = "G17";
      else if (g === 18) st.plane = "G18";
      else if (g === 19) st.plane = "G19";
    }

    for (const m of mCodes) {
      if (m === 3) st.spindleMode = "M3";
      else if (m === 4) st.spindleMode = "M4";
      else if (m === 5) st.spindleMode = null;
    }

    if (lineS !== null && lineS >= 0) st.rpm = lineS;
    if (lineF !== null && lineF > 0) st.feedRate = lineF;

    if (lineX !== null || lineY !== null || lineZ !== null) {
      if (st.distMode === "G90") {
        if (lineX !== null) st.x = lineX;
        if (lineY !== null) st.y = lineY;
        if (lineZ !== null) st.z = lineZ;
      } else {
        if (lineX !== null) st.x += lineX;
        if (lineY !== null) st.y += lineY;
        if (lineZ !== null) st.z += lineZ;
      }
    }

    if (st.z > st.maxZ) st.maxZ = st.z;
  }

  return st;
}

/**
 * Build a safe resume preamble for post-homing recovery.
 *
 * After $H the machine is at the homed position (Z at maximum travel = physically highest point).
 * The sequence here keeps Z at that elevated home height while moving XY over the resume point,
 * THEN descends to safe clearance height, THEN starts the spindle, THEN plunges. This prevents
 * the bit from clipping any clamps or hold-downs during the lateral transit.
 *
 * Order:
 *   1. Modal state (units, G90, feed mode, WCS, plane) — no motion
 *   2. G0 XY → rapid to resume XY at full homed Z height (bit is as high as it can go)
 *   3. G0 Z{safeZ} → descend to safe clearance above stock (still clear of workpiece)
 *   4. M3/M4 S{rpm} + G4 P2 → start spindle, wait 2 s for spin-up
 *   5. G1 Z{z} F{feed} → plunge to cutting depth at controlled feed rate
 */
export function buildResumePreamble(state: GcodeModalState, zClearanceMm = 4): string[] {
  const clearance = state.units === "G20" ? zClearanceMm / 25.4 : zClearanceMm;
  const safeZ = (state.maxZ + clearance).toFixed(3);
  const preamble: string[] = [];

  // Modal restoration — no motion
  preamble.push(state.units);
  preamble.push("G90");
  preamble.push(state.feedMode);
  preamble.push(state.wcs);
  preamble.push(state.plane);

  // XY transit at homed Z height (bit is at ceiling — can't hit any clamp)
  preamble.push(`G0 X${state.x.toFixed(3)} Y${state.y.toFixed(3)}`);

  // Descend to safe clearance above stock
  preamble.push(`G0 Z${safeZ}`);

  // Start spindle only after the bit is over the right spot, not while transiting
  if (state.spindleMode !== null && state.rpm > 0) {
    preamble.push(`${state.spindleMode} S${Math.round(state.rpm)}`);
    preamble.push("G4 P2");
  }

  // Plunge at controlled feed rate
  const fPart = state.feedRate > 0 ? ` F${state.feedRate.toFixed(1)}` : "";
  preamble.push(`G1 Z${state.z.toFixed(3)}${fPart}`);

  return preamble;
}

/** Persist job progress so a disconnect can be recovered. Call every ~50 acks and on disconnect. */
export function saveJobState(gcodeText: string, lineIndex: number, lineCount: number): void {
  try {
    const state: SavedJobState = {
      lineIndex,
      gcodeHash: simpleHash(gcodeText),
      savedAt: Date.now(),
      lineCount,
    };
    localStorage.setItem(JOB_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage unavailable in some browser configs */
  }
}

/**
 * Load saved job state and verify it matches the currently loaded G-code.
 * Returns null if there is no saved state, the hash doesn't match, or it's stale (>24 h).
 */
export function loadJobState(gcodeText: string): { lineIndex: number; lineCount: number } | null {
  try {
    const raw = localStorage.getItem(JOB_STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedJobState;
    if (s.gcodeHash !== simpleHash(gcodeText)) return null;
    if (Date.now() - s.savedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(JOB_STATE_KEY);
      return null;
    }
    if (s.lineIndex <= 0 || s.lineIndex >= s.lineCount) return null;
    return { lineIndex: s.lineIndex, lineCount: s.lineCount };
  } catch {
    return null;
  }
}

/** Clear saved job state — call on successful job completion or explicit user dismiss. */
export function clearJobState(): void {
  try {
    localStorage.removeItem(JOB_STATE_KEY);
  } catch {
    /* ignore */
  }
}
