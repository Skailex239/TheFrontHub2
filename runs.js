const $ = (id) => document.getElementById(id);

/* ═══ i18n (moteur global i18n.js — dictionnaire : i18n-dict-runs.js) ═══
   T(clé, fallback) : traduit via window.t, retombe sur le texte FR sinon.
   TP(clé, params, fallback) : idem avec substitution {param}. */
const T = (k, fb) => (typeof window.t === "function" ? window.t(k) : fb);
const TP = (k, params, fb) => {
  if (typeof window.t !== "function") return fb;
  const v = window.t(k, params);
  return v && v !== k ? v : fb;
};
// Locale des dates/nombres selon la langue courante (fr-FR / en-GB)
function localeTag() {
  return (typeof window !== "undefined" && window.currentLanguage === "en") ? "en-GB" : "fr-FR";
}

const connectedUsernames = new Set();

// Nom de carte affichable : passe par i18n (window.t, chargé sur toutes les
// pages) pour afficher le nom francisé ("Mer Égée", "Alpes"…) comme sur
// l'index. Retombe sur le nom brut si la clé n'existe pas ou si i18n manque.
function mapDisplayName(raw) {
  if (!raw) return '\u2014';
  const key = 'map.' + raw;
  const translated = (typeof window.t === 'function') ? window.t(key) : null;
  return (translated && translated !== key) ? translated : raw;
}

// Skins actifs (username → skinId) — nouveau système tfh_user_skins.
// Self-contained : runs.min.js est un script autonome (pas d'import ES).
// - activeSkinsByName : username exact du compte → skinId
// - activeSkinsByNorm : username normalisé → skinId (fait matcher
//   "[LBU] Skailex" ou "VarXard.9236" avec le compte du joueur)
const activeSkinsByName = new Map();
const activeSkinsByNorm = new Map();
// publicId → skinId (fix 2026-09-06 : matching direct par publicId, les
// pseudos de runs changent trop souvent — tags de clan, renommages)
const activeSkinsByPid = new Map();

// Normalise un pseudo : retire le tag de clan en préfixe et le
// discriminateur OpenFront, en minuscules.
function normPlayerName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^\[[a-z0-9_-]{2,8}\]\s*/, '')
    .replace(/\.\d{3,6}$/, '')
    .trim();
}

// Résout le skin actif d'un pseudo de run (exact puis normalisé).
function skinIdForPlayer(name) {
  if (!name) return null;
  return activeSkinsByName.get(name)
    || activeSkinsByNorm.get(normPlayerName(name))
    || null;
}

/* ── Pseudos « hub » (2026-09-03) : même pseudo partout sur le site ──
 * hubNameByPid : publicId → pseudo choisi dans le profil TheFrontHub ;
 * hubNameToPid : pseudo hub (lowercase) → publicId ;
 * pidByNormName : pseudo en jeu normalisé → publicId (map des skins actifs,
 *   champ openfrontUsername — fait matcher "[MSC] Skailex" avec son compte). */
var hubNameByPid = {};
var hubNameToPid = {};
var pidByNormName = {};

/** Résout le publicId d'un pseudo en jeu : pseudo hub exact → map skins normalisée. */
function resolvePidForName(name) {
  if (!name) return null;
  const direct = hubNameToPid[String(name).toLowerCase()] || pidByNormName[normPlayerName(name)] || null;
  if (direct) return direct;
  // Fix 2026-09-06 — renommages du type « Skailex on YT » : base normalisée
  // + suffixe commençant par un espace. Validé sur les 417k runs : 0 faux
  // positif ("fan de skailex" / "Skailex2" / "[UN] Clix skailex" NON capturés).
  const key = normPlayerName(name);
  for (const base in pidByNormName) {
    if (!base || base.length < 3 || base.indexOf(' ') !== -1) continue;
    if (key.startsWith(base) && (key.length === base.length || key.charCodeAt(base.length) === 32)) {
      return pidByNormName[base];
    }
  }
  return null;
}

/** Nom AFFICHÉ : pseudo hub (profil TheFrontHub) sinon pseudo en jeu tel quel. */
function displayNameFor(name) {
  if (!name) return name;
  var pid = resolvePidForName(name);
  return (pid && hubNameByPid[pid]) || name;
}

// Charge en 1 requête la map publique des skins actifs puis patche le
// tableau si déjà rendu (non bloquant). L'endpoint renvoie aussi
// openfrontUsername (username OpenFront actuel, résolu côté serveur —
// l'API OpenFront est CORS-restreinte) qui alimente la map normalisée
// pour matcher "[LBU] Skailex" / "VarXard.9236". Les classes .skin-*
// sont définies dans styles.css, chargé sur toutes les pages.
async function loadActiveSkins() {
  try {
    const res = await fetch('/api/skins.php?activeMap=1', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    (data.active || []).forEach(function(row) {
      if (!row.publicId || !row.skinId) return;
      activeSkinsByPid.set(String(row.publicId), row.skinId);
      if (row.username) {
        activeSkinsByName.set(row.username, row.skinId);
        activeSkinsByNorm.set(normPlayerName(row.username), row.skinId);
        pidByNormName[normPlayerName(row.username)] = String(row.publicId);
      }
      if (row.openfrontUsername) {
        activeSkinsByNorm.set(normPlayerName(row.openfrontUsername), row.skinId);
        pidByNormName[normPlayerName(row.openfrontUsername)] = String(row.publicId);
      }
    });
    applySkinsToDom();
  } catch (e) {
    /* non critique — les pseudos restent sans skin */
  }
}

// Patch DOM : skins + pseudos hub sur les lignes déjà rendues (utile quand
// la map des skins / des alias arrive APRÈS le premier rendu).
function applySkinsToDom() {
  document.querySelectorAll('td.global-player a').forEach(function(a) {
    const raw = a.getAttribute('data-player') || (a.textContent || '').trim();
    if (!raw) return;
    // Fix 2026-09-06 : le publicId du run (data-pid) est prioritaire —
    // résout pseudo hub + skin même pour les anciens pseudos du joueur.
    // v2 2026-09-08 : si le pid n'est résolu qu'APRÈS le rendu (Firebase
    // aliases / skins.php arrivent en retard — cf. bootstrapRunsPage qui ne
    // les attend pas), on REPOSA data-pid + data-pfb-pid sur l'ancre :
    // sans ça, TFHBanners.decorate ci-dessous ne trouve aucun [data-pfb-pid]
    // et la bannière pleine ligne n'est jamais peinte sur runs.html.
    var pid = a.getAttribute('data-pid');
    if (!pid) {
      pid = resolvePidForName(raw) || '';
      if (pid) {
        a.setAttribute('data-pid', pid);
        a.setAttribute('data-pfb-pid', pid);
      }
    }
    const skinId = (pid && activeSkinsByPid.get(String(pid))) || skinIdForPlayer(raw);
    if (skinId) a.classList.add('skin-' + skinId);
    const shown = (pid && hubNameByPid[String(pid)]) || displayNameFor(raw);
    if (shown && shown !== raw && a.textContent !== shown) {
      a.textContent = shown;
      a.title = TP("runs.ingame_title", { name: raw }, "En jeu : " + raw);
    }
  });
  // Bannières pixel art : (re)décore les ancres [data-pid] déjà rendues
  // (la map arrive potentiellement après le premier paint).
  if (window.TFHBanners && typeof window.TFHBanners.decorate === 'function') {
    window.TFHBanners.decorate(document);
  }
}

function formatTime(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return '\u2014';
  const m = Math.floor(durationSeconds / 60);
  const s = String(durationSeconds % 60).padStart(2, '0');
  return m + ':' + s; // format « m:ss » identique à l'index (cohérence)
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function(s) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[s];
  });
}

function safeText(x) {
  return x == null ? '' : String(x);
}

function makeRankBadge(rank) {
  const cls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  return '<span class="global-rank ' + cls + '">' + rank + '</span>';
}

// Load connected usernames from Firebase public-rewards and public-aliases
async function loadConnectedUsernames() {
  try {
    // Fix double chemin (audit 2026-08-27) : depuis dist/runs.min.js, l'import
    // relatif './dist/auth.min.js' résolvait vers /dist/dist/auth.min.js (404).
    // On essaie les deux chemins pour que ça marche depuis la racine ET dist/.
    var mod;
    try {
      mod = await import('./dist/auth.min.js');
    } catch (e1) {
      mod = await import('./auth.min.js');
    }
    var db = mod.db;
    var collection = mod.collection;
    var onSnapshot = mod.onSnapshot;

    // From public-rewards
    onSnapshot(collection(db, 'public-rewards'), function(snap) {
      snap.forEach(function(docSnap) {
        var data = docSnap.data();
        if (data.username) connectedUsernames.add(data.username);
      });
    }, function() {});

    // From public-aliases — alimenta aussi les maps pseudo hub ↔ publicId
    onSnapshot(collection(db, 'public-aliases'), function(snap) {
      snap.forEach(function(docSnap) {
        var data = docSnap.data();
        if (data.username) {
          connectedUsernames.add(data.username);
          if (data.publicId) {
            hubNameByPid[String(data.publicId)] = data.username;
            hubNameToPid[String(data.username).toLowerCase()] = String(data.publicId);
          }
        }
        // aliases[] = TOUS les noms connus du joueur (pseudo EN JEU OpenFront
        // + pseudo hub). On bridge chaque nom → publicId pour que les
        // leaderboards speedruns (clés = pseudos en jeu) affichent le
        // pseudo hub choisi dans les paramètres.
        if (data.publicId && Array.isArray(data.aliases)) {
          var pid = String(data.publicId);
          for (var i = 0; i < data.aliases.length; i++) {
            var n = data.aliases[i];
            if (!n) continue;
            connectedUsernames.add(String(n));
            hubNameToPid[String(n).toLowerCase()] = pid;
            pidByNormName[normPlayerName(String(n))] = pid;
          }
        }
      });
      applySkinsToDom();
    }, function() {});
  } catch (e) {
    console.warn('[runs] Could not load connected usernames:', e);
  }
}

function handlePlayerClick(name, pid) {
  // Liaison PARTOUT : tout clic sur un pseudo ouvre son profil.
  //  - publicId résolu (run DB ou compte lié) → profil COMPLET ;
  //  - sinon → profil public « speedrun » (records du joueur).
  var resolved = pid || resolvePidForName(name);
  var url = 'profile.html?player=' + encodeURIComponent(name);
  if (resolved) url += '&publicId=' + encodeURIComponent(resolved);
  window.location.href = url;
}
window.handlePlayerClick = handlePlayerClick;

/* ═══════════════════════════════════════════════════════════════════════
   Source de données — v4 « nouveau départ » (2026-09-23)

   1) SOURCE UNIQUE : API DB (/api/games-api.php?route=speedruns) remplie
      par api/games-sync.php (cron o2switch). Toutes les parties depuis
      l'ère V34 (2026-09-10), roster complet par publicId, speedruns
      pré-calculés (mêmes règles que l'ancienne sync, offset 32s inclus).
      → classement par TEMPS (les meilleurs temps « montent ») ou par DATE,
        filtres carte + catégorie (Normal/Compact), chargement < 100 ms.
   2) AUCUN fallback fichier : l'ancien store statique runs.json.gz
      (153 321 runs pré-publicID) ne doit JAMAIS réapparaître. API
      indisponible = état « nouvelle ère » vide, jamais les vieux records.
   ═══════════════════════════════════════════════════════════════════════ */

const GAMES_API = '/api/games-api.php';
let apiMapsAvailable = false;

function readControls() {
  const limit = Number($('limit') && $('limit').value ? $('limit').value : 20);
  const windowDays = Number($('windowDays') && $('windowDays').value ? $('windowDays').value : 30);
  const category = $('category') ? $('category').value : 'normal';
  const map = $('mapFilter') ? $('mapFilter').value : 'all';
  const sort = $('sortMode') ? $('sortMode').value : 'duration';
  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20,
    windowDays: Number.isFinite(windowDays) ? Math.max(1, Math.min(370, windowDays)) : 30,
    category: category === 'compact' ? 'compact' : 'normal',
    map: map || 'all',
    sort: sort === 'date' ? 'date' : 'duration',
  };
}

// Remplit le <select> des cartes depuis l'API (route=maps, cache serveur 10 min).
async function loadMapOptions(category, selected) {
  const sel = $('mapFilter');
  if (!sel) return;
  try {
    const res = await fetch(GAMES_API + '?route=maps&category=' + encodeURIComponent(category),
      Object.assign({ cache: 'no-store' }, (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(8000) } : {}));
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.maps) || !data.maps.length) return;
    apiMapsAvailable = true;
    const current = selected || sel.value || 'all';
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = T("runs.map_all", "Toutes les cartes");
    sel.appendChild(optAll);
    data.maps.forEach(function(m) {
      const o = document.createElement('option');
      o.value = m.map;
      o.textContent = mapDisplayName(m.map) + ' (' + m.runs + ')';
      sel.appendChild(o);
    });
    sel.value = [...sel.options].some(function(o) { return o.value === current; }) ? current : 'all';
  } catch (e) { /* API absente : pas de filtre carte */ }
}

function renderRunRow(idx, run) {
  // run normalisé : {id, name, pid, map, durationS, difficulty, players, ts}
  const rank = idx + 1;
  const tr = document.createElement('tr');
  tr.setAttribute('data-pfb-row', ''); // bannière pleine ligne (banners.js)

  const tdRank = document.createElement('td');
  tdRank.className = 'global-rank-wrap';
  tdRank.innerHTML = makeRankBadge(rank);

  const tdPlayer = document.createElement('td');
  tdPlayer.className = 'global-player';
  var rawName = run.name || '\u2014';
  var playerName = String(rawName).replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim() || '\u2014';
  if (playerName.length > 28) playerName = playerName.slice(0, 25) + '...';
  // publicId FIABLE : direct depuis la DB (ou fallback heuristique de nom
  // pour l'ancienne source statique).
  var pidForRun = run.pid || (resolvePidForName(playerName) || '');
  var skinId = (pidForRun && activeSkinsByPid.get(String(pidForRun))) || skinIdForPlayer(playerName) || '';
  var skinAttr = ' class="' + (skinId ? 'skin-' + skinId : '') + '"';
  var shownName = (pidForRun && hubNameByPid[String(pidForRun)]) || displayNameFor(playerName);
  var titleAttr = shownName !== playerName ? ' title="' + escapeHtml(TP("runs.ingame_title", { name: playerName }, "En jeu : " + playerName)) + '"' : '';
  var pidAttr = pidForRun ? ' data-pid="' + escapeHtml(String(pidForRun)) + '" data-pfb-pid="' + escapeHtml(String(pidForRun)) + '"' : '';
  var clickJs = "handlePlayerClick('" + escapeHtml(playerName).replace(/'/g, "\\'") + "'," + (pidForRun ? "'" + String(pidForRun).replace(/[^A-Za-z0-9_-]/g, '') + "'" : "null") + ");return false";
  tdPlayer.innerHTML = '<a' + skinAttr + pidAttr + ' data-player="' + escapeHtml(playerName) + '" href="#" onclick="' + clickJs + '"' + titleAttr + ' style="cursor:pointer;text-decoration:none">' + escapeHtml(shownName) + '</a>';

  const tdMap = document.createElement('td');
  tdMap.innerHTML = escapeHtml(mapDisplayName(run.map));

  const tdTime = document.createElement('td');
  tdTime.innerHTML = '<span class="run-runtime">' + escapeHtml(formatTime(run.durationS)) + '</span>';

  const tdDiff = document.createElement('td');
  tdDiff.textContent = safeText(run.difficulty) || '\u2014';

  const tdPlayers = document.createElement('td');
  tdPlayers.textContent = String(run.players != null ? run.players : '');

  const tdDate = document.createElement('td');
  tdDate.textContent = run.ts ? new Date(run.ts).toLocaleString(localeTag()) : '';

  tr.append(tdRank, tdPlayer, tdMap, tdTime, tdDiff, tdPlayers, tdDate);
  return tr;
}

async function loadTopRuns() {
  const meta = $('meta');
  const status = $('status');
  const errorBox = $('errorBox');
  const tbody = $('rows');
  const generatedMeta = $('generatedMeta');

  tbody.innerHTML = '';
  errorBox.hidden = true;
  status.textContent = T("runs.loading", "Chargement…");

  const startedAt = Date.now();
  const c = readControls();

  try {
    let runs = [];
    let source = 'db';
    let dbFresh = false; // DB connectée mais encore vide (backfill en cours)
    let filteredCount = null;
    let apiOk = true;

    // ── SOURCE UNIQUE : API DB (pré-profils). « Nouveau départ » : AUCUN
    //    fallback sur le vieux fichier statique (153 321 runs pré-publicID) —
    //    si l'API est indisponible, on affiche l'état « nouvelle ère » vide. ──
    try {
      const url = GAMES_API + '?route=speedruns'
        + '&category=' + encodeURIComponent(c.category)
        + '&map=' + encodeURIComponent(c.map)
        + '&sort=' + encodeURIComponent(c.sort)
        + '&window=' + c.windowDays + 'd'
        + '&limit=' + c.limit;
      /* Timeout 8 s : sans lui, un réseau qui hang laisse la page bloquée
         sur « Chargement… » au lieu d'afficher l'état nouvelle ère. */
      const res = await fetch(url, Object.assign({ cache: 'no-store' },
        (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(8000) } : {}));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.runs)) throw new Error('bad api payload');
      // Nouveau départ : la DB est LA source officielle. Une DB connectée mais
      // encore vide (backfill en cours) n'est PAS une raison de retomber sur
      // les anciens records fichier — état « nouvelle ère » affiché à la place.
      dbFresh = data.runs.length === 0 && !(Number(data.games_total) > 0);
      runs = data.runs.map(function(r) {
        return {
          id: r.id,
          name: (r.player && r.player.username) || '\u2014',
          pid: (r.player && r.player.publicId) || '',
          map: r.map,
          durationS: r.durationS,
          difficulty: r.difficulty,
          players: r.numPlayers,
          ts: r.startedAt,
        };
      });
      filteredCount = runs.length;
    } catch (apiErr) {
      apiOk = false;
      console.warn('[runs] API DB indisponible — état « nouvelle ère » affiché :', apiErr);
      runs = [];
      filteredCount = 0;
    }

    if (dbFresh || !apiOk) {
      status.textContent = apiOk
        ? T("runs.era_backfill", "Nouveau départ des speedruns : la base est connectée, le backfill historique est en cours — les records vont apparaître ici au fur et à mesure.")
        : T("runs.era_offline", "Nouvelle ère des speedruns (records depuis le 10 sept 2026) — l'API est momentanément indisponible, réessaie dans un instant. Les anciens records pré-publicID ne s'affichent plus.");
    } else {
      status.textContent = runs.length ? '' : TP("runs.none_found", { days: c.windowDays }, "Aucun run trouvé dans les " + c.windowDays + " derniers jours.");
    }
    meta.textContent = ''; // le « Chargement… » du header disparaît dès que le top est affiché

    const frag = document.createDocumentFragment();
    runs.forEach(function(r, idx) { frag.appendChild(renderRunRow(idx, r)); });
    tbody.appendChild(frag);
    if (window.TFHBanners && typeof window.TFHBanners.decorate === 'function') {
      window.TFHBanners.decorate(tbody);
    }

    const ms = Date.now() - startedAt;
    const srcLabel = !apiOk
      ? T("runs.src_offline", "API momentanément indisponible — nouvelle ère uniquement")
      : (dbFresh
        ? T("runs.src_era_backfill", "Nouvelle ère — DB connectée, backfill en cours")
        : T("runs.src_era", "Nouvelle ère — DB pré-profils, records depuis le 10 sept 2026"));
    const sortLabel = c.sort === 'date'
      ? T("runs.sort_date", "récentes d'abord")
      : T("runs.sort_duration", "meilleurs temps d'abord");
    generatedMeta.textContent = TP("runs.gen_meta_v2", {
      top: runs.length,
      total: filteredCount != null ? filteredCount : 0,
      days: c.windowDays,
      ms: ms,
    }, "Top " + runs.length + " sur " + (filteredCount != null ? filteredCount : '?') + " (" + c.windowDays + "j) • " + ms + "ms")
      + ' • ' + srcLabel + ' • ' + sortLabel;
  } catch (e) {
    status.textContent = '';
    const message = e && e.message ? e.message : String(e);
    errorBox.hidden = false;
    errorBox.innerHTML =
      '<div class="runs-error-title">' + escapeHtml(T("runs.error_title", "Erreur")) + '</div>' +
      '<div class="runs-error-msg">' + escapeHtml(message) + '</div>';
    meta.textContent = '';
    generatedMeta.textContent = '';
  }
}

async function bootstrapRunsPage() {
  // Start loading connected usernames + skins actifs in background
  loadConnectedUsernames();
  loadActiveSkins();

  // Paramètres d'URL (?category=compact&map=Italy&sort=date) pour deep-links
  const qp = new URLSearchParams(window.location.search);
  if (qp.get('category') && $('category')) $('category').value = qp.get('category');
  if (qp.get('sort') && $('sortMode')) $('sortMode').value = qp.get('sort');

  const c = readControls();
  await loadMapOptions(c.category, qp.get('map') || undefined);
  if (qp.get('map') && $('mapFilter')) $('mapFilter').value = qp.get('map');

  await loadTopRuns();

  $('refreshBtn') && $('refreshBtn').addEventListener('click', async function() {
    await loadTopRuns();
  });

  ['limit', 'windowDays', 'category', 'mapFilter', 'sortMode'].forEach(function(id) {
    $(id) && $(id).addEventListener('change', async function() {
      // La liste des cartes dépend de la catégorie
      if (id === 'category') await loadMapOptions($('category').value);
      await loadTopRuns();
    });
    $(id) && $(id).addEventListener('keydown', async function(ev) {
      if (ev.key === 'Enter') {
        await loadTopRuns();
      }
    });
  });
}

bootstrapRunsPage();
