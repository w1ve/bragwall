const CACHE = 'hfsignals-live-v21';
const ASSETS = [
  './',
  './index.html',
  './badge-test.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to the network for API calls
  if (url.hostname.includes('hamqth.com') ||
      url.hostname.includes('hamdb.org')  ||
      url.hostname.includes('ip-api.com') ||
      url.hostname.includes('ipapi.co')   ||
      url.hostname.includes('corsproxy.io') ||
      url.pathname === '/rbn' ||
      url.pathname === '/solar' ||
      url.pathname === '/psk' ||
      url.pathname.startsWith('/audio/') ||
      url.pathname.startsWith('/hamdb/') ||
      url.pathname.startsWith('/badge/') ||
      url.pathname.startsWith('/badges/') ||
      url.pathname.startsWith('/hfsignals/') ||
      url.pathname.startsWith('/historymap')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Cache-first for app shell
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
