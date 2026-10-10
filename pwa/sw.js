// Pi Mobile — service worker
// Caches the app shell for install/offline and routes notification taps.

const CACHE = "pi-mobile-v26";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/md.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-96.png",
  "/icons/logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API or websocket traffic; network-first for everything dynamic.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  if (event.request.method !== "GET") return;
  // Network first, so a new version on the PC is picked up on the next load; the cache
  // is only the fallback when the PC can't be reached (or takes too long to answer).
  event.respondWith((async () => {
    try {
      const res = await Promise.race([
        fetch(event.request, { cache: "no-cache" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
      ]);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      }
      return res;
    } catch {
      return (await caches.match(event.request)) || (await caches.match("/index.html")) || Response.error();
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ openSession: sessionId });
        return client.focus();
      }
      return self.clients.openWindow("/#open=" + encodeURIComponent(sessionId || ""));
    })
  );
});
