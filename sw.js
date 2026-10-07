/* LOGBOOK service worker — no build step, no dependencies.
 *
 * EVERY RELEASE: change APP_VERSION. That makes installed apps fetch the new files,
 * shows "Update available", and removes every older cache.
 *
 * All paths are relative to this file, so the app works unchanged at a domain root
 * or under a GitHub Pages repository path (https://<user>.github.io/<repo>/).
 */
const APP_VERSION = '3.3.0';

const SHELL_CACHE = `logbook-shell-${APP_VERSION}`;
const RUNTIME_CACHE = `logbook-runtime-${APP_VERSION}`;

const SHELL_FILES = [
  './',
  'index.html',
  'offline.html',
  'manifest.json',
  'assets/css/style.css',
  'assets/js/config.js',
  'assets/js/seed-data.js',
  'assets/js/store.js',
  'assets/js/app.js',
  'assets/js/import-excel.js',
  'assets/js/pwa.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/favicon-32.png',
  'assets/icons/apple-touch-icon.png',
  'assets/fonts/fraunces-latin-500-normal.woff2',
  'assets/fonts/fraunces-latin-600-normal.woff2',
  'assets/fonts/fraunces-latin-700-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-400-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-600-normal.woff2',
  'assets/fonts/ibm-plex-sans-latin-700-normal.woff2',
  'assets/fonts/ibm-plex-mono-latin-500-normal.woff2'
];

const scopeUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_FILES.map((f) => new Request(scopeUrl(f), { cache: 'reload' })))
    )
  );
  // No skipWaiting here: the page decides when to switch (see assets/js/pwa.js).
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('logbook-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const network = fetch(request).then(async (response) => {
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

/* Page loads: fresh copy when online (quickly), cached app when not. Query strings
 * (?tab=…, ?empAction=…) all map to the one cached index.html. */
async function handleNavigation(request) {
  const indexUrl = scopeUrl('index.html');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(indexUrl, response.clone());
      return response;
    }
    throw new Error('bad status');
  } catch (err) {
    return (await caches.match(indexUrl)) || (await caches.match(scopeUrl('./'))) ||
           (await caches.match(scopeUrl('offline.html'))) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
    const scopePath = new URL(self.registration.scope).pathname;
    if (url.pathname === scopePath || url.pathname === scopePath + 'index.html') {
      event.respondWith(handleNavigation(request));
    } else {
      // Any other address under the app (offline.html, or a mistyped link that GitHub Pages
      // answers with 404.html): straight from the network, offline page if there is none.
      event.respondWith(fetch(request).catch(async () =>
        (await caches.match(request)) || (await caches.match(scopeUrl('offline.html'))) || Response.error()));
    }
    return;
  }
  if (url.origin === self.location.origin && url.href.startsWith(self.registration.scope)) {
    if (url.searchParams.has('ping')) return;                       // connectivity probe from pwa.js: always hits the network
    // The Excel reader is large and never changes: fetch once, then always from cache.
    if (url.pathname.includes('/assets/vendor/') || url.pathname.includes('/assets/splash/')) {
      event.respondWith(cacheFirst(request, RUNTIME_CACHE));
      return;
    }
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});
