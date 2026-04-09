/**
 * rundown-sw.js — Service Worker for offline resilience on Tally rundown views.
 *
 * Strategy:
 *   - /api/public/rundown/* GET requests: network-first, fall back to cache.
 *   - rundown-show.html / rundown-view.html / rundown-timer.html: cache-first on revisit.
 *   - Static assets (CSS, JS, images): stale-while-revalidate for fast offline loading.
 *
 * Cache is per-origin so tokens remain private to the device.
 */
var CACHE_NAME = 'tally-rundown-v2';

// Paths we actively cache for offline use
var RUNDOWN_API_PREFIX = '/api/public/rundown/';
var RUNDOWN_HTML_RE = /\/rundown-(show|view|timer|equipment|multicampus)\.html(\?.*)?$/;
var STATIC_ASSET_RE = /\.(css|js|png|jpg|jpeg|svg|woff2?)(\?.*)?$/i;

self.addEventListener('install', function(event) {
  // Pre-cache critical assets for offline mode
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/portal/portal.css',
        '/portal/portal.js',
      ]).catch(function() { /* non-critical */ });
    }).then(function() {
      return self.skipWaiting();
    })
  );
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

  // ── Rundown HTML pages: network-first, cache for offline ──────────────────
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

  // ── Static assets: stale-while-revalidate for speed ───────────────────────
  if (STATIC_ASSET_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(req).then(function(cached) {
          var fetchPromise = fetch(req).then(function(response) {
            if (response.ok) cache.put(req, response.clone());
            return response;
          }).catch(function() {
            return cached;
          });
          return cached || fetchPromise;
        });
      })
    );
    return;
  }
});

// ── Listen for messages from clients for cache management ───────────────────
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CACHE_PLAN_DATA') {
    // Client can push plan data to cache for offline use
    caches.open(CACHE_NAME).then(function(cache) {
      var response = new Response(JSON.stringify(event.data.payload), {
        headers: { 'Content-Type': 'application/json' }
      });
      cache.put(event.data.url || '/api/public/rundown/_cached_plan', response);
    });
  }
});
