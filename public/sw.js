const CACHE_NAME = 'cloudflare-messenger-1.1.0';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('cloudflare-messenger-')) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Do not cache API or WebSocket requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Fetch the current shell when online; keep a complete offline copy for reconnects.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request);
        if (response.ok && ASSETS_TO_CACHE.includes(url.pathname)) await cache.put(event.request, response.clone());
        if (response.ok) return response;
        return await cache.match(event.request) || response;
      } catch {
        return await cache.match(event.request) || new Response('اتصال اینترنت برقرار نیست.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })()
  );
});
