/**
 * profile.js — Profile page logic for TheFrontHub.
 *
 * Flow:
 *   onAuthStateChanged →
 *     • no user                       → show #profile-gate
 *     • user, no Firestore profile    → show #profile-setup (ownership verification)
 *     • user, profile with publicId   → fetch OpenFront stats → show #profile-main
 *
 * Stats are fetched from `https://api.openfront.io/public/player/{publicId}` via
 * fetchOpenFront (handles CORS proxy). ELO is read from local `ranked.json`.
 * Recent games (last 5) get an additional `/public/game/{gameId}` fetch to
 * determine win/loss based on the `winner` array (clientIDs of winners).
 */

import {
  auth, db, doc, getDoc, setDoc,
  collection, onSnapshot,
  onAuthStateChanged,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=24";

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;

// VIP skin: publicId → rewardType (matching par PUBLIC ID, pas par alias)
let vipPlayersByPid = new Map();
let _vipUnsub = null;
const NEW_SKIN_TYPES = ['cyberpunk','sunset','aurore','pastel','gold','volcano','ocean','miami','toxic','chroma','prism'];

/**
 * Écoute public-rewards et construit la map publicId → rewardType.
 * Le skin suit le PUBLIC ID (identité stable) plutôt que l'alias (changeant).
 * On lit data.publicId directement; en fallback on essaie data.username contre
 * le username du profil courant.
 */
function loadVipForProfile() {
  if (_vipUnsub) return; // déjà abonné
  try {
    _vipUnsub = onSnapshot(collection(db, "public-rewards"), (snap) => {
      vipPlayersByPid = new Map();
      // fallback: username → rewardType (pour les docs sans publicId direct)
      const usernameToType = new Map();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const rewardType = data.activeType || data.type || null;
        if (!rewardType || data.activated === false) return;
        if (data.publicId) vipPlayersByPid.set(String(data.publicId), rewardType);
        if (data.username) usernameToType.set(data.username, rewardType);
      });
      // Re-applique le skin sur le hero si on a un profil
      // En mode visualisation publique, on utilise le profil virtuel du joueur consulté
      // (son publicId) plutôt que le profil propre de l'utilisateur courant.
      if (viewingPublicId) {
        applyProfileSkin({ username: viewingUsername, publicId: viewingPublicId }, usernameToType);
      } else if (currentProfile) {
        applyProfileSkin(currentProfile, usernameToType);
      }
    }, (err) => {
      console.warn("[profile] VIP listener error (non-critique):", err.message);
    });
  } catch (e) {
    console.warn("[profile] loadVipForProfile error:", e);
  }
}

/**
 * Applique le skin VIP sur le pseudo du hero, résolu via publicId (prioritaire)
 * puis fallback username.
 */
function applyProfileSkin(profile, usernameToTypeFallback) {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;
  const pid = profile?.publicId;
  const rewardType = (pid && vipPlayersByPid.get(pid))
    || (profile?.username && usernameToTypeFallback?.get(profile.username))
    || null;
  if (rewardType && NEW_SKIN_TYPES.includes(rewardType)) {
    nameEl.className = `rgb-${rewardType}`;
  } else if (rewardType) {
    nameEl.className = `player-${rewardType}`;
  } else {
    nameEl.className = "";
  }
}

/* ── Helpers ── */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

function showView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-active", id === view);
  });
}

function formatDateShort(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function setStat(id, value, muted = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null ? "—" : String(value);
  el.classList.toggle("muted", muted);
}

/* ── Auth state ── */

// Public profile view state (set when URL contains ?publicId=XXX)
let viewingPublicId = null;
let viewingUsername = null;

/**
 * Détecte si l'URL demande de visualiser le profil PUBLIC d'un autre joueur.
 * Format: profile.html?player=NAME&publicId=XXXXXXXX
 * Si le publicId correspond à celui de l'utilisateur courant, on ignore
 * (c'est son propre profil — flux normal).
 */
function getPublicProfileRequest() {
  const params = new URLSearchParams(window.location.search);
  const pid = (params.get("publicId") || params.get("pid") || "").trim();
  const name = (params.get("player") || "").trim();
  if (pid && /^[A-Za-z0-9]{8}$/.test(pid)) {
    return { publicId: pid, username: name || pid };
  }
  return null;
}

onAuthStateChanged(auth, async (user) => {
  // ── Cas 1 : visualisation du profil public d'un autre joueur ──
  // On vérifie l'URL AVANT toute logique d'auth, car cela doit fonctionner
  // même si l'utilisateur n'est pas connecté.
  const pubReq = getPublicProfileRequest();
  if (pubReq) {
    // Lecture du propre profil de l'utilisateur courant (s'il est connecté)
    // pour détecter s'il visualise son PROPRE profil → flux normal.
    let ownProfile = null;
    if (user) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) ownProfile = snap.data();
      } catch (e) {
        console.warn("[profile] Firestore read error (own, non-bloquant):", e.message);
      }
    }

    if (ownProfile && ownProfile.publicId === pubReq.publicId) {
      // L'utilisateur visualise son propre profil → flux normal (on nettoie l'URL)
      history.replaceState(null, "", window.location.pathname);
      currentUser = user;
      currentProfile = ownProfile;
      updateSidebarUI(user, ownProfile);
      showView("profile-main");
      renderHero(user, ownProfile);
      loadVipForProfile();
      await loadStats(ownProfile.publicId);
      return;
    }

    // ── Profil d'un AUTRE joueur (ou visiteur non connecté) ──
    currentUser = user; // peut être null
    currentProfile = ownProfile; // pour la sidebar (peut être null)
    updateSidebarUI(user, ownProfile);
    viewingPublicId = pubReq.publicId;
    viewingUsername = pubReq.username;
    showView("profile-main");
    renderPublicProfile(pubReq.username, pubReq.publicId);
    loadVipForProfile();
    await loadStats(pubReq.publicId);
    return;
  }

  // ── Cas 2 : pas de ?publicId dans l'URL → flux normal ──
  if (!user) {
    currentUser = null;
    currentProfile = null;
    updateSidebarUI(null);
    showView("profile-gate");
    return;
  }

  currentUser = user;

  // Read Firestore profile
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.error("[profile] Firestore read error:", e);
    showToast("Erreur de lecture du profil (Firestore).", "error");
  }

  currentProfile = profile;
  updateSidebarUI(user, profile);

  if (!profile || !profile.publicId) {
    // New user → setup form
    showView("profile-setup");
    return;
  }

  // Returning user with publicId → fetch & display stats
  showView("profile-main");
  renderHero(user, profile);
  // Lance l'écoute VIP (skin par publicId) — re-applique le skin dès que les rewards arrivent
  loadVipForProfile();
  await loadStats(profile.publicId);
});

/**
 * Affiche le profil PUBLIC d'un autre joueur (ou le sien propre si visité via URL).
 * Masque le bouton de déconnexion, neutralise les actions d'édition, et applique
 * le skin VIP résolu via publicId.
 */
function renderPublicProfile(username, publicId) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) nameEl.textContent = username;

  const badgeEl = document.getElementById("profile-public-badge");
  if (badgeEl) badgeEl.textContent = "Public ID : " + publicId;

  // Affiche la bannière "Profil public" + bouton retour
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "flex";

  // Masque le bouton de déconnexion (ce n'est pas notre session)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "none";

  // Avatar : fallback PDP.png (on n'a pas l'avatar du joueur distant)
  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    avatarEl.innerHTML = `<img src="PDP.png" alt="${esc(username)}" style="width:100%;height:100%;object-fit:cover">`;
  }

  // Construit un pseudo-profil pour que applyProfileSkin résolve le skin VIP
  // via le publicId du joueur visualisé (et non celui de l'utilisateur courant).
  const virtualProfile = { username, publicId };
  applyProfileSkin(virtualProfile, null);
}

/* ── Sidebar / dropdown UI ── */

function updateSidebarUI(user, profile) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!user) {
    if (loginBtn) loginBtn.style.display = "flex";
    if (userContainer) { userContainer.style.display = "none"; userContainer.classList.remove("open"); }
    return;
  }
  if (loginBtn) loginBtn.style.display = "none";
  if (userContainer) userContainer.style.display = "block";

  const name = profile?.username || user.displayName || user.email || "Joueur";
  const publicId = profile?.publicId || "Non lié";

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("user-display-name", name);
  setText("user-public-id-side", publicId !== "Non lié" ? publicId : "En ligne");
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${esc(user.photoURL)}" alt="${esc(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = (name || "U").substring(0, 2).toUpperCase();
      avatarEl.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
    }
  }
}

/* ── Main view: hero ── */

function renderHero(user, profile) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) nameEl.textContent = profile.username || user.displayName || "Joueur";

  const badgeEl = document.getElementById("profile-public-badge");
  if (badgeEl) badgeEl.textContent = "Public ID: " + (profile.publicId || "—");

  // Masque la bannière "Profil public" (flux normal = propre profil)
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "none";

  // Ré-affiche le bouton de déconnexion (flux normal)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "";

  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    // Use PDP.png as the avatar image (instead of default letter)
    avatarEl.innerHTML = `<img src="PDP.png" alt="${esc(profile.username || 'avatar')}" style="width:100%;height:100%;object-fit:cover">`;
  }

  // Applique le skin VIP résolu par publicId (le listener VIP re-appliquera quand
  // les rewards arriveront). Fallback username = null ici car pas encore chargé.
  applyProfileSkin(profile, null);
}

/* ── Main view: load stats ── */

async function loadStats(publicId) {
  // Reset stats list to loading
  setText("stat-week-rank", "This week rank: …");
  setText("stat-week-score", "This week score: …");
  setText("stat-alltime", "All-time score: …");
  const recentEl = document.getElementById("profile-recent-games");
  if (recentEl) recentEl.innerHTML = `<div class="pf-empty">Chargement…</div>`;
  hideError();

  // Kick off ELO lookup (ranked.json) in parallel
  const eloPromise = getRankedEntry(publicId);

  // Kick off recent games fetch in parallel (separate endpoint)
  // /public/player/{id} returns aggregated stats only (no games array).
  // /public/player/{id}/games returns the actual recent games list with
  // result (victory/defeat) already included — no need for per-game fetch.
  const recentGamesPromise = fetchRecentGames(publicId);
  // Supprime la rejection non-gérée si on retourne avant (publicId invalide).
  recentGamesPromise.catch(() => {});

  let playerData;
  try {
    playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
  } catch (e) {
    console.error("[profile] OpenFront API error:", e);
    if (e?.isNotFound || e?.status === 404) {
      showError(
        `Joueur introuvable sur l'API OpenFront (publicId : ${publicId}). ` +
        `Vérifie que ton identifiant OpenFront est correct dans tes paramètres de profil.`
      );
    } else {
      showError(`Impossible de charger les statistiques depuis l'API OpenFront.`);
    }
    setText("stat-week-rank", "This week rank: —");
    setText("stat-week-score", "This week score: —");
    setText("stat-alltime", "All-time score: —");
    const c = document.getElementById("profile-recent-games");
    if (c) c.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
    return;
  }

  if (!playerData) {
    showError("Réponse vide de l'API OpenFront.");
    return;
  }

  // NOTE: /public/player/{id} no longer returns a `games` array.
  // Recent games come from the separate /games endpoint (recentGamesPromise).
  const games = [];
  const stats = computeStats(games, playerData.stats || {});

  // ── Week stats from dashboard_scores.json (official data) ──
  let weekScore = 0, weekRank = "—", weekFFA = 0, weekTeam = 0, weekTotalPoints = 0;
  try {
    const scoresRes = await fetch("dashboard_scores.json.gz", { cache: "force-cache" });
    let scoresData = null;
    if (scoresRes.ok) {
      const ds = new DecompressionStream("gzip");
      scoresData = await new Response(scoresRes.body.pipeThrough(ds)).json();
    } else {
      const fallback = await fetch("dashboard_scores.json");
      if (fallback.ok) scoresData = await fallback.json();
    }
    if (scoresData && scoresData.players) {
      const entry = scoresData.players.find(p => p.publicId === publicId);
      if (entry) {
        weekFFA = (entry.weekly_ffa_casual || 0) + (entry.weekly_ffa_ranked || 0);
        weekTeam = (entry.weekly_team_casual || 0) + (entry.weekly_team_ranked || 0);
        weekScore = entry.weekly_points || 0;
        weekTotalPoints = entry.points || 0;
        // Compute rank: position in the sorted weekly leaderboard
        const weeklySorted = [...scoresData.players].sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0));
        const rankIdx = weeklySorted.findIndex(p => p.publicId === publicId);
        weekRank = rankIdx >= 0 ? rankIdx + 1 : "—";

        // Store for the chart
        window._profileWeekData = {
          ffa: weekFFA,
          team: weekTeam,
          total: weekScore,
          rank: weekRank,
          weekStart: scoresData.weekStart,
          // Detailed breakdown for tooltip
          ffaCasual: entry.weekly_ffa_casual || 0,
          ffaRanked: entry.weekly_ffa_ranked || 0,
          teamCasual: entry.weekly_team_casual || 0,
          teamRanked: entry.weekly_team_ranked || 0,
          allTimePoints: entry.points || 0,
          allTimeFfa: entry.ffa_casual || 0,
          allTimeTeam: entry.team_casual || 0,
        };
      }
    }
  } catch (e) {
    console.warn("[profile] Week stats load failed:", e.message);
  }

  // All-time score
  const allTimeScore = stats.wins * 4 + (stats.total - stats.wins);

  // Breakdown by mode
  const breakdown = computeModeBreakdown(playerData.stats || {});
  const detail = [];
  if (breakdown.FFA) detail.push("FFA: " + breakdown.FFA);
  if (breakdown.Team) detail.push("Team: " + breakdown.Team);
  if (breakdown.Duos) detail.push("Duos: " + breakdown.Duos);
  if (breakdown.Trios) detail.push("Trios: " + breakdown.Trios);
  if (breakdown.Quads) detail.push("Quads: " + breakdown.Quads);
  const detailStr = detail.length ? " (" + detail.join(", ") + ")" : "";

  setText("stat-week-rank", `This week rank: #${weekRank}`);
  setText("stat-week-score", `This week score: ${weekScore} pts (FFA: ${weekFFA} · Team: ${weekTeam})`);
  setText("stat-alltime", `All-time score: ${weekTotalPoints || allTimeScore} (${stats.wins} wins${detailStr})`);

  // ELO from ranked.json (1v1)
  const ranked1v1 = await eloPromise;
  const eloLine = document.getElementById("stat-elo-line");
  if (eloLine) {
    if (ranked1v1 && ranked1v1.elo != null) {
      eloLine.textContent = `ELO 1v1: ${ranked1v1.elo} (Peak: ${ranked1v1.peakElo ?? '—'}) — Rank #${ranked1v1.rank}`;
      eloLine.style.display = "list-item";
    } else {
      eloLine.style.display = "none";
    }
  }
  
  // ELO 2v2 from ranked.json
  const ranked2v2 = await getRankedEntry(publicId, "2v2");
  const elo2v2Line = document.getElementById("stat-elo-2v2-line");
  if (elo2v2Line) {
    if (ranked2v2 && ranked2v2.elo != null) {
      elo2v2Line.textContent = `ELO 2v2: ${ranked2v2.elo} (Peak: ${ranked2v2.peakElo ?? '—'}) — Rank #${ranked2v2.rank}`;
      elo2v2Line.style.display = "list-item";
    } else {
      elo2v2Line.style.display = "none";
    }
  }

  // Recent games — fetched from /public/player/{id}/games (separate endpoint).
  // The result field (victory/defeat) is already included, no per-game fetch needed.
  try {
    const recentGames = await recentGamesPromise;
    renderRecentGames(recentGames, publicId);
    renderWeeklyChart();
  } catch (e) {
    console.error("[profile] recent games fetch failed:", e);
    const c = document.getElementById("profile-recent-games");
    if (c) c.innerHTML = `<div class="pf-empty">Impossible de charger les parties récentes.</div>`;
  }
}

/**
 * Fetch recent games for a player from the /public/player/{id}/games endpoint.
 * Returns up to 10 games with result (victory/defeat) already included.
 * Supports cursor pagination to fetch more if needed.
 */
async function fetchRecentGames(publicId, maxPages = 1) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/public/player/${encodeURIComponent(publicId)}/games` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const data = await fetchOpenFront(url);
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    cursor = data?.nextCursor;
    if (!cursor || results.length === 0) break;
  }
  return all;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function computeModeBreakdown(statsTree) {
  const out = { FFA: 0, Team: 0, Duos: 0, Trios: 0, Quads: 0 };
  if (!statsTree || typeof statsTree !== "object") return out;
  for (const catKey of Object.keys(statsTree)) {
    const cat = statsTree[catKey];
    if (!cat || typeof cat !== "object") continue;
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;
      let wins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) {
          wins += parseInt(diff.wins, 10) || 0;
        }
      }
      if (modeKey === "Free For All") out.FFA += wins;
      else if (modeKey === "Team") {
        // Try to break down by playerTeams if available
        out.Team += wins;
      }
    }
  }
  return out;
}

function computeStats(games, statsTree) {
  // Wins: sum all "wins" fields across the stats tree (Private/Public/Ranked → mode → difficulty)
  let wins = 0;
  let total = 0;
  if (statsTree && typeof statsTree === "object") {
    for (const catKey of Object.keys(statsTree)) {
      const cat = statsTree[catKey];
      if (!cat || typeof cat !== "object") continue;
      for (const modeKey of Object.keys(cat)) {
        const mode = cat[modeKey];
        if (!mode || typeof mode !== "object") continue;
        for (const diffKey of Object.keys(mode)) {
          const diff = mode[diffKey];
          if (!diff || typeof diff !== "object") continue;
          if (diff.wins != null) wins += parseInt(diff.wins, 10) || 0;
          if (diff.total != null) total += parseInt(diff.total, 10) || 0;
          else if (diff.wins != null && diff.losses != null) {
            total += (parseInt(diff.wins, 10) || 0) + (parseInt(diff.losses, 10) || 0);
          }
        }
      }
    }
  }

  // Fallback: if stats tree has no totals, use games.length
  if (total === 0 && games.length > 0) total = games.length;

  // Unique maps + favourite map
  const mapCounts = {};
  let lastGame = null;
  for (const g of games) {
    if (g.map) mapCounts[g.map] = (mapCounts[g.map] || 0) + 1;
    if (g.start) {
      const d = new Date(g.start).getTime();
      if (!isNaN(d) && (lastGame === null || d > lastGame)) lastGame = d;
    }
  }
  const uniqueMaps = Object.keys(mapCounts).length;
  let favMap = null;
  let favCount = 0;
  for (const [m, c] of Object.entries(mapCounts)) {
    if (c > favCount) { favMap = m; favCount = c; }
  }
  const lastGameIso = lastGame ? new Date(lastGame).toISOString() : null;

  return { wins, total, uniqueMaps, favMap, lastGame: lastGameIso };
}

async function getRankedEntry(publicId, mode = "1v1") {
  if (_rankedCache === null) {
    try {
      const res = await fetch("ranked.json", { cache: "no-store" });
      if (res.ok) _rankedCache = await res.json();
      else _rankedCache = {};
    } catch (e) {
      console.warn("[profile] ranked.json load failed:", e);
      _rankedCache = {};
    }
  }
  const list = (_rankedCache && Array.isArray(_rankedCache[mode])) ? _rankedCache[mode] : [];
  return list.find((p) => p && p.public_id === publicId) || null;
}

function showError(msg) {
  const el = document.getElementById("profile-api-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("profile-api-error");
  if (el) el.style.display = "none";
}

/* ── Recent games ── */

/**
 * Render recent games from /public/player/{id}/games endpoint.
 * Each game already includes a `result` field ("victory" | "defeat" | other)
 * so no per-game fetch is needed.
 *
 * Game object structure:
 *   { gameId, start, durationSeconds, map, mode, type, playerTeams,
 *     rankedType, result, totalPlayers, username, clanTag }
 */
function renderRecentGames(games, publicId) {
  const container = document.getElementById("profile-recent-games");
  if (!container) return;

  // Sort by start date desc, take last 10 (API returns 10 per page)
  const sorted = games
    .slice()
    .sort((a, b) => new Date(b.start || 0).getTime() - new Date(a.start || 0).getTime())
    .slice(0, 10);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
    return;
  }

  container.innerHTML = sorted.map((g) => {
    const isWin = g.result === "victory";
    const resultClass = isWin ? "win" : "loss";
    const resultLabel = isWin ? "VICTOIRE" : (g.result === "defeat" ? "DÉFAITE" : (g.result || "—"));
    const duration = g.durationSeconds ? formatDuration(g.durationSeconds) : "—";
    const modeLabel = formatGameMode(g);
    const mapName = g.map || "Carte inconnue";
    const rankedBadge = g.rankedType && g.rankedType !== "unranked"
      ? `<span class="pf-game-ranked">${esc(g.rankedType)}</span>` : "";
    const totalPlayers = g.totalPlayers != null ? `${g.totalPlayers} joueurs` : "";

    return `
      <div class="pf-game-card ${resultClass}">
        <div class="pf-game-result">${resultLabel}</div>
        <div class="pf-game-info">
          <div class="pf-game-map">${esc(mapName)} ${rankedBadge}</div>
          <div class="pf-game-meta">${esc(modeLabel)}${totalPlayers ? ' · ' + esc(totalPlayers) : ''} · ${duration}</div>
          <div class="pf-game-meta">${formatDateTime(g.start)}</div>
        </div>
        <a class="pf-game-replay" href="https://openfront.io/game/${encodeURIComponent(g.gameId)}" target="_blank" rel="noopener" title="Voir le replay">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </a>
      </div>
    `;
  }).join("");
}

/** Format duration in seconds as M:SS or H:MM:SS */
function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}:${String(rs).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}:${String(rm).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
}

/** Build a human-readable game mode label from the game object */
function formatGameMode(g) {
  const parts = [];
  if (g.type) parts.push(g.type);
  if (g.mode) parts.push(g.mode === "Free For All" ? "FFA" : g.mode);
  if (g.playerTeams && g.playerTeams !== "null") parts.push(g.playerTeams);
  return parts.join(" · ") || "—";
}

/**
 * Check whether the given clientId is among the winners of the given game.
 * OpenFront `/public/game/{gameId}` returns `info.winner` as
 * `[type, name, ...clientIDs]`.
 */
async function checkGameWin(gameId, clientId) {
  if (!gameId || !clientId) return null;
  const data = await fetchOpenFront(`/public/game/${encodeURIComponent(gameId)}`);
  const winner = data?.info?.winner;
  if (!Array.isArray(winner) || winner.length < 3) return null;
  // winner[0] = "team" | "player", winner[1] = name, winner[2..] = clientIDs
  const winnerIds = winner.slice(2);
  return winnerIds.includes(clientId);
}

/* ── Setup: ownership verification ── */

window.startOwnershipVerification = async () => {
  if (!currentUser) {
    showToast("Veuillez vous connecter d'abord.", "warning");
    return;
  }
  const usernameInput = document.getElementById("setup-username");
  const publicIdInput = document.getElementById("setup-public-id");
  const username = (usernameInput?.value || "").trim();
  const publicId = (publicIdInput?.value || "").trim();

  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast("Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.", "warning");
    return;
  }

  // If user already has a different publicId, refuse change
  try {
    if (currentProfile && currentProfile.publicId && currentProfile.publicId !== publicId) {
      showToast("Le Public ID OpenFront ne peut plus être modifié.", "error");
      return;
    }
  } catch (e) { /* non-blocking */ }

  // Verify publicId exists on OpenFront
  showToast("Vérification du Public ID…", "info", 3000);
  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.publicId) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
  } catch (e) {
    if (e?.isNotFound || e?.status === 404) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
    showToast("Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.", "error", 6000);
    console.error("[setup] API check failed:", e);
    return;
  }

  // Check that no other user has this publicId already
  try {
    const aliasesRes = await fetch(`${FIRESTORE_BASE}/public-aliases`);
    if (aliasesRes.ok) {
      const aliasesData = await aliasesRes.json();
      const docs = aliasesData.documents || [];
      for (const doc of docs) {
        const f = doc.fields || {};
        const val = (field) => (field?.stringValue || field?.integerValue || "");
        const pid = val(f.publicId);
        const docUid = doc.name?.split("/").pop();
        if (pid === publicId && docUid !== currentUser.uid) {
          showToast("Ce Public ID est déjà lié à un autre compte.", "error");
          return;
        }
      }
    }
  } catch (e) { /* non-blocking */ }

  // Directly save — no challenge code needed, public ID is unique
  await saveUserProfile(username, publicId);
};

window.confirmOwnershipVerification = async () => {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || "Confirmer";
  if (btn) { btn.disabled = true; btn.textContent = "Vérification…"; }

  try {
    // L'API /public/player/{id} ne renvoie plus `games`. On récupère les
    // parties récentes via l'endpoint dédié /public/player/{id}/games.
    const gamesData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}/games`);
    const games = Array.isArray(gamesData?.results) ? gamesData.results : [];
    let found = games.some((g) => g.username && g.username.includes(_ownershipCode));
    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.", "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    // Verified → save to Firestore
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = () => {
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
};

async function saveUserProfile(username, publicId) {
  if (!currentUser) throw new Error("No authenticated user");
  try {
    const existing = currentProfile || {};
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email || null,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    currentProfile = { ...(currentProfile || {}), username, publicId, verified: true };
    showToast("Profil vérifié et enregistré avec succès !", "success");

    // Publie le lien publicId ↔ username/uid dans une collection publique pour que
    // le matching VIP par PUBLIC ID fonctionne pour tous les viewers (skin suit le
    // public_id, pas l'alias). Best-effort: ignoré silencieusement si règles bloquent.
    try {
      await setDoc(doc(db, "public-aliases", currentUser.uid), {
        username,
        publicId,
        aliases: [username],
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (bridgeErr) {
      console.warn("[profile] Bridge public-aliases (publicId) write failed (non-critique):", bridgeErr.message);
    }
    try {
      await setDoc(doc(db, "public-rewards", currentUser.uid), {
        publicId,
        username,
      }, { merge: true });
    } catch (rewardsErr) {
      console.warn("[profile] public-rewards publicId merge failed (non-critique):", rewardsErr.message);
    }

    // Reset setup form
    window.cancelOwnershipVerification();
    updateSidebarUI(currentUser, currentProfile);

    // Switch to main view and load stats
    showView("profile-main");
    renderHero(currentUser, currentProfile);
    loadVipForProfile(); // écoute VIP pour appliquer le skin par publicId
    await loadStats(publicId);
  } catch (e) {
    console.error("[profile] Save profile error:", e);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
    throw e;
  }
}

/* ── Sidebar / auth modal handlers ── */

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.handleLogin = async function (provider) {
  if (window._loginInProgress) return;
  window._loginInProgress = true;
  const authBtns = document.querySelectorAll(".auth-btn");
  authBtns.forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    // Close modal on success — onAuthStateChanged will switch view
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[profile] Login error:", e);
  } finally {
    window._loginInProgress = false;
    authBtns.forEach((b) => { b.disabled = false; b.style.opacity = ""; });
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm("Voulez-vous vous déconnecter ?")) return;
  try { await window.logout(); } catch (e) { console.warn("[profile] logout error:", e); }
  currentUser = null;
  currentProfile = null;
  updateSidebarUI(null);
  showView("profile-gate");
};

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const c = document.getElementById("user-container");
  if (c) c.classList.toggle("open");
};

window.closeUserDropdown = function () {
  const c = document.getElementById("user-container");
  if (c) c.classList.remove("open");
};

window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  // Already on profile page — just close dropdown
  window.closeUserDropdown();
};

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ═══ Activity chart + playtime estimation ═══ */



/* ═══ Weekly Performance Chart — Line chart ═══
   Graphique en lignes: semaines sur l'axe X (horizontal), score sur
   l'axe Y gauche, position sur l'axe Y droite (inversé).
   Lignes colorées par mode: FFA=rouge, Team=bleu, Total=noir.
   Points avec cercle contenant le rang (#X). */

function renderWeeklyChart() {
  const data = window._profileWeekData;
  if (!data) return;

  let wrap = document.getElementById("weekly-chart-card");
  if (!wrap) {
    const recent = document.getElementById("profile-recent-games");
    if (!recent) return;
    wrap = document.createElement("div");
    wrap.id = "weekly-chart-card";
    wrap.className = "pf-card";
    wrap.style.marginTop = "16px";
    wrap.innerHTML = `
      <div class="pf-card-header">
        <span class="pf-card-title">Weekly Performance</span>
        <span class="pf-card-sub">Points par semaine</span>
      </div>
      <div class="pf-card-body" style="padding:16px">
        <canvas id="weekly-chart-canvas" style="width:100%;height:320px;display:block"></canvas>
      </div>
    `;
    recent.parentNode.after(wrap);
  }

  const canvas = document.getElementById("weekly-chart-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // ── Data: 1 week for now (Week 1). Will expand as history accumulates. ──
  const weeks = ["Week 1"];
  const rankedScore = data.ffaRanked + data.teamRanked;
  const series = [
    { label: "FFA", color: "#ef4444", points: [{ score: data.ffa, rank: data.rank, detail: { wins: data.ffaCasual } }] },
    { label: "Team", color: "#2196f3", points: [{ score: data.team, rank: data.rank, detail: { wins: data.teamCasual } }] },
    { label: "Class\u00e9", color: "#9333ea", points: [{ score: rankedScore, rank: data.rank, detail: { ffa1v1: data.ffaRanked, team2v2: data.teamRanked } }] },
    { label: "Total", color: "#111827", points: [{ score: data.total, rank: data.rank, detail: { ffa: data.ffa, team: data.team, ranked: rankedScore, allTime: data.allTimePoints } }] },
  ];

  // Store point positions for hover detection
  const pointPositions = [];

  // ── Layout ──
  const padding = { top: 40, right: 30, bottom: 50, left: 55 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  // ── Scale ──
  const allScores = series.flatMap(s => s.points.map(p => p.score));
  const maxScore = Math.max(...allScores, 10);
  const niceMax = Math.ceil(maxScore / 5) * 5 || 5;

  // X positions: Week 1 at far left, subsequent weeks spread right
  // For 1 week: place at left + small offset (not centered)
  // For multiple weeks: spread across full width
  const xForIndex = (i) => {
    if (weeks.length === 1) return padding.left + 20;
    return padding.left + (i / (weeks.length - 1)) * chartW;
  };
  const yForScore = (score) => padding.top + chartH - (score / niceMax) * chartH;

  // ── Grid + Y-axis (Score, left) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const val = Math.round((niceMax / 5) * i);
    const y = padding.top + chartH - (i / 5) * chartH;
    ctx.fillText(val, padding.left - 8, y + 3);
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
  }

  // Y-axis label "Score"
  ctx.save();
  ctx.translate(14, padding.top + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText("Score", 0, 0);
  ctx.restore();

  // ── X-axis labels (weeks) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "center";
  weeks.forEach((label, i) => {
    ctx.fillText(label, xForIndex(i), padding.top + chartH + 20);
  });

  // "Week" label centered
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText("Week", padding.left + chartW / 2, H - 8);

  // ── Draw lines + points for each series ──
  series.forEach(s => {
    if (s.points.length === 0) return;

    // Line connecting points (only if 2+ weeks)
    if (s.points.length >= 2) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xForIndex(i);
        const y = yForScore(p.score);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Points — dots only, except Total which gets a rank circle
    s.points.forEach((p, i) => {
      const x = xForIndex(i);
      const y = yForScore(p.score);

      if (s.label === "Total" && p.rank && p.rank !== "—") {
        // Total point: rank circle with "#X" inside
        const r = 16;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = "#111827";
        ctx.font = "700 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("#" + p.rank, x, y);
        ctx.textBaseline = "alphabetic";

        // Movement arrow (up/down) compared to previous week
        if (i > 0) {
          const prev = s.points[i - 1];
          if (prev.rank && prev.rank !== "—") {
            const prevRank = parseInt(prev.rank);
            const currRank = parseInt(p.rank);
            if (currRank < prevRank) {
              // Better rank (lower number) → green up arrow
              ctx.fillStyle = "#10b981";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2191", x + r + 4, y - 4);
            } else if (currRank > prevRank) {
              // Worse rank (higher number) → red down arrow
              ctx.fillStyle = "#ef4444";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2193", x + r + 4, y - 4);
            }
          }
        }
      } else {
        // Other series: simple filled dot
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Store position for hover detection
      pointPositions.push({ x, y, r: s.label === "Total" ? 18 : 12, series: s, point: p, weekIndex: i });
    });
  });

  // ── Legend (top right) ──
  const legendY = 20;
  let legendX = W - padding.right - 180;
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "left";
  series.forEach(s => {
    ctx.beginPath();
    ctx.arc(legendX, legendY - 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s.label, legendX + 10, legendY);
    legendX += 45;
  });

  // ── Hover tooltip ──
  let tooltip = document.getElementById("weekly-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "weekly-chart-tooltip";
    tooltip.style.cssText = "position:fixed;z-index:1000;display:none;pointer-events:none;background:rgba(26,20,16,0.97);border:1px solid rgba(255,165,80,0.3);border-radius:10px;padding:10px 14px;font-size:12px;color:#ffd9b3;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);max-width:220px;line-height:1.6";
    document.body.appendChild(tooltip);
  }

  // Clone canvas to remove old event listeners
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  const ctx2 = newCanvas.getContext("2d");
  ctx2.drawImage(canvas, 0, 0, W, H);

  const hoverHandler = (e) => {
    const rect = newCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const pp of pointPositions) {
      const dx = mx - pp.x;
      const dy = my - pp.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pp.r) {
        found = pp;
        break;
      }
    }

    if (found) {
      const d = found.point.detail || {};
      const wk = weeks[found.weekIndex] || "";
      let html = `<div style="font-weight:700;color:#fff;margin-bottom:4px">${found.series.label} \u2014 ${wk}</div>`;
      html += `<div style="color:#9ca3af;font-size:11px;margin-bottom:6px">Score: <span style="color:${found.series.color};font-weight:700">${found.point.score} pts</span></div>`;

      if (found.series.label === "FFA") {
        html += `<div style="font-size:11px;color:#a89480">Wins FFA: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Team") {
        html += `<div style="font-size:11px;color:#a89480">Wins Team: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Class\u00e9") {
        html += `<div style="font-size:11px;color:#a89480">1v1: ${d.ffa1v1 || 0} wins</div>`;
        html += `<div style="font-size:11px;color:#a89480">2v2: ${d.team2v2 || 0} wins</div>`;
      } else if (found.series.label === "Total") {
        html += `<div style="font-size:11px;color:#a89480">FFA: ${d.ffa || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Team: ${d.team || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Class\u00e9: ${d.ranked || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Rang: #${found.point.rank}</div>`;
        html += `<div style="font-size:11px;color:#a89480;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1)">All-time: ${d.allTime || 0} pts</div>`;
      }

      tooltip.innerHTML = html;
      tooltip.style.display = "block";

      let tx = e.clientX + 14;
      let ty = e.clientY - 10;
      if (tx > window.innerWidth - 250) tx = e.clientX - 240;
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";

      newCanvas.style.cursor = "pointer";
    } else {
      tooltip.style.display = "none";
      newCanvas.style.cursor = "default";
    }
  };

  newCanvas.addEventListener("mousemove", hoverHandler);
  newCanvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    newCanvas.style.cursor = "default";
  });
}