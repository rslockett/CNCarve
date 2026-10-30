/**
 * Keeps the current carving on this device so it survives a page reload, a browser crash or a
 * Raspberry Pi reboot. The program itself (several MB) lives in IndexedDB; progress is a tiny
 * record in localStorage that is updated every few lines.
 */

import type { CarveSection } from "./relief/reliefCam";

export type SavedCarve = {
  id: string;
  name: string;
  bitLabel: string;
  gcode: string;
  lineCount: number;
  restartPoints: number[];
  sections: CarveSection[];
  estMinutes: number;
  /** Estimated minutes for each section (same order as `sections`). */
  sectionMinutes: number[];
  spindleS: number;
  /** Where zero was (machine coordinates, from `$#`) when carving started. */
  g54: { x: number; y: number; z: number } | null;
  startedAt: number;
};

export type CarveProgress = {
  id: string;
  /** Highest line index GRBL has acknowledged (queued, not necessarily cut yet). */
  lastAcked: number;
  updatedAt: number;
  finished: boolean;
};

const DB = "cncarve";
const STORE = "carves";
const KEY = "current";
const PROGRESS_KEY = "cncarve:carveProgress";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCarve(c: SavedCarve): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(c, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  saveProgress({ id: c.id, lastAcked: -1, updatedAt: Date.now(), finished: false });
}

export async function loadCarve(): Promise<SavedCarve | null> {
  try {
    const db = await openDb();
    const c = await new Promise<SavedCarve | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as SavedCarve | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return c;
  } catch {
    return null;
  }
}

export async function clearCarve(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* nothing saved */
  }
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}

export function saveProgress(p: CarveProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked — recovery falls back to the start of the current section */
  }
}

export function loadProgress(id: string): CarveProgress | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "null") as CarveProgress | null;
    return p && p.id === id ? p : null;
  } catch {
    return null;
  }
}

/**
 * GRBL acknowledges a line when it is *queued*, up to ~16 moves (plus a few lines in its serial
 * buffer) before the bit actually gets there. So back up well past that and restart at the
 * beginning of a segment. Re-running already-cut moves only cuts air.
 */
export const RESTART_BACKUP_LINES = 40;

export function chooseRestartLine(carve: SavedCarve, lastAcked: number): number {
  const limit = lastAcked - RESTART_BACKUP_LINES;
  let best = 0;
  for (const r of carve.restartPoints) {
    if (r <= limit) best = r;
    else break;
  }
  return best;
}

export function sectionAt(sections: CarveSection[], line: number): CarveSection | null {
  let cur: CarveSection | null = null;
  for (const s of sections) {
    if (s.start <= line) cur = s;
    else break;
  }
  return cur;
}
