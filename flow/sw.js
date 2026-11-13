const CACHE_NAME = "diec-flow-static-v2";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./flow.css",
  "./flow.js",
  "./manifest.webmanifest",
  "./diec-flow.svg",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
];
const STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/flow.css",
  "/flow.js",
  "/manifest.webmanifest",
  "/diec-flow.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("diec-flow-static-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const path = url.pathname === "/" ? "/" : url.pathname;
  if (!STATIC_PATHS.has(path)) return;

  const cachePromise = caches.open(CACHE_NAME);
  const updatePromise = cachePromise.then((cache) => fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  }));
  event.waitUntil(updatePromise.catch((error) => {
    console.warn("No se pudo actualizar el recurso estático:", error);
  }));
  event.respondWith(cachePromise.then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return updatePromise;
  }));
});
