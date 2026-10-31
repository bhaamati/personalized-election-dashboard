'use strict';

/*
 * Service worker: caches this site's static files for offline access.
 * It never intercepts civicAPI requests. Live results still require internet.
 *
 * The cache name changes when we add assets (CSS/JS) to the app shell, so
 * previously installed versions pick up the complete three-file app.
 */
const CACHE = 'election-dashboard-shell-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-sync.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

// First installation: save all the files needed to display the app offline.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Remove superseded versions of our own shell cache.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('election-dashboard-shell-') && key !== CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// Network first, cached response as fallback, only for same-origin GET requests.
self.addEventListener('fetch', event => {
  const request = event.request;

  // Never handle civicAPI or other cross-origin resources.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const home = await caches.match(new URL('./index.html', self.registration.scope));
        if (home) return home;
      }
      return Response.error();
    })
  );
});
