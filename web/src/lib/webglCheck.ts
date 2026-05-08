/**
 * Quick probe so we can avoid spamming Kiri with postMessage when WebGL is dead — Kiri’s CAM
 * requires WebGL; without it the app throws (e.g. “reading 'X' of undefined”) and import fails noisily.
 */
export function isWebGlLikelyAvailable(): boolean {
  if (typeof document === "undefined") return true;
  try {
    const c = document.createElement("canvas");
    const gl =
      c.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ??
      c.getContext("experimental-webgl" as "webgl", {
        failIfMajorPerformanceCaveat: false,
      });
    return !!gl;
  } catch {
    return false;
  }
}
