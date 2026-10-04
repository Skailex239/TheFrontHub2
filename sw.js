// sw.js — Service Worker for TheFrontHub (v10 — SWR partout + revalidation explicite)
//
// Strategies:
//   • /dist/*.js (minified, versioned via ?v=N)  → CACHE-FIRST, immutable (1 year)
//   • Data files (.json, .json.gz) + API GET « lecture » whitelists
//     (public-aliases, skins, banners, games-api) → STALE-WHILE-REVALIDATE RÉEL :
//     cache servi INSTANTANÉMENT (zéro écran blanc au refresh), réseau en fond.
//     Un fetch avec cache:'no-store' (ou « ?_= » dans l'URL) BYPASSE le cache
//     → réseau obligatoire + mise à jour du cache (revalidation explicite).
//   • HTML pages                                  → STALE-WHILE-REVALIDATE :
//     le refresh sert la page en cache immédiatement (plus de flash blanc/noir
//     pendant le TTFB o2switch) puis revalide en fond. Les assets versionnés
//     (?v=N) rendent ce délai d'un refresh inoffensif.
//   • Other static assets (CSS, images)          → CACHE-FIRST with network fallback
//   • Cross-origin (firebase, gstatic, openfront, corsproxy, jsdelivr) → BYPASS SW
//
// Pourquoi ce changement (v10) ?
//   Le network-first des données + HTML obligeait CHAQUE refresh à attendre le
//   réseau complet (scores.gz pèse des Mo sur o2switch) → le dashboard
//   restait vide (écran blanc en clair / noir en sombre) pendant des secondes,
//   puis montrait l'aperçu statique SANS badges, PUIS re-rendait AVEC badges
//   (« cascade »). Avec le SWR : la 1ʳᵉ peinture = rendu live complet depuis
//   le cache local, une seule fois, avec pseudos hub + badges + skins +
//   bannières. Les erreurs réseau ne sont JAMAIS mises en cache (seules les
//   réponses 200 le sont) → pas de réponses d'erreur figées.

const CACHE_NAME = 'thefronthub-v103';
const CACHE_IMMUTABLE = 'thefronthub-imm-v47';

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
  '/support.html',
  '/about.html',
  '/privacy.html',
  '/legal.html',
  '/styles.css',
  '/auth.css',
  '/profile.css',
  '/dashboard.css',
  '/lobby.css',
  '/atlas.css',
  '/support.css',
  '/tournois.css',
  '/skins.css',
  '/animations.css',
  '/toast.css',
  '/TheFrontHub LOGO WHITE TEXT.webp',
  '/cookies.js',
  // Minified JS bundles
  '/dist/app.min.js',
  '/dist/profile.min.js',
  '/dist/dashboard.min.js',
  '/dist/atlas.min.js',
  '/dist/tournois.min.js',
  '/dist/tournois-icons.min.js',
  '/dist/runs.min.js',
  '/dist/lobby.min.js',
  '/dist/lobby-wire.min.js',
  '/dist/lobby-live.min.js',
  '/dist/lobby-chat.min.js',
  '/dist/auth-ui.min.js',
  '/dist/ads.min.js',
  '/dist/i18n.min.js',
  '/dist/toast.min.js',
  '/dist/animations.min.js',
  '/dist/lenis.min.js',
  '/dist/icons.min.js',
  '/dist/auth.min.js',
  '/dist/support.min.js',
  '/dist/update-banner.min.js',
  '/dist/chat-widget.min.js',
  // Shared modules (used as ESM imports)
  '/shared/maps.js',
  // Favicons + logo
  // ⚠️ Perf (audit 2026-08-27) : '/favicon.ico' retiré — le fichier n'existe
  // pas dans le repo (404 à chaque installation du SW).
  '/favicon-32x32.png',
  '/favicon-180x180.png',
  '/TheFrontHub Logo Text.webp',
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

/* API GET « lecture » servies en SWR : UNIQUEMENT les 4 endpoints publics de
 * données cosmétiques / classement hebdo (aucune donnée de session). Les
 * variantes personnelles (?publicId=, ?codes=1, POST…) restent bypassées par
 * le SW → jamais de risque de fuite ou de réponse figée entre utilisateurs. */
const SWR_API_PATHS = [
  '/api/public-aliases.php',
  '/api/skins.php',
  '/api/banners.php',
  '/api/games-api.php',
];

function isSwrApiGet(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (SWR_API_PATHS.indexOf(p) === -1) return false;
  if (p === '/api/public-aliases.php') return url.search === ''; // liste publique, appelée bare
  if (p === '/api/skins.php' || p === '/api/banners.php') {
    return url.searchParams.get('activeMap') === '1'; // carte bulk publique uniquement
  }
  if (p === '/api/games-api.php') {
    return url.searchParams.get('route') === 'weekly'; // top hebdo public uniquement
  }
  return false;
}

/* URL normalisée pour le cache : sans le paramètre de buste « _ » (les
 * revalidations explicites « ?_=ts » doivent rafraîchir l'entrée canonique,
 * pas créer une entrée par timestamp). */
function normalizedCacheUrl(url) {
  const u = new URL(url.href);
  u.searchParams.delete('_');
  u.searchParams.delete('swrbust');
  return u.href;
}

function isCacheableResponse(resp, expectJson) {
  if (!resp || !resp.ok) return false; // JAMAIS de 4xx/5xx en cache
  if (!expectJson) return true;         // fichiers de données : ok ⇒ cacheable
  const ct = resp.headers.get('content-type') || '';
  return ct.indexOf('json') !== -1;
}

async function offlineJsonResponse() {
  return new Response(
    JSON.stringify({ error: 'Offline', message: 'Network unavailable and no cached data' }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

/* ── SWR générique (fichiers de données + API GET whitelists) ──
 * 1. cache:'no-store' ou « ?_= » → REVALIDATION EXPLICITE : réseau obligatoire,
 *    cache mis à jour sous l'URL canonique (sans « _ »). Fallback cache si
 *    le réseau est mort.
 * 2. sinon → cache servi INSTANTANÉMENT s'il existe, réseau en fond met le
 *    cache à jour pour la PROCHAINE visite. Miss → réseau. */
async function swrRespond(event, url, expectJson) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  const canonical = normalizedCacheUrl(url);
  const bypassCache = req.cache === 'no-store' || url.searchParams.has('_');

  if (bypassCache) {
    try {
      const resp = await fetch(req);
      if (isCacheableResponse(resp, expectJson)) {
        event.waitUntil(cache.put(canonical, resp.clone()));
      }
      if (resp) return resp;
    } catch (e) {
      console.warn('[SW] Revalidate network failed for', url.pathname, '— falling back to cache');
    }
    const cached = await cache.match(canonical);
    if (cached) return cached;
    return expectJson ? offlineJsonResponse() : new Response('Offline', { status: 503 });
  }

  const cached = await cache.match(canonical);
  const revalidate = fetch(req).then((resp) => {
    if (isCacheableResponse(resp, expectJson)) {
      return cache.put(canonical, resp.clone()).then(() => resp);
    }
    return resp;
  }).catch(() => null);

  if (cached) return cached; // réponse instantanée — zéro attente réseau
  const resp = await revalidate;
  if (resp) return resp;
  return expectJson ? offlineJsonResponse() : new Response('Offline', { status: 503 });
}

// ── Fetch handler ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests
  if (req.method !== 'GET') return;

  // ── API GET « lecture » whitelists → SWR (AVANT le bypass /api/) ──
  if (isSwrApiGet(url)) {
    event.respondWith(swrRespond(event, url, true));
    return;
  }

  // ── /api/* et /task/* → TOUJOURS le réseau, jamais de cache ──
  // L'API PHP (auth, profil, likes, skins en écriture) et le panel de tâches
  // (/task/, app dynamique : HTML de session + API JSON du kanban) doivent
  // être frais et ne doivent JAMAIS passer par le cache SW — sinon les
  // réponses sont figées (bug « tâches créées mais jamais affichées »).
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/api/') ||
       url.pathname === '/task' || url.pathname.startsWith('/task/'))) return;

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

  // ── Strategy 2: Data files (.json, .json.gz) → STALE-WHILE-REVALIDATE ──
  // Le cache est servi INSTANTANÉMENT (aucune attente réseau au refresh —
  // c'était la cause de l'écran blanc/noir + aperçu sans badges puis re-rendu
  // avec badges sur connexions lentes). Le réseau met le cache à jour en fond.
  // Seules les réponses 200 sont mises en cache — jamais une erreur (404/503)
  // → le vieux souci « SWR sert une erreur figée » ne peut plus arriver.
  // Les gros fallbacks (runs*.json.gz, ~16 Mo) ne sont PAS mis en cache.
  // Une revalidation explicite (cache:'no-store' ou « ?_= ») force le réseau
  // et rafraîchit l'entrée canonique (dashboard.js l'utilise après le 1ᵉʳ rendu).
  if (isDataFile(url.pathname)) {
    const isHeavyFallback =
      url.pathname.endsWith('/runs.json.gz') ||
      url.pathname.endsWith('/runs_compact.json.gz') ||
      url.pathname.endsWith('/runs.json') ||
      url.pathname.endsWith('/runs_compact.json') ||
      url.pathname.endsWith('/teams_runs.json.gz') ||
      url.pathname.endsWith('/teams_runs.json');

    if (isHeavyFallback) {
      // Réseau direct (jamais en cache SW) — fallback cache si hors ligne.
      event.respondWith(
        fetch(req).catch(() => caches.open(CACHE_NAME).then((c) => c.match(normalizedCacheUrl(url)))
          .then((cached) => cached || new Response(
            JSON.stringify({ error: 'Offline', message: 'Network unavailable and no cached data' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          )))
      );
      return;
    }

    event.respondWith(swrRespond(event, url, false)); // .json.gz = content-type gzip ⇒ pas de filtre JSON
    return;
  }

  // ── Strategy 3: HTML pages → STALE-WHILE-REVALIDATE ──
  // Le refresh sert la page depuis le cache IMMÉDIATEMENT (plus de flash
  // blanc/noir pendant le TTFB o2switch — paint holding dépassé), puis le
  // réseau revalide en fond. Après un déploiement, la page revalidée arrive
  // au refresh suivant ; les assets étant versionnés (?v=N), la page servie
  // reste toujours cohérente avec ses JS/CSS.
  if (isHtmlPage(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const key = url.pathname === '/' ? '/index.html' : url.href;
        const cached = await cache.match(key) || await cache.match(url.href) || await cache.match('/index.html');
        const revalidate = fetch(new Request(url.href, {
          method: 'GET',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          cache: 'no-store',
          credentials: 'same-origin',
        })).then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        }).catch(() => null);

        if (cached) return cached; // navigation instantanée
        const resp = await revalidate;
        if (resp) return resp;
        return caches.match('/').then((fallback) => fallback || new Response('Offline', { status: 503 }));
      })()
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
