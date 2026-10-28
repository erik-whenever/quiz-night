// Minimal service worker för att Kronan ska gå att installera som app.
// Den cachar INGENTING: alla anrop (HTML, assets, /api, websocket) går direkt till nätet,
// så en ny version syns direkt och live-quizet påverkas aldrig.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Pass-through: ingen respondWith, webbläsaren hämtar som vanligt.
});
