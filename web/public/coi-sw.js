// Tombstone — self-unregisters the old cross-origin isolation service worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.registration.unregister());
