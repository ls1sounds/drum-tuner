// sw.js — service worker: makes the app work offline.
//
// The first time you open the app, this saves a copy of every app file on
// the phone. After that, the app loads from that copy instantly (even with no
// signal), and quietly checks for a newer version in the background. A new
// version is used the next time you open the app.
//
// When you change the app, bump VERSION so phones fetch fresh files.

const VERSION = 'v1';
const CACHE = `drum-tuner-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/detector.js',
  './js/dom.js',
  './js/mic.js',
  './js/storage.js',
  './js/trusted.js',
  './js/tuning.js',
  './js/capture-worklet.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Delete caches from older versions.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('drum-tuner-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // SECURITY: only ever handle plain GET requests for our own files. Nothing
  // from other sites is cached or served.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;

  // Stale-while-revalidate: answer from the cache right away, refresh it in
  // the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      // Offline and not cached: for page navigations, fall back to the app.
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }),
  );
});
