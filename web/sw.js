// Offline cache: app shell (network-first so updates land) and pinned CDN
// libraries (cache-first; their URLs are versioned).
const CACHE = "parts-scanner-v1";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/parsers.js", "js/classify.js", "js/labeltext.js",
  "js/decode.js", "js/ocr.js", "js/geometry.js", "js/bom.js", "js/store.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isCdn = /(^|\.)jsdelivr\.net$/.test(url.hostname);
  if (isCdn) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  } else if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
