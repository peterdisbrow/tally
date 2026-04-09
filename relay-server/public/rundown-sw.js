/**
 * rundown-sw.js — Service Worker for offline resilience on Tally rundown views.
 *
 * Strategy:
 *   - /api/public/rundown/* GET requests: network-first, fall back to cache.
 *   - rundown-show.html / rundown-view.html / rundown-timer.html: cache-first on revisit.
 *
 * Cache is per-origin so tokens remain private to the device.
 */
const CACHE_NAME = 'tally-rundown-v1';

// Paths we actively cache for offline use
const RUNDOWN_API_PREFIX = '/api/public/rundown/';
const RUNDOWN_HTML_RE = /\/rundown-(show|view|timer)\.html(\?.*)?$/;

self.addEventListener('install', function(event) {
  // Skip waiting so the new SW takes over immediately
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  // Remove old cache versions
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
          .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // ── API rundown data: network-first, cache on success ──────────────────────
  if (url.pathname.startsWith(RUNDOWN_API_PREFIX)) {
    event.respondWith(
      fetch(req).then(function(response) {
        // Only cache successful JSON responses (not 404, 410, etc.)
        if (response.ok) {
          var cloned = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, cloned);
          });
        }
        return response;
      }).catch(function() {
        // Network failed — serve from cache
        return caches.match(req).then(function(cached) {
          return cached || new Response(
            JSON.stringify({ error: 'offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
      })
    );
    return;
  }

  // ── Rundown HTML pages: cache on first load so they work offline ───────────
  if (RUNDOWN_HTML_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return fetch(req).then(function(response) {
          if (response.ok) cache.put(req, response.clone());
          return response;
        }).catch(function() {
          return cache.match(req);
        });
      })
    );
    return;
  }
});
