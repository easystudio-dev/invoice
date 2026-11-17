// Offline support. Network first, so a new deploy shows up on the next load;
// the cache is only the fallback when there's no connection.
const CACHE = 'invoice-v5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'lib.js', 'folder.js', 'storage.js', 'vendor/qrcode.js', 'fonts/anton-latin.woff2', 'fonts/anton-latin-ext.woff2', 'fonts/instrument-sans-latin.woff2', 'fonts/instrument-sans-latin-ext.woff2', 'favicon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
