// Cache the visited application shell and immutable assets, scoped to this app.
const CACHE_PREFIX = "db-schema-viewer-";
const CACHE_NAME = `${CACHE_PREFIX}v3-${self.registration.scope}`;
const shellUrl = self.registration.scope;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch(new Request(shellUrl, { cache: "reload" }));
    if (!response.ok) throw new Error("Application shell unavailable");
    const html = await response.clone().text();
    await cache.put(shellUrl, response);
    const assets = new Set();
    for (const match of html.matchAll(/(?:src|href)="([^"<>]+)"/g)) {
      const url = new URL(match[1].replace(/&amp;/g, "&"), shellUrl);
      if (url.origin === self.location.origin && url.pathname.includes("/_next/static/")) assets.add(url.href);
    }
    await cache.addAll([...assets]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && (!key.includes("http") || key.endsWith(self.registration.scope))).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// A worker takes its URL from the response. Turbopack starts every worker from the
// same loader and tells them apart by the URL fragment, which a cached or fetched
// response would replace with another worker's. A fresh Response has no URL, so the
// worker keeps the one it was created with.
async function asWorkerScript(response) {
  if (!response) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !url.href.startsWith(shellUrl)) return;
  if (event.request.destination === "worker") {
    event.respondWith(respond(event, url).then(asWorkerScript));
    return;
  }
  event.respondWith(respond(event, url));
});

function respond(event, url) {
  return (async () => {
    const cache = await caches.open(CACHE_NAME);
    const immutable = url.pathname.includes("/_next/static/");
    if (immutable) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === "basic") {
        const write = cache.put(event.request, response.clone()).catch(() => {});
        event.waitUntil(write);
      }
      return response;
    } catch {
      return (await cache.match(event.request))
        ?? (event.request.mode === "navigate" ? await cache.match(shellUrl) : undefined)
        ?? new Response("Offline", { status: 503 });
    }
  })();
}
