// sw.js — Service Worker for TheFrontHub (v8 — Stale-While-Revalidate)
//
// Strategies:
//   • /dist/*.js (minified, versioned via ?v=N)  → CACHE-FIRST, immutable (1 year)
//   • Data files (.json, .json.gz)              → STALE-WHILE-REVALIDATE
//   • HTML pages (/, /index.html, /profile.html, /runs.html, /dashboard.html,
//                 /lobby.html, /atlas.html, /tournois.html)
//                                                → NETWORK-FIRST with cache fallback (offline)
//   • Other static assets (CSS, images)          → CACHE-FIRST with network fallback
//   • Cross-origin (firebase, gstatic, openfront, corsproxy, jsdelivr) → BYPASS SW
//
// Why SWR for data files?
//   - User opens site → INSTANT cache response (even if stale)
//   - Network fetch in background → cache silently updated
//   - On next visit: user sees fresh data, still instantly
//   - Works even on flaky 3G

const CACHE_NAME = 'thefronthub-v41';
const CACHE_IMMUTABLE = 'thefronthub-imm-v10';
const SWR_MAX_AGE_MS = 30 * 60 * 1000;  // 30 min — consider cache fresh this long

// Static assets to pre-cache on install (HTML pages + core JS + CSS + icons)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/runs.html',
  '/profile.html',
  '/dashboard.html',
  '/lobby.html',
  '/atlas.html',
  '/tournois.html',
  '/styles.css',
  '/auth.css',
  '/profile.css',
  '/dashboard.css',
  '/lobby.css',
  '/atlas.css',
  '/tournois.css',
  '/skins.css',
  '/animations.css',
  '/toast.css',
  // Minified JS bundles
  '/dist/app.min.js',
  '/dist/profile.min.js',
  '/dist/dashboard.min.js',
  '/dist/atlas.min.js',
  '/dist/tournois.min.js',
  '/dist/tournois-icons.min.js',
  '/dist/runs.min.js',
  '/dist/i18n.min.js',
  '/dist/toast.min.js',
  '/dist/animations.min.js',
  '/dist/lenis.min.js',
  '/dist/icons.min.js',
  '/dist/auth.min.js',
  // Shared modules (used as ESM imports)
  '/shared/maps.js',
  // Favicons + logo
  // ⚠️ Perf (audit 2026-08-27) : '/favicon.ico' retiré — le fichier n'existe
  // pas dans le repo (404 à chaque installation du SW).
  '/favicon-32x32.png',
  '/favicon-180x180.png',
  '/TheFrontHub Logo Text.png',
  // ⚠️ Perf (audit 2026-08-27) : fichiers de DONNÉES retirés du précachage.
  // Raisons :
  //   1. Ils sont mis à jour toutes les 5 min par la sync → toute copie précachée
  //      est immédiatement périmée, et le handler fetch (network-first pour les
  //      données) les re-télécharge quand même → double téléchargement.
  //   2. runs_public.json.gz / teams_public.json.gz peuvent peser plusieurs Mo :
  //      les précacher ralentit la 1re visite et double la bande passante.
  //   3. runs_public.json.gz & co sont actuellement 404 (sync cassée) : chaque
  //      installation du SW spam autant de requêtes 404 inutiles.
  // Ils sont mis en cache à la demande (lazy) par la stratégie network-first.
];

// ── Install: pre-cache static assets ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use individual adds instead of addAll so one failure doesn't block everything
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Could not pre-cache:', url, err.message);
          })
        )
      );
    })
  );
  self.skipWaiting();  // activate new SW immediately on install
});

// ── Activate: clean old caches + claim clients ──────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== CACHE_IMMUTABLE)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isCrossOrigin(url) {
  // Bypass SW for all cross-origin requests — let browser handle them directly
  return (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('corsproxy.io') ||
    url.hostname.includes('allorigins.win') ||
    url.hostname.includes('openfront.io') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('jsdelivr.net')
  );
}

function isImmutableAsset(pathname) {
  // Files in /dist/ are versioned via ?v=N — treat as immutable (1y cache)
  return pathname.startsWith('/dist/');
}

function isDataFile(pathname) {
  return pathname.endsWith('.json.gz') || pathname.endsWith('.json');
}

function isHtmlPage(pathname) {
  return pathname === '/' ||
         pathname.endsWith('.html') ||
         pathname === '/index.html';
}

// ── Fetch handler ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests
  if (req.method !== 'GET') return;

  // ── /api/* → TOUJOURS le réseau, jamais de cache ──
  // L'API PHP (auth, profil, likes, skins) doit être fraîche et ne doit
  // JAMAIS être servie depuis le cache (sessions, données dynamiques).
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Skip cross-origin requests entirely (OpenFront, CDN, etc.)
  if (isCrossOrigin(url)) return;

  // ── Strategy 1: /dist/*.js → cache-first, immutable ──
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_IMMUTABLE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((response) => {
            if (response.ok) {
              cache.put(req, response.clone());
            }
            return response;
          }).catch(() => cached || new Response('Offline', { status: 503 }));
        })
      )
    );
    return;
  }

  // ── Strategy 2: Data files (.json, .json.gz) → network-first with cache fallback ──
  // CHANGED from pure SWR because SWR can serve stale error responses (404/503)
  // indefinitely if they were ever cached. Network-first ensures we always try
  // the fresh data first, and only fall back to cache if the network fails.
  // We also skip caching for the heavy "runs.json.gz" (16MB) and "runs_compact.json.gz"
  // — those are fallback files that app.js uses only when public payloads are missing.
  if (isDataFile(url.pathname)) {
    // Don't cache heavy fallback files — they're 16MB and would bloat the SW cache.
    const isHeavyFallback =
      url.pathname.endsWith('/runs.json.gz') ||
      url.pathname.endsWith('/runs_compact.json.gz') ||
      url.pathname.endsWith('/runs.json') ||
      url.pathname.endsWith('/runs_compact.json') ||
      url.pathname.endsWith('/teams_runs.json.gz') ||
      url.pathname.endsWith('/teams_runs.json');

    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        // 1. Try network first (with short timeout)
        try {
          const networkResponse = await Promise.race([
            fetch(req),
            new Promise((_, reject) => setTimeout(() => reject(new Error('SW timeout')), 8000)),
          ]);

          // Only cache successful responses (200), never errors (4xx/5xx)
          if (networkResponse && networkResponse.ok && !isHeavyFallback) {
            cache.put(req, networkResponse.clone());
          }
          if (networkResponse) return networkResponse;
        } catch (e) {
          console.warn('[SW] Network failed for', url.pathname, '— falling back to cache');
        }

        // 2. Network failed → fall back to cache
        const cached = await cache.match(req);
        if (cached) return cached;

        // 3. No cache either → return offline response
        return new Response(
          JSON.stringify({ error: 'Offline', message: 'Network unavailable and no cached data' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }
        );
      })
    );
    return;
  }

  // ── Strategy 3: HTML pages → network-first, cache fallback (offline) ──
  if (isHtmlPage(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // ── Strategy 4: Other static assets (CSS, images) → cache-first, network fallback ──
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        if (req.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── Message handler: allow page to trigger skipWaiting ──────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
