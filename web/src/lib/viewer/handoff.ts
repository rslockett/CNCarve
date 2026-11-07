/**
 * Hand an STL picked in the viewer to the Simple carve page.
 * Kept in its own small browser database so it never touches the saved carve (and its
 * pause/resume progress) in the "cncarve" database.
 */

/** `heightMm`: open at this height (otherwise Simple carve picks the largest that fits). */
export type PendingDesign = { name: string; stl: ArrayBuffer; heightMm?: number };

const DB = "cncarve-viewer";
const STORE = "pending";
const KEY = "design";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putPendingDesign(d: PendingDesign): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(d, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

let taking: Promise<PendingDesign | null> | null = null;

/**
 * Take the waiting design (if any) and remove it, so it's only loaded once. Calls made while one
 * is in progress share its answer (React may run the page's start-up code twice).
 */
export function takePendingDesign(): Promise<PendingDesign | null> {
  if (!taking) {
    taking = takeOnce();
    void taking.finally(() => setTimeout(() => (taking = null), 1000));
  }
  return taking;
}

async function takeOnce(): Promise<PendingDesign | null> {
  try {
    const db = await open();
    const d = await new Promise<PendingDesign | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      const req = st.get(KEY);
      req.onsuccess = () => {
        st.delete(KEY);
        resolve((req.result as PendingDesign | undefined) ?? null);
      };
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return d;
  } catch {
    return null;
  }
}
