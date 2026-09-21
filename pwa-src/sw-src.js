/* REFERENCE COPY of the logic bundled into ../sw.js (readable version).
 * It is NOT executed and needs no build on your side — sw.js already contains
 * this code bundled with Workbox. Kept in the repo only so the caching rules
 * are documented. APP_VERSION and PRECACHE_FILES are declared at the top of sw.js.
 */
import { setCacheNameDetails, clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, NetworkOnly, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

/* Every cache we own is named logbook-<kind>-<APP_VERSION>. Bumping APP_VERSION
 * creates fresh caches and the activate step below deletes all the old ones,
 * so a stale file can never survive a release. (Google Font caches are the one
 * exception: their URLs are immutable, so they keep a fixed name.) */
setCacheNameDetails({ prefix: 'logbook', suffix: APP_VERSION });
const PAGES = `logbook-pages-${APP_VERSION}`;
const STATIC = `logbook-static-${APP_VERSION}`;

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('logbook-') && !k.startsWith('logbook-fonts-') && !k.endsWith('-' + APP_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
});
clientsClaim();
cleanupOutdatedCaches();

/* Precache: revision = APP_VERSION. The ?v=NN query strings in index.html are
 * ignored when matching, so only APP_VERSION decides what installed apps hold. */
precacheAndRoute(
  PRECACHE_FILES.map((url) => ({ url, revision: APP_VERSION })),
  { ignoreURLParametersMatching: [/^v$/, /^utm_/, /^fbclid$/] }
);

/* API / PHP: network only, never cached. (POST/PUT/DELETE are never intercepted.) */
registerRoute(
  ({ url }) => url.origin === self.location.origin && (url.pathname.includes('/api/') || url.pathname.endsWith('.php')),
  new NetworkOnly()
);

/* index.html: network-first, cached by plain path so one-time SSO links
 * (?sso_sig=…) and email deep links are never stored. */
registerRoute(
  ({ request, url }) =>
    request.mode === 'navigate' &&
    url.origin === self.location.origin &&
    (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')),
  new NetworkFirst({
    cacheName: PAGES,
    networkTimeoutSeconds: 4,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      { cacheKeyWillBeUsed: async ({ request }) => { const u = new URL(request.url); return new Request(u.origin + u.pathname); } },
    ],
  })
);

/* Google Fonts */
registerRoute(({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'logbook-fonts-css', plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })] }));
registerRoute(({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({ cacheName: 'logbook-fonts-files', plugins: [new CacheableResponsePlugin({ statuses: [0, 200] }), new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 31536000 })] }));

/* Other same-origin static files */
registerRoute(
  ({ request, url }) => url.origin === self.location.origin && ['image', 'style', 'script', 'font'].includes(request.destination),
  new StaleWhileRevalidate({ cacheName: STATIC, plugins: [new CacheableResponsePlugin({ statuses: [200] })] })
);

/* Offline fallback for failed page navigations */
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') { const p = await matchPrecache('offline.html'); if (p) return p; }
  return Response.error();
});
