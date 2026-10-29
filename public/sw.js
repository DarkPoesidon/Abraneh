const CACHE_NAME = 'cloudflare-messenger-1.2.3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/fonts/Vazir-Variable.woff2'
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

self.addEventListener('push', event => {
  let payload={}; try { payload=event.data?.json()||{}; } catch { /* Show a generic notification for malformed payloads. */ }
  const chatId=typeof payload.chatId==='string'&&/^[a-zA-Z0-9_-]+$/.test(payload.chatId)?payload.chatId:'';
  event.waitUntil(self.registration.showNotification(typeof payload.title==='string'?payload.title:'پیام تازه', {
    body:typeof payload.body==='string'?payload.body:'یک پیام تازه دریافت کردید.',
    tag:'chat-'+chatId,icon:'/icon.svg',badge:'/icon.svg',dir:'rtl',lang:'fa',data:{chatId}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();const chatId=event.notification.data?.chatId;
  if(typeof chatId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(chatId))return;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows) if(new URL(client.url).origin===self.location.origin) { await client.focus();client.postMessage({type:'open-chat',chatId});return; }
    await self.clients.openWindow('/?chat='+encodeURIComponent(chatId));
  })());
});
