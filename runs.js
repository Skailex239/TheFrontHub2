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
  return hubNameToPid[String(name).toLowerCase()] || pidByNormName[normPlayerName(name)] || null;
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
    const skinId = skinIdForPlayer(raw);
    if (skinId) a.classList.add('skin-' + skinId);
    const shown = displayNameFor(raw);
    if (shown && shown !== raw && a.textContent !== shown) {
      a.textContent = shown;
      a.title = TP("runs.ingame_title", { name: raw }, "En jeu : " + raw);
    }
  });
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

function handlePlayerClick(name) {
  // Liaison PARTOUT : tout clic sur un pseudo ouvre son profil.
  //  - publicId résolu (compte lié) → profil COMPLET ;
  //  - sinon → profil public « speedrun » (records du joueur).
  var pid = resolvePidForName(name);
  var url = 'profile.html?player=' + encodeURIComponent(name);
  if (pid) url += '&publicId=' + encodeURIComponent(pid);
  window.location.href = url;
}
window.handlePlayerClick = handlePlayerClick;

async function loadTopRuns({ limit, windowDays }) {
  const meta = $('meta');
  const status = $('status');
  const errorBox = $('errorBox');
  const tbody = $('rows');
  const generatedMeta = $('generatedMeta');

  tbody.innerHTML = '';
  errorBox.hidden = true;

  status.textContent = T("runs.loading", "Chargement\u2026");
  meta.textContent = TP("runs.meta_window", { days: windowDays, limit: limit }, "Fen\u00eatre: " + windowDays + " jours \u2022 limite: " + limit);

  const startedAt = Date.now();

  try {
    // Fetch runs.json.gz directly (same as app.js) instead of /api/top-runs
    let allRunsData;
    try {
      const ds = new DecompressionStream('gzip');
      const gzRes = await fetch('runs.json.gz', { cache: 'no-store' });
      if (!gzRes.ok) throw new Error('HTTP ' + gzRes.status);
      const decompressed = gzRes.body.pipeThrough(ds);
      allRunsData = await new Response(decompressed).json();
    } catch (gzErr) {
      // Fallback to uncompressed file
      const plainRes = await fetch('runs.json', { cache: 'no-store' });
      if (!plainRes.ok) throw new Error(T("runs.err_file", "Impossible de charger runs.json"));
      allRunsData = await plainRes.json();
    }

    // Support both formats: {runs:[], totalCount} and plain array
    const rawRuns = Array.isArray(allRunsData) ? allRunsData : (allRunsData.runs || []);

    // Filter by windowDays
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const filtered = rawRuns.filter(function(r) {
      if (!r.timestamp) return false;
      return (now - new Date(r.timestamp).getTime()) <= windowMs;
    });

    // Sort by date descending, take top 'limit'
    filtered.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    const runs = filtered.slice(0, limit);

    status.textContent = runs.length ? "" : TP("runs.none_found", { days: windowDays }, "Aucun run trouv\u00e9 dans les " + windowDays + " derniers jours.");

    const frag = document.createDocumentFragment();
    runs.forEach(function(r, idx) {
      const rank = idx + 1;

      const tr = document.createElement('tr');

      const tdRank = document.createElement('td');
      tdRank.className = 'global-rank-wrap';
      tdRank.innerHTML = makeRankBadge(rank);

      const tdPlayer = document.createElement('td');
      tdPlayer.className = 'global-player';
      // Sanitize player name: strip control chars and limit length
      var rawName = r.player || '\u2014';
      var playerName = String(rawName).replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim() || '\u2014';
      if (playerName.length > 28) playerName = playerName.slice(0, 25) + '...';
      // Skin actif du joueur (si possédé ET activé) → classe .skin-*
      var skinId = skinIdForPlayer(playerName) || '';
      var skinAttr = skinId ? ' class="skin-' + skinId + '"' : '';
      // Pseudo AFFICHÉ : pseudo hub (profil TheFrontHub) sinon pseudo en jeu.
      // data-player garde le pseudo original pour les patchs asynchrones
      // (skins / aliases) et handlePlayerClick utilise le pseudo original.
      var shownName = displayNameFor(playerName);
      var titleAttr = shownName !== playerName ? ' title="' + escapeHtml(TP("runs.ingame_title", { name: playerName }, "En jeu : " + playerName)) + '"' : '';
      tdPlayer.innerHTML = '<a' + skinAttr + ' data-player="' + escapeHtml(playerName) + '" href="#" onclick="handlePlayerClick(\'' + escapeHtml(playerName).replace(/'/g, "\\'") + "');return false\"" + titleAttr + ' style="cursor:pointer;text-decoration:none">' + escapeHtml(shownName) + '</a>';

      const tdMap = document.createElement('td');
      tdMap.innerHTML = escapeHtml(mapDisplayName(r.map));

      const tdTime = document.createElement('td');
      tdTime.innerHTML = '<span class="run-runtime">' + escapeHtml(formatTime(r.duration_s)) + '</span>';

      const tdDiff = document.createElement('td');
      tdDiff.textContent = safeText(r.difficulty) || '\u2014';

      const tdPlayers = document.createElement('td');
      tdPlayers.textContent = String(r.players != null ? r.players : '');

      const tdDate = document.createElement('td');
      tdDate.textContent = r.timestamp ? new Date(r.timestamp).toLocaleString(localeTag()) : '';

      tr.append(tdRank, tdPlayer, tdMap, tdTime, tdDiff, tdPlayers, tdDate);
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);

    const totalInFile = allRunsData.totalCount || rawRuns.length;
    const ms = Date.now() - startedAt;

    meta.textContent = "";
    generatedMeta.textContent = TP("runs.gen_meta", {
      top: runs.length,
      total: filtered.length,
      days: windowDays,
      all: totalInFile.toLocaleString(localeTag()),
      ms: ms,
    }, "Top " + runs.length + " sur " + filtered.length + " runs (" + windowDays + "j) \u2022 Total: " + totalInFile.toLocaleString("fr-FR") + " \u2022 " + ms + "ms");
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

function readControls() {
  const limit = Number($('limit') && $('limit').value ? $('limit').value : 20);
  const windowDays = Number($('windowDays') && $('windowDays').value ? $('windowDays').value : 30);

  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20,
    windowDays: Number.isFinite(windowDays) ? Math.max(1, Math.min(370, windowDays)) : 30,
  };
}

async function bootstrapRunsPage() {
  // Start loading connected usernames + skins actifs in background
  loadConnectedUsernames();
  loadActiveSkins();

  const { limit, windowDays } = readControls();
  await loadTopRuns({ limit, windowDays });

  $('refreshBtn') && $('refreshBtn').addEventListener('click', async function() {
    const v = readControls();
    await loadTopRuns(v);
  });

  ['limit', 'windowDays'].forEach(function(id) {
    $(id) && $(id).addEventListener('keydown', async function(ev) {
      if (ev.key === 'Enter') {
        const v = readControls();
        await loadTopRuns(v);
      }
    });
  });
}

bootstrapRunsPage();
