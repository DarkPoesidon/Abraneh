const CACHE_NAME = 'cloudflare-messenger-1.6.1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/updates.js',
  '/extras.js',
  '/security.js',
  '/backup.js',
  '/calls.js',
  '/media.js',
  '/channels.js',
  '/secure.bundle.js',
  '/manifest.json',
  '/icon.svg',
  '/fonts/Vazir-Variable.woff2'
];

const SHELL_VERSION=CACHE_NAME.replace('cloudflare-messenger-','');
function updatePolicy(patch){return new Promise((resolve,reject)=>{const request=indexedDB.open('wihm-update-policy',1);request.onupgradeneeded=()=>request.result.createObjectStore('policy');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,transaction=db.transaction('policy',patch?'readwrite':'readonly'),store=transaction.objectStore('policy'),read=store.get('current');let value;read.onsuccess=()=>{value={...(read.result||{}),...(patch||{})};if(patch)store.put(value,'current');};transaction.oncomplete=()=>{db.close();resolve(value||{});};transaction.onerror=()=>{db.close();reject(transaction.error);};};});}
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const policy=await updatePolicy();
    // Refusing installation, rather than only waiting, preserves "not now" even
    // after every tab closes. A future manual approval allows the retry.
    if(policy.activeVersion&&policy.activeVersion!==SHELL_VERSION&&policy.mode!=='automatic'&&policy.approvedVersion!==SHELL_VERSION)throw new Error('Update approval required');
    const cache=await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS_TO_CACHE.map(path=>new Request(new URL(path,self.location.origin),{cache:'reload'})));
    const document=await cache.match('/');
    if(!document||(await document.text()).indexOf(`<meta name="wihm-version" content="${SHELL_VERSION}">`)===-1){await caches.delete(CACHE_NAME);throw new Error('Incomplete versioned application shell');}
    if(policy.approvedVersion===SHELL_VERSION||policy.mode==='automatic')await self.skipWaiting();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='GET_VERSION')event.ports?.[0]?.postMessage({version:SHELL_VERSION});
  if(event.data?.type==='ACTIVATE_UPDATE')event.waitUntil((async()=>{const policy=await updatePolicy();if(policy.approvedVersion===SHELL_VERSION||policy.mode==='automatic')await self.skipWaiting();})());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    updatePolicy({activeVersion:SHELL_VERSION,approvedVersion:''}).then(()=>caches.keys()).then((keys) => {
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

  // Keep the complete approved shell together until the next version is accepted.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      if(ASSETS_TO_CACHE.includes(url.pathname)){const approved=await cache.match(url.pathname);if(approved)return approved;}
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
  if(payload.kind==='call'&&(!Number.isFinite(payload.expiresAt)||payload.expiresAt<=Date.now()))return;
  event.waitUntil(self.registration.showNotification(typeof payload.title==='string'?payload.title:'پیام تازه', {
    body:typeof payload.body==='string'?payload.body:'یک پیام تازه دریافت کردید.',
    tag:payload.kind==='update'?'wihm-update':payload.kind==='call'?'call-'+chatId:'chat-'+chatId,icon:'/icon.svg',badge:'/icon.svg',dir:'rtl',lang:'fa',data:{chatId,kind:['update','secure','call'].includes(payload.kind)?payload.kind:'chat'}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();const chatId=event.notification.data?.chatId;
  if(event.notification.data?.kind==='call'){event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)if(new URL(client.url).origin===self.location.origin){await client.focus();client.postMessage({type:'incoming-call'});return;}await self.clients.openWindow('/?call=1');})());return;}
  if(event.notification.data?.kind==='secure'){event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)if(new URL(client.url).origin===self.location.origin){await client.focus();client.postMessage({type:'open-secure',threadId:chatId});return;}await self.clients.openWindow('/?secure='+encodeURIComponent(chatId||''));})());return;}
  if(event.notification.data?.kind==='update'){event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)if(new URL(client.url).origin===self.location.origin){await client.focus();client.postMessage({type:'open-updates'});return;}await self.clients.openWindow('/?updates=1');})());return;}
  if(typeof chatId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(chatId))return;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows) if(new URL(client.url).origin===self.location.origin) { await client.focus();client.postMessage({type:'open-chat',chatId});return; }
    await self.clients.openWindow('/?chat='+encodeURIComponent(chatId));
  })());
});
