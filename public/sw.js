// sw.js — Service Worker for TheFrontHub offline support
const CACHE_NAME = 'thefrontstats-v5';
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Static assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/runs.html',
  '/profile.html',
  '/styles.css',
  '/auth.css',
  '/profile.css',
  '/animations.css',
  '/app.js',
  '/auth.js',
  '/runs.js',
  '/profile.js',
  '/i18n.js',
  '/animations.js',
  '/openfront-client.js',
  '/openfront-parse.js',
  '/toast.js',
  '/toast.css',
  '/shared/maps.js',
  '/shared/firebase-config.js',
  '/favicon.ico',
  // Optimized public data files (small, cacheable)
  '/runs_public.json.gz',
  '/runs_compact_public.json.gz',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Failed to cache some assets:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches + claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-first for ALL files (no more cache-first stale assets)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip Firebase and CORS proxy requests
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('corsproxy.io') ||
      url.hostname.includes('allorigins.win') ||
      url.hostname.includes('openfront.io')) {
    return;
  }

  // Network-first for everything: always try to get the latest version,
  // fall back to cache only if network fails (offline).
  event.respondWith(
    fetch(event.request).then((response) => {
      // Only cache successful responses
      if (response.ok || response.type === 'opaque') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      // Network failed — serve from cache if available
      return caches.match(event.request).then((cached) => cached || new Response('Offline', { status: 503 }));
    })
  );
});
