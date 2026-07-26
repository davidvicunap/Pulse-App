/**
 * Pulse service worker.
 *
 * Offline-first, because the app's entire value proposition is that it works without a
 * server. The strategy is deliberately simple — the whole app shell is precached at
 * install, then served cache-first — which is correct here because:
 *
 *   - The shell is small (a few hundred KB including fonts).
 *   - It is fully static; there is no dynamic content to go stale.
 *   - Every asset filename is content-hashed by the build, so a new deploy produces a
 *     new cache and the old one is dropped wholesale.
 *
 * The two placeholders below are replaced at build time by the Vite plugin in
 * `vite.config.ts`.
 */

const CACHE = __CACHE_VERSION__;
const PRECACHE = __PRECACHE_MANIFEST__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually rather than addAll, so one missing optional asset (an icon that
      // wasn't generated, say) can't fail the entire installation.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      // Take over immediately: a user who just installed to their home screen should
      // get a working offline app on the very next launch, not the one after.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch cross-origin requests. In practice that means the opt-in AI call to
  // the Anthropic API, which must always go to the network and must never be cached.
  if (url.origin !== self.location.origin) return;

  // Navigations resolve to the app shell, so a deep link or a cold offline launch
  // still boots the app rather than showing the browser's offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        // Resolve against the worker's own scope so this works under a subdirectory.
        const shell = new URL('./index.html', self.registration.scope).href;
        const cached = (await cache.match(shell)) || (await cache.match(self.registration.scope));
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Pulse</title>' +
              '<body style="background:#070a10;color:#eceff6;font-family:system-ui;padding:40px">' +
              '<h1 style="color:#5eead4">Pulse is offline</h1>' +
              '<p>Reopen the app once you have been online at least once.</p>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      // Two-stage lookup. The strict match is tried first, then a match that ignores
      // `Vary`. Fonts are the reason: a `<link rel=preload as=font crossorigin>` is a
      // CORS request, and if the server varies its response the strict match misses an
      // entry that is sitting right there in the cache — which offline means a silent
      // fallback to a system font.
      const cached =
        (await cache.match(request)) ||
        (await cache.match(request.url, { ignoreVary: true, ignoreSearch: false }));
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Cache successful same-origin responses so assets loaded lazily (a chunk, a
        // font variant) survive into the next offline session.
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        // Offline with nothing cached. Return an explicit error rather than throwing,
        // so the failure is a clean 504 instead of an opaque worker exception.
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      }
    })(),
  );
});
