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
import {
  getSkin, getUnlockableSkins, DEFAULT_SKIN_ID, RARITY_META, normalizeCode,
} from "./skins.js?v=1";
import {
  fetchOwnedSkins, redeemCode, activateSkin, applySkinToElement,
  invalidateActiveSkinCache,
} from "./reward-codes.js?v=1";
import {
  computePlaytimeStats, extractCareerWins, totalWins, pointsFor,
  formatDurationCompact, formatPct, formatFrenchDate,
  formatPoints, classifyGame,
} from "./playtime-stats.js?v=1";

/* ── Player overlays (plaque nominative) ── */
const PLAYER_OVERLAYS = [
  { match: /skailex/i, theme: "green", images: {
    dashboard: "green_original_dashboard_48x16.webp",
    ranked:    "green_original_ranked_144x48.webp",
    speedruns: "green_original_speedruns_171x57.webp",
    profile:   "green_original_profil_304x48.webp",
  }},
  { match: /varxard/i, theme: "fire", images: {
    dashboard: "fire_dashboard_48x16.webp",
    ranked:    "fire_ranked_144x48.webp",
    speedruns: "fire_speedruns_171x57.webp",
    profile:   "fire_profil_304x48.webp",
  }},
  // Available themes for future players: water, earth, air
];
function getPlayerOverlay(username, context) {
  if (!username) return null;
  for (const o of PLAYER_OVERLAYS) {
    if (o.match.test(username)) {
      if (context && o.images && o.images[context]) return o.images[context];
      return o.images ? o.images.profile : null;
    }
  }
  return null;
}

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;
let _allGamesCache = null; // toutes les games paginées (pour playtime + map stats)
let _allGamesLoading = false;
let _mapStatsSortBy = "count";
let _mapStatsShowAll = false;
let _rewardCardState = { publicId: null, ownedSkins: [], activeSkinId: null };

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
  if (nameEl) {
    nameEl.innerHTML = "";
    const skinSpan = document.createElement("span");
    skinSpan.textContent = username;
    // Apply overlay if the player has one
    const overlayImg = getPlayerOverlay(username, "profile");
    if (overlayImg) {
      skinSpan.classList.add("has-overlay");
      skinSpan.style.setProperty("--overlay-img", `url('${overlayImg}')`);
    }
    nameEl.appendChild(skinSpan);
    applySkinToElement(skinSpan, publicId, true);
  }

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
  if (nameEl) {
    nameEl.innerHTML = "";
    const skinSpan = document.createElement("span");
    skinSpan.textContent = profile.username || user.displayName || "Joueur";
    // Apply overlay if the player has one
    const overlayImg = getPlayerOverlay(profile.username || user.displayName, "profile");
    if (overlayImg) {
      skinSpan.classList.add("has-overlay");
      skinSpan.style.setProperty("--overlay-img", `url('${overlayImg}')`);
    }
    nameEl.appendChild(skinSpan);
    applySkinToElement(skinSpan, profile.publicId, true);
  }

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

  // Cockpit: ensure #cockpit-status-meta exists inside the header card.
  // Populated later by renderPrecomputedStats with level/playtime/streak chips.
  const headerCard = document.querySelector(".pf-header-card");
  if (headerCard && !document.getElementById("cockpit-status-meta")) {
    const meta = document.createElement("div");
    meta.id = "cockpit-status-meta";
    meta.className = "cockpit-status-meta";
    const statsList = headerCard.querySelector(".pf-stats-list");
    if (statsList) headerCard.insertBefore(meta, statsList);
    else headerCard.appendChild(meta);
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

  // ── Render reward card + career stats + start games loading IMMEDIATELY ──
  // Don't wait for dashboard_scores, ELO, or recent games — those are secondary.
  // Only show reward code card on OWN profile (not when viewing someone else's public profile)
  const isOwnProfile = !viewingPublicId || (currentProfile && currentProfile.publicId === publicId);
  if (isOwnProfile) {
    renderRewardCodeCard(publicId);
  }
  renderCareerStats(playerData.stats || {}, publicId);
  loadAllGamesForStats(publicId);

  // ── Week stats from dashboard_scores.json (official data) — non-blocking ──
  (async () => {
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
    // Used only for the weekly chart now — the full recent games list
    // is rendered by renderRecentGamesFull via loadAllGamesForStats().
    try {
      await recentGamesPromise;
      renderWeeklyChart();
    } catch (e) {
      console.error("[profile] recent games fetch failed:", e);
    }
  })();
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
    // Try cockpit mount first, then fallback to career-stats-section
    const mount = document.getElementById("career-stats-section") || document.getElementById("playtime-section-mount");
    if (!mount) return;
    wrap = document.createElement("div");
    wrap.id = "weekly-chart-card";
    wrap.className = "cockpit-card";
    wrap.style.cssText = "margin-top:16px;padding:18px;background:var(--card,#fff);border:1px solid var(--border,#F3F4F6);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04)";
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--orange-pale,#fff4e9);color:var(--orange-deep,#c25700);border:1px solid rgba(255,122,0,0.18)">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 6-6"/></svg>
        </span>
        <div>
          <h3 style="margin:0;font-size:15px;font-weight:700;color:var(--text,#111)">Points par semaine</h3>
          <p style="margin:0;font-size:12px;color:var(--text3,#9CA3AF)">Performance hebdomadaire (FFA, Team, Classé)</p>
        </div>
      </div>
      <canvas id="weekly-chart-canvas" style="width:100%;height:300px;display:block"></canvas>
    `;
    mount.appendChild(wrap);
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
/* ════════════════════════════════════════════════════════════════
   REWARD CODE CARD (skins)
   ════════════════════════════════════════════════════════════════ */

function renderRewardCodeCard(publicId) {
  _rewardCardState.publicId = publicId;
  const container = document.getElementById("reward-code-section");
  if (!container) return;

  // Build the card HTML
  container.innerHTML = `
    <div class="reward-code-card">
      <div class="reward-code-header">
        <span class="reward-code-header-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
        </span>
        <div>
          <h2>Codes de récompense</h2>
          <p>Entre un code pour débloquer un skin (motif de texte coloré sur ton pseudo)</p>
        </div>
      </div>
      <div class="reward-code-body">
        <label for="reward-code-input" style="display:block;font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Code de récompense</label>
        <div class="reward-code-input-row">
          <div class="reward-code-input-wrap">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <input type="text" id="reward-code-input" placeholder="EX: GOLD-2025" autocomplete="off" style="text-transform:uppercase">
          </div>
          <button type="button" class="reward-code-btn" id="reward-code-submit" disabled>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Valider
          </button>
        </div>
        <p class="reward-code-hint">Les codes sont normalisés en majuscules. Un code peut être à usage unique ou limité.</p>
      </div>
      <div class="reward-code-gallery-section">
        <div class="reward-code-gallery-title">
          <h3>Skins possédés (<span id="owned-skins-count">0</span>)</h3>
          <span class="reward-code-gallery-hint">Clique pour activer</span>
        </div>
        <div class="skins-gallery" id="skins-gallery">
          <div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">Chargement…</div>
        </div>
      </div>
    </div>
  `;

  // Wire up the input + button
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");

  input.addEventListener("input", () => {
    input.value = normalizeCode(input.value);
    btn.disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleRedeem();
  });
  btn.addEventListener("click", handleRedeem);

  // Load owned skins
  refreshOwnedSkins(publicId);
}

async function refreshOwnedSkins(publicId) {
  const gallery = document.getElementById("skins-gallery");
  const countEl = document.getElementById("owned-skins-count");
  if (!gallery) return;

  try {
    const { ownedSkins, activeSkinId } = await fetchOwnedSkins(publicId);
    _rewardCardState.ownedSkins = ownedSkins;
    _rewardCardState.activeSkinId = activeSkinId;
    if (countEl) countEl.textContent = ownedSkins.filter((s) => s.skinId !== DEFAULT_SKIN_ID).length;
    renderSkinsGallery(ownedSkins, activeSkinId);
  } catch (e) {
    console.warn("[profile] refreshOwnedSkins failed:", e);
    gallery.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">Erreur de chargement</div>`;
  }
}

function renderSkinsGallery(ownedSkins, activeSkinId) {
  const gallery = document.getElementById("skins-gallery");
  if (!gallery) return;

  const ownedIds = new Set(ownedSkins.map((s) => s.skinId));
  const allSkins = [getSkin(DEFAULT_SKIN_ID), ...getUnlockableSkins()];

  gallery.innerHTML = allSkins.map((skin) => {
    const isOwned = skin.id === DEFAULT_SKIN_ID || ownedIds.has(skin.id);
    const isActive = (skin.id === DEFAULT_SKIN_ID && (!activeSkinId || activeSkinId === DEFAULT_SKIN_ID)) || activeSkinId === skin.id;
    const ownedEntry = ownedSkins.find((s) => s.skinId === skin.id);
    const rarity = RARITY_META[skin.rarity];

    if (!isOwned) {
      return `
        <div class="skin-card locked" title="${esc(skin.description)}">
          <svg class="skin-locked-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <div class="skin-preview"><span class="${skin.cssClass}" style="opacity:0.3">${esc(skin.name)}</span></div>
          <div class="skin-name">${esc(skin.name)}</div>
          <span class="skin-rarity-badge" style="color:${rarity.color};background:${rarity.bg}">${rarity.label}</span>
          <div style="margin-top:4px;font-size:10px;color:var(--text3)">Verrouillé</div>
        </div>
      `;
    }

    return `
      <button type="button" class="skin-card ${isActive ? 'active' : ''}" data-skin-id="${esc(skin.id)}" title="${esc(skin.description)}">
        ${isActive ? '<span style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:50%;background:var(--orange);color:#fff;display:inline-flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
        <div class="skin-preview"><span class="${skin.cssClass}">${esc(skin.name)}</span></div>
        <div class="skin-name">${esc(skin.name)}</div>
        <span class="skin-rarity-badge" style="color:${rarity.color};background:${rarity.bg}">${rarity.label}</span>
        ${ownedEntry && ownedEntry.redeemedAt ? `<span class="skin-redeemed-date">Depuis le ${formatFrenchDate(new Date(ownedEntry.redeemedAt).getTime())}</span>` : ''}
        ${isActive ? '<span class="skin-active-badge">● Actif</span>' : ''}
      </button>
    `;
  }).join("");

  // Wire up activate buttons
  gallery.querySelectorAll(".skin-card[data-skin-id]").forEach((card) => {
    card.addEventListener("click", () => handleActivate(card.dataset.skinId));
  });
}

async function handleRedeem() {
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");
  if (!input || !input.value.trim()) return;

  const code = input.value.trim();
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;

  btn.disabled = true;
  btn.innerHTML = `<div class="games-loading-spinner" style="width:14px;height:14px"></div> Validation…`;

  try {
    const result = await redeemCode(code, publicId);
    if (result.alreadyOwned) {
      showToast(result.message, "info");
    } else {
      showToast(result.message || `Skin "${result.skinName}" débloqué !`, "success");
    }
    input.value = "";
    await refreshOwnedSkins(publicId);
    // Refresh the hero name skin
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    showToast(e.message || "Code invalide", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Valider`;
  }
}

async function handleActivate(skinId) {
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;
  try {
    const result = await activateSkin(publicId, skinId);
    _rewardCardState.activeSkinId = result.activeSkinId;
    showToast(skinId === DEFAULT_SKIN_ID ? "Skin standard activé" : `Skin "${getSkin(skinId).name}" activé`, "success");
    renderSkinsGallery(_rewardCardState.ownedSkins, result.activeSkinId);
    // Refresh hero name
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    showToast(e.message || "Activation impossible", "error");
  }
}

/* ════════════════════════════════════════════════════════════════
   CAREER STATS OVERVIEW + CHARTS
   ════════════════════════════════════════════════════════════════ */

function renderCareerStats(statsTree, publicId) {
  // Cockpit redesign: the full career overview (metrics, rings, cat bars,
  // activity, recent games, map stats) is now rendered by renderPrecomputedStats
  // once the pre-computed stats file (player-stats/<pid>.json) is loaded by
  // loadAllGamesForStats(). This function is kept as a no-op placeholder so the
  // existing loadStats flow doesn't break — the container shows a loading state
  // until the cockpit data arrives.
  const container = document.getElementById("career-stats-section");
  if (!container) return;
  container.innerHTML = `<div class="cockpit-loading"><div class="cockpit-loading-spinner"></div><span>Chargement du cockpit…</span></div>`;
}

/* ════════════════════════════════════════════════════════════════
   ALL GAMES PAGINATION (for playtime + map stats)
   ════════════════════════════════════════════════════════════════ */

async function loadAllGamesForStats(publicId) {
  if (_allGamesLoading) return;
  _allGamesLoading = true;

  const mount = document.getElementById("career-stats-section");
  if (mount) mount.innerHTML = `<div class="cockpit-loading"><div class="cockpit-loading-spinner"></div><span>Chargement du cockpit…</span></div>`;

  // Load the PRE-CALCULATED stats file — instant, zero calculation!
  // Generated by compute-player-stats.js (GitHub Actions workflow, continuous loop).
  try {
    const statsRes = await fetch(`player-stats/${encodeURIComponent(publicId)}.json`, { cache: "no-store" });
    if (statsRes.ok) {
      const stats = await statsRes.json();
      if (stats && stats.totalGames != null) {
        if (mount) mount.innerHTML = "";
        renderPrecomputedStats(stats, mount);
        _allGamesLoading = false;
        return;
      }
    }
  } catch (e) {
    console.warn("[profile] Could not load pre-computed stats file:", e.message);
  }

  // Fallback: no pre-computed stats available. The CI pipeline generates them
  // within a few minutes of the first sync. Show a friendly message instead of
  // duplicating the heavy compute logic client-side (the cockpit relies on
  // pre-computed fields: level, nextMilestones, sparkline7d, etc.).
  if (mount) {
    mount.innerHTML = `
      <div class="cockpit-fallback">
        <div class="cockpit-fallback-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h3>Stats en cours de calcul</h3>
        <p>Notre serveur prépare ton cockpit. Recharge la page dans 1-2 minutes.</p>
        <button type="button" class="cockpit-fallback-btn" onclick="location.reload()">Recharger</button>
      </div>
    `;
  }
  _allGamesLoading = false;
}

/* ════════════════════════════════════════════════════════════════
   [COCKPIT-REDESIGN] The 4 functions below (renderPlaytimeStats,
   renderActivityStats, renderMapStatsTable, renderRecentGamesFull) were
   removed and merged into the new renderPrecomputedStats() which builds
   the Cockpit layout from the pre-computed stats file.
   The map stats table + recent games list are kept inside the cockpit,
   just restyled and rendered inline by renderPrecomputedStats.
   ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL — opens when clicking a recent game row
   ════════════════════════════════════════════════════════════════ */

/** Attach click handlers to all [data-game-id] rows inside `container`. */
function attachGameRowClickHandlers(container, games) {
  if (!container) return;
  const rows = container.querySelectorAll('[data-game-id]');
  rows.forEach((row) => {
    const open = () => {
      const id = row.getAttribute('data-game-id');
      const game = games.find((g) => String(g.gameId) === id);
      if (game) showGameModal(game);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

/** Show a modal with detailed info about a single game. */
function showGameModal(game) {
  let modal = document.getElementById('game-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'game-detail-modal';
    modal.className = 'game-modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="game-modal">
        <button class="game-modal-close" aria-label="Fermer" type="button">&times;</button>
        <div class="game-modal-content"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('.game-modal-close')) {
        closeGameModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) closeGameModal();
    });
  }

  const cat = classifyGame(game);
  const catLabels = { ffaCasual: "FFA Casual", ffaRanked: "1v1", teamCasual: "Team Casual", teamRanked: "2v2" };
  const resultColor = game.result === "victory" ? "#10b981" : game.result === "defeat" ? "#ef4444" : game.result === "incomplete" ? "#6B7280" : "#9CA3AF";
  const resultLabel = game.result === "victory" ? "Victoire" : game.result === "defeat" ? "Défaite" : game.result === "incomplete" ? "Incomplet" : (game.result || "—");
  const duration = game.durationSeconds || game.duration;
  const startDate = game.start ? formatFrenchDate(new Date(game.start).getTime()) : "—";
  const replayUrl = game.gameId ? `https://openfront.io/game/${encodeURIComponent(game.gameId)}` : null;

  const content = modal.querySelector('.game-modal-content');
  content.innerHTML = `
    <div class="game-modal-result-badge" style="background:${resultColor}">${esc(resultLabel)}</div>
    <h3 class="game-modal-map">${esc(game.map || "Carte inconnue")}</h3>
    <div class="game-modal-rows">
      <div class="game-modal-row"><span class="game-modal-row-label">Mode</span><span class="game-modal-row-value">${esc(catLabels[cat] || game.mode || "—")}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Type classé</span><span class="game-modal-row-value">${esc(game.rankedType || "—")}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Durée</span><span class="game-modal-row-value">${duration ? formatDurationCompact(Number(duration) || 0) : "—"}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Joueurs</span><span class="game-modal-row-value">${game.totalPlayers != null ? esc(String(game.totalPlayers)) : "—"}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Date</span><span class="game-modal-row-value">${esc(startDate)}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Game ID</span><span class="game-modal-row-value game-modal-gameid">${esc(String(game.gameId || "—"))}</span></div>
    </div>
    ${replayUrl ? `<a class="game-modal-replay" href="${replayUrl}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Voir le replay sur OpenFront</a>` : ""}
  `;

  modal.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeGameModal() {
  const modal = document.getElementById('game-detail-modal');
  if (modal) modal.classList.remove('is-open');
  document.body.style.overflow = '';
}

/* ════════════════════════════════════════════════════════════════
   [COCKPIT-REDESIGN] renderRecentGamesFull was removed — recent games
   are now rendered inline by renderPrecomputedStats (in the cockpit's
   bottom full-width section). The game modal (showGameModal / closeGameModal
   / attachGameRowClickHandlers) is kept as-is for clickable row details.
   ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   FALLBACK: si onAuthStateChanged ne se déclenche pas (Firebase CDN
   bloqué ou lent), force le rendu du profil public après 8s.
   ════════════════════════════════════════════════════════════════ */
setTimeout(() => {
  const loading = document.getElementById("profile-loading");
  if (loading && loading.classList.contains("is-active")) {
    const pubReq = getPublicProfileRequest();
    if (pubReq) {
      console.warn("[profile] Auth state timeout — forcing public profile render");
      currentUser = null;
      currentProfile = null;
      updateSidebarUI(null);
      viewingPublicId = pubReq.publicId;
      viewingUsername = pubReq.username;
      showView("profile-main");
      renderPublicProfile(pubReq.username, pubReq.publicId);
      loadVipForProfile();
      loadStats(pubReq.publicId);
    } else {
      console.warn("[profile] Auth state timeout — showing gate");
      showView("profile-gate");
    }
  }
}, 8000);

/* ════════════════════════════════════════════════════════════════
   COCKPIT HELPERS — count-up animation, progress rings SVG,
   sparkline SVG, keyboard shortcuts, share-profile action.
   ════════════════════════════════════════════════════════════════ */

const COCKPIT_CAT_LABELS = { ffaCasual: "FFA Casual", ffaRanked: "1v1", teamCasual: "Team Casual", teamRanked: "2v2" };
const COCKPIT_CAT_COLORS = { ffaCasual: "#ff7a00", ffaRanked: "#d97706", teamCasual: "#10b981", teamRanked: "#a855f7" };
const COCKPIT_WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Animate a number from 0 to target over `duration` ms (ease-out cubic). */
function cockpitCountUp(el, target, duration = 1000) {
  if (!el) return;
  const targetNum = Number(target);
  if (!Number.isFinite(targetNum)) return;
  const start = performance.now();
  const fmt = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(targetNum * eased);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(targetNum);
  };
  requestAnimationFrame(tick);
}

/** Build 3 concentric progress rings as an SVG string (Apple Watch style). */
function cockpitProgressRings(rings) {
  const size = 168;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = 11;
  const gap = 3;
  const radii = [];
  let r = cx - stroke / 2 - 3;
  for (let i = 0; i < rings.length; i++) {
    radii.push(r);
    r -= (stroke + gap);
  }
  const circ = (rad) => 2 * Math.PI * rad;
  const ringSvgs = rings.map((ring, i) => {
    const rad = radii[i];
    const c = circ(rad);
    const pct = ring.target > 0 ? Math.min(1, ring.value / ring.target) : 0;
    const offset = c * (1 - pct);
    return `
      <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${ring.color}" stroke-opacity="0.13" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${ring.color}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${c.toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})"
        style="transition: stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1) ${0.1 + i * 0.15}s"
        data-target-offset="${offset.toFixed(2)}" class="ring-arc" />
    `;
  }).join("");
  const totalPct = rings.length > 0
    ? Math.round(rings.reduce((s, r) => s + (r.target > 0 ? Math.min(1, r.value / r.target) : 0), 0) / rings.length * 100)
    : 0;
  return `
    <svg viewBox="0 0 ${size} ${size}" class="progress-rings-svg" width="${size}" height="${size}" role="img" aria-label="Anneaux de progression">
      ${ringSvgs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="progress-rings-center-pct">${totalPct}%</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" class="progress-rings-center-sub">complété</text>
    </svg>
  `;
}

/** Build a small SVG sparkline from an array of 7 numbers. */
function cockpitSparkline(values) {
  const w = 220;
  const h = 64;
  const pad = 6;
  const vals = Array.isArray(values) && values.length > 0 ? values.slice(-7) : [0, 0, 0, 0, 0, 0, 0];
  while (vals.length < 7) vals.unshift(0);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / Math.max(1, vals.length - 1);
  const pts = vals.map((v, i) => ({
    x: pad + i * stepX,
    y: h - pad - ((v - min) / range) * (h - pad * 2 - 8) - 4,
  }));
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(2)},${h - pad} L${pts[0].x.toFixed(2)},${h - pad} Z`;
  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    totalLength += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Activité 7 derniers jours">
      <defs>
        <linearGradient id="cockpit-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff7a00" stop-opacity="0.28" />
          <stop offset="100%" stop-color="#ff7a00" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#cockpit-spark-grad)" />
      <path d="${linePath}" fill="none" stroke="#ff7a00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        stroke-dasharray="${totalLength.toFixed(2)}" stroke-dashoffset="${totalLength.toFixed(2)}"
        style="transition: stroke-dashoffset 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.25s"
        data-target-offset="0" class="sparkline-path" />
      ${pts.map((p, i) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${i === pts.length - 1 ? 3 : 0}" fill="#ff7a00" />`).join("")}
    </svg>
  `;
}

/** Wire up keyboard shortcuts (g=games, m=maps, s=skins, r=recent, Esc=modal). */
function setupCockpitKeyboardShortcuts() {
  if (window._cockpitKbInit) return;
  window._cockpitKbInit = true;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "g" || k === "r") {
      const el = document.getElementById("cockpit-recent-games");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (k === "m") {
      const el = document.getElementById("cockpit-maps-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (k === "s") {
      const el = document.getElementById("reward-code-section");
      if (el && el.children.length > 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/** Copy the current profile URL to clipboard. */
function cockpitShareProfile() {
  const pid = _rewardCardState.publicId || (currentProfile && currentProfile.publicId) || viewingPublicId;
  const url = pid ? `${window.location.origin}${window.location.pathname}?pid=${encodeURIComponent(pid)}` : window.location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => showToast("Lien du profil copié !", "success"),
      () => showToast("Copie impossible — sélectionne l'URL manuellement", "info")
    );
  } else {
    const tmp = document.createElement("input");
    tmp.value = url;
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand("copy"); showToast("Lien du profil copié !", "success"); }
    catch { showToast("Copie impossible", "error"); }
    document.body.removeChild(tmp);
  }
}

/* ════════════════════════════════════════════════════════════════
   RENDER PRE-COMPUTED STATS — Cockpit layout
   (from player-stats/<pid>.json — instant display, zero calculation)
   ════════════════════════════════════════════════════════════════ */

function renderPrecomputedStats(stats, mount) {
  if (!mount || !stats) return;
  mount.innerHTML = "";
  setupCockpitKeyboardShortcuts();

  // ── Synced data badge ──
  const syncedDate = stats.lastSyncedAt ? new Date(stats.lastSyncedAt) : null;
  const syncedStr = syncedDate ? syncedDate.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "récemment";
  const badge = document.createElement("div");
  badge.className = "cockpit-sync-badge";
  badge.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Données synchronisées (${stats.totalGames} parties · MAJ ${syncedStr})`;
  mount.appendChild(badge);

  // ── Status bar meta (level + playtime + streak chips) ──
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) {
    const playtimeHours = Math.floor((stats.playtime?.totalSec || 0) / 3600);
    const streak = stats.streaks?.current || 0;
    const level = stats.level ?? Math.floor((stats.points || 0) / 100);
    const flameSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
    const starSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const clockSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    metaEl.innerHTML = `
      <span class="cockpit-chip cockpit-chip-level">${starSvg} Niv. ${level}</span>
      <span class="cockpit-chip cockpit-chip-playtime">${clockSvg} ${playtimeHours}h</span>
      <span class="cockpit-chip cockpit-chip-streak ${streak > 0 ? "is-active" : ""}">${flameSvg} ${streak}</span>
    `;
  }

  // ── Compute milestone + ring data ──
  const ms = stats.nextMilestones || (() => {
    // Fallback: compute next milestone dynamically (next multiple above current)
    const winsCurrent = stats.totalWins || 0;
    const playtimeCurrent = Math.floor((stats.playtime?.totalSec || 0) / 3600);
    const mapsCurrent = stats.maps?.length || 0;
    const nextMult = (val, step) => {
      if (val <= 0) return step;
      const m = Math.ceil(val / step) * step;
      return m > val ? m : m + step;
    };
    return {
      wins: { current: winsCurrent, target: nextMult(winsCurrent, 50) },
      playtime: { current: playtimeCurrent, target: nextMult(playtimeCurrent, 50) },
      maps: { current: mapsCurrent, target: nextMult(mapsCurrent, 10) },
    };
  })();
  const playtimeHoursCurrent = Math.floor((stats.playtime?.totalSec || 0) / 3600);
  const rings = [
    { label: "Wins", value: ms.wins.current, target: ms.wins.target, color: "#ff7a00" },
    { label: "Playtime", value: ms.playtime.current ?? playtimeHoursCurrent, target: ms.playtime.target, color: "#c25700" },
    { label: "Maps", value: ms.maps.current ?? (stats.maps?.length || 0), target: ms.maps.target, color: "#ffa14d" },
  ];

  // ── Build the cockpit grid ──
  const grid = document.createElement("div");
  grid.className = "cockpit-grid";

  // ─────────── LEFT COLUMN ───────────
  const leftCol = document.createElement("div");
  leftCol.className = "cockpit-left";

  // 4 metric widgets
  const winrateNum = parseInt(String(stats.formatted?.winrate || "0").replace(/\D/g, ""), 10) || 0;
  const metrics = document.createElement("div");
  metrics.className = "cockpit-metrics";
  metrics.innerHTML = `
    <div class="metric-card" data-metric="wins">
      <span class="metric-card-label">Wins</span>
      <span class="metric-card-value" data-countup="${stats.totalWins || 0}">0</span>
    </div>
    <div class="metric-card" data-metric="winrate">
      <span class="metric-card-label">Winrate</span>
      <span class="metric-card-value"><span data-countup="${winrateNum}">0</span>%</span>
    </div>
    <div class="metric-card" data-metric="games">
      <span class="metric-card-label">Games</span>
      <span class="metric-card-value" data-countup="${stats.totalGames || 0}">0</span>
    </div>
    <div class="metric-card" data-metric="maps">
      <span class="metric-card-label">Cartes</span>
      <span class="metric-card-value" data-countup="${stats.maps?.length || 0}">0</span>
    </div>
  `;
  leftCol.appendChild(metrics);

  // Progress rings card
  const ringsCard = document.createElement("div");
  ringsCard.className = "cockpit-card cockpit-rings";
  ringsCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Anneaux de progression</h3>
      <span class="cockpit-card-sub">Vers le prochain palier</span>
    </div>
    <div class="cockpit-rings-body">
      <div class="cockpit-rings-svg-wrap">${cockpitProgressRings(rings)}</div>
      <div class="cockpit-rings-legend">
        ${rings.map((r) => `
          <div class="ring-legend-item">
            <span class="ring-dot" style="background:${r.color}"></span>
            <span class="ring-legend-label">${r.label}</span>
            <span class="ring-legend-value">${r.value} / ${r.target}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
  leftCol.appendChild(ringsCard);

  // Temps par catégorie
  const cat = stats.playtime?.byCategory || {};
  const totalSec = stats.playtime?.totalSec || 0;
  const catRows = [
    { key: "ffaCasual", playtimeSec: cat.ffaCasual?.playtimeSec || 0, games: cat.ffaCasual?.games || 0 },
    { key: "ffaRanked", playtimeSec: cat.ffaRanked?.playtimeSec || 0, games: cat.ffaRanked?.games || 0 },
    { key: "teamCasual", playtimeSec: cat.teamCasual?.playtimeSec || 0, games: cat.teamCasual?.games || 0 },
    { key: "teamRanked", playtimeSec: cat.teamRanked?.playtimeSec || 0, games: cat.teamRanked?.games || 0 },
  ];
  const catBars = document.createElement("div");
  catBars.className = "cockpit-card cockpit-cat-bars";
  catBars.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Temps par catégorie</h3>
      <span class="cockpit-card-sub">${stats.formatted?.totalPlaytime || "—"} au total</span>
    </div>
    <div class="cat-bars">
      ${catRows.map((c) => {
        const sec = c.playtimeSec;
        const games = c.games;
        const pct = totalSec > 0 ? (sec / totalSec) * 100 : 0;
        const hours = sec / 3600;
        const hoursStr = hours >= 1 ? `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m` : `${Math.floor(sec / 60)}m`;
        return `
          <div class="cat-bar-row">
            <div class="cat-bar-label">
              <span>${COCKPIT_CAT_LABELS[c.key] || c.key}</span>
              <span class="cat-bar-hours">${hoursStr} · ${Math.round(pct)}%</span>
            </div>
            <div class="cat-bar-track">
              <div class="cat-bar-fill" style="width:0%;background:${COCKPIT_CAT_COLORS[c.key] || "#ff7a00"}" data-target-width="${pct.toFixed(2)}"></div>
            </div>
            <div class="cat-bar-sub">${games} parties</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  leftCol.appendChild(catBars);

  // Activité par jour (weekday bars)
  const wd = stats.activity?.byWeekday || [0, 0, 0, 0, 0, 0, 0];
  const maxWd = Math.max(...wd, 1);
  const peakWdIdx = wd.indexOf(Math.max(...wd));
  const weekdayCard = document.createElement("div");
  weekdayCard.className = "cockpit-card cockpit-weekday-bars";
  weekdayCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Activité par jour</h3>
      <span class="cockpit-card-sub">Pic: ${COCKPIT_WEEKDAYS[peakWdIdx] || "—"} (${maxWd} parties)</span>
    </div>
    <div class="weekday-bars">
      ${wd.map((count, i) => {
        const h = Math.max(2, (count / maxWd) * 100);
        const isPeak = i === peakWdIdx && count > 0;
        return `
          <div class="weekday-bar-col ${isPeak ? "is-peak" : ""}" title="${COCKPIT_WEEKDAYS[i]} — ${count} parties">
            <div class="weekday-bar-track">
              <div class="weekday-bar-fill" style="height:0%" data-target-height="${h.toFixed(2)}"></div>
            </div>
            <div class="weekday-bar-label">${COCKPIT_WEEKDAYS[i]}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  leftCol.appendChild(weekdayCard);

  grid.appendChild(leftCol);

  // ─────────── RIGHT COLUMN ───────────
  const rightCol = document.createElement("div");
  rightCol.className = "cockpit-right";

  // Prochaine action panel
  const winsRemaining = Math.max(0, ms.wins.target - ms.wins.current);
  const mapsRemaining = Math.max(0, ms.maps.target - ms.maps.current);
  const playtimeRemaining = Math.max(0, ms.playtime.target - (ms.playtime.current ?? playtimeHoursCurrent));
  const actions = [
    {
      title: `Atteins ${ms.wins.target} wins`,
      sub: winsRemaining > 0 ? `${winsRemaining} wins restants` : "Objectif atteint !",
      icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
    },
    {
      title: `Atteins ${ms.playtime.target}h de jeu`,
      sub: playtimeRemaining > 0 ? `${playtimeRemaining}h restantes` : "Objectif atteint !",
      icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    },
    {
      title: `Explore ${ms.maps.target} cartes`,
      sub: mapsRemaining > 0 ? `${mapsRemaining} cartes restantes` : "Toutes explorées !",
      icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>`,
    },
    {
      title: "Partage ton profil",
      sub: "Copier le lien",
      icon: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`,
      action: "share",
    },
  ];
  const actionsCard = document.createElement("div");
  actionsCard.className = "cockpit-card cockpit-actions";
  actionsCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Prochaine action</h3>
    </div>
    <div class="action-list">
      ${actions.map((a) => `
        <button type="button" class="action-item ${a.action === "share" ? "action-share" : ""}" ${a.action === "share" ? 'data-action="share"' : ""}>
          <span class="action-arrow"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></span>
          <span class="action-icon">${a.icon}</span>
          <span class="action-text">
            <span class="action-title">${esc(a.title)}</span>
            <span class="action-sub">${esc(a.sub)}</span>
          </span>
        </button>
      `).join("")}
    </div>
  `;
  actionsCard.querySelectorAll(".action-share").forEach((btn) => {
    btn.addEventListener("click", cockpitShareProfile);
  });
  rightCol.appendChild(actionsCard);

  // Level bar
  const level = stats.level ?? Math.floor((stats.points || 0) / 100);
  const levelProgress = stats.levelProgress ?? ((stats.points || 0) % 100);
  const levelPct = Math.min(100, (levelProgress / 100) * 100);
  const levelCard = document.createElement("div");
  levelCard.className = "cockpit-card cockpit-level";
  levelCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Niveau ${level}</h3>
      <span class="cockpit-card-sub">${levelProgress} / 100 pts → Niv. ${level + 1}</span>
    </div>
    <div class="level-bar-track">
      <div class="level-bar-fill" style="width:0%" data-target-width="${levelPct.toFixed(2)}"></div>
    </div>
    <div class="level-bar-stats">
      <span>${levelProgress} pts</span>
      <span>${stats.formatted?.points || stats.points || 0} pts total</span>
    </div>
  `;
  rightCol.appendChild(levelCard);

  // Sparkline (7 days)
  const sparkValues = stats.sparkline7d || [0, 0, 0, 0, 0, 0, 0];
  const sparkTotal = sparkValues.reduce((s, v) => s + (Number(v) || 0), 0);
  const sparkCard = document.createElement("div");
  sparkCard.className = "cockpit-card cockpit-sparkline";
  sparkCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>7 derniers jours</h3>
      <span class="cockpit-card-sub">${sparkTotal} parties</span>
    </div>
    <div class="sparkline-wrap">${cockpitSparkline(sparkValues)}</div>
    <div class="sparkline-axis">
      <span>J-6</span><span></span><span></span><span></span><span></span><span></span><span>Auj.</span>
    </div>
  `;
  rightCol.appendChild(sparkCard);

  // Streaks
  const streakCard = document.createElement("div");
  streakCard.className = "cockpit-card cockpit-streaks";
  const curStreak = stats.streaks?.current || 0;
  const bestStreak = stats.streaks?.best || 0;
  const flameIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
  const trophyIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
  streakCard.innerHTML = `
    <div class="cockpit-card-header">
      <h3>Séries</h3>
    </div>
    <div class="streaks-grid">
      <div class="streak-item ${curStreak > 0 ? "is-active" : ""}">
        <span class="streak-icon">${flameIcon}</span>
        <span class="streak-label">Actuelle</span>
        <span class="streak-value" data-countup="${curStreak}">0</span>
      </div>
      <div class="streak-item">
        <span class="streak-icon">${trophyIcon}</span>
        <span class="streak-label">Record</span>
        <span class="streak-value" data-countup="${bestStreak}">0</span>
      </div>
    </div>
  `;
  rightCol.appendChild(streakCard);

  grid.appendChild(rightCol);
  mount.appendChild(grid);

  // ─────────── RECENT GAMES (full width) ───────────
  if (stats.recentGames && stats.recentGames.length > 0) {
    const recentSection = document.createElement("div");
    recentSection.className = "cockpit-card cockpit-recent-games";
    recentSection.id = "cockpit-recent-games";
    const recentList = stats.recentGames.slice(0, 20);
    recentSection.innerHTML = `
      <div class="cockpit-card-header">
        <h3>Parties récentes</h3>
        <span class="cockpit-card-sub">${stats.totalGames} au total · clique pour détails</span>
      </div>
      <div class="recent-games-list cockpit-recent-list">
        ${recentList.map((g) => {
          const resultColor = g.result === "victory" ? "#10b981" : g.result === "defeat" ? "#ef4444" : "#9CA3AF";
          const resultLabel = g.result === "victory" ? "Victoire" : g.result === "defeat" ? "Défaite" : (g.result || "—");
          const dur = g.durationSeconds;
          const dateStr = g.start ? formatFrenchDate(new Date(g.start).getTime()) : "—";
          const durStr = dur ? formatDurationCompact(Number(dur) || 0) : "—";
          return `
            <div class="recent-game-row" data-game-id="${esc(String(g.gameId ?? ""))}" role="button" tabindex="0">
              <span class="recent-game-dot" style="background:${resultColor}"></span>
              <div class="recent-game-info">
                <div class="recent-game-map">${esc(g.map || "Carte inconnue")}</div>
                <div class="recent-game-meta">${COCKPIT_CAT_LABELS[g.category] || g.mode || "—"} · ${g.totalPlayers || "?"} joueurs</div>
              </div>
              <div class="recent-game-right">
                <div class="recent-game-result" style="color:${resultColor}">${resultLabel}</div>
                <div class="recent-game-date">${dateStr} · ${durStr}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
    mount.appendChild(recentSection);
    attachGameRowClickHandlers(recentSection, recentList);
  }

  // ─────────── MAP STATS (collapsible, full width) ───────────
  if (stats.maps && stats.maps.length > 0) {
    const mapSection = document.createElement("div");
    mapSection.className = "cockpit-card cockpit-maps";
    mapSection.id = "cockpit-maps-section";
    const allMaps = stats.maps;
    const topMaps = allMaps.slice(0, 10);
    const mapRowHtml = (m) => {
      const wrColor = m.winRate >= 0.6 ? "#10b981" : m.winRate >= 0.4 ? "#d97706" : "#ef4444";
      return `<tr><td class="map-name">${esc(m.map)}</td><td class="num">${m.count}</td><td class="num" style="color:#10b981">${m.wins}</td><td class="num" style="color:#ef4444">${m.losses}</td><td class="num" style="color:${wrColor};font-weight:700">${m.formatted.winRate}</td><td class="num">${m.formatted.avgDuration}</td><td class="num" style="font-size:11px;color:var(--text3)">${m.formatted.lastPlayed}</td></tr>`;
    };
    mapSection.innerHTML = `
      <div class="cockpit-card-header">
        <h3>Statistiques par carte</h3>
        <span class="cockpit-card-sub">${allMaps.length} cartes jouées</span>
      </div>
      <button type="button" id="cockpit-maps-toggle" class="cockpit-maps-toggle" aria-expanded="false">Voir les ${allMaps.length} cartes</button>
      <div class="cockpit-maps-body" id="cockpit-maps-body">
        <div class="map-stats-table-wrap">
          <div class="map-stats-table-scroll">
            <table class="map-stats-table">
              <thead><tr><th>Carte</th><th style="text-align:right">Parties</th><th style="text-align:right">V</th><th style="text-align:right">D</th><th style="text-align:right">Winrate</th><th style="text-align:right">Durée moy.</th><th style="text-align:right">Dernière</th></tr></thead>
              <tbody>${topMaps.map(mapRowHtml).join("")}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    mount.appendChild(mapSection);

    // Wire toggle button
    const toggleBtn = mapSection.querySelector("#cockpit-maps-toggle");
    const mapsBody = mapSection.querySelector("#cockpit-maps-body");
    if (toggleBtn && mapsBody) {
      let expanded = false;
      toggleBtn.addEventListener("click", () => {
        expanded = !expanded;
        mapsBody.classList.toggle("is-open", expanded);
        toggleBtn.textContent = expanded ? "Masquer les cartes" : `Voir les ${allMaps.length} cartes`;
        toggleBtn.setAttribute("aria-expanded", String(expanded));
        if (expanded) {
          const tbody = mapsBody.querySelector("tbody");
          if (tbody) tbody.innerHTML = allMaps.map(mapRowHtml).join("");
        } else {
          const tbody = mapsBody.querySelector("tbody");
          if (tbody) tbody.innerHTML = topMaps.map(mapRowHtml).join("");
        }
      });
    }
  }

  // ── Trigger animations on next frame (count-up, ring arcs, sparkline, bars) ──
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mount.querySelectorAll("[data-countup]").forEach((el) => {
        cockpitCountUp(el, parseFloat(el.dataset.countup) || 0, 1100);
      });
      mount.querySelectorAll(".ring-arc").forEach((el) => {
        el.style.strokeDashoffset = el.dataset.targetOffset;
      });
      mount.querySelectorAll(".sparkline-path").forEach((el) => {
        el.style.strokeDashoffset = el.dataset.targetOffset || "0";
      });
      mount.querySelectorAll(".cat-bar-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      mount.querySelectorAll(".weekday-bar-fill").forEach((el) => {
        el.style.height = el.dataset.targetHeight + "%";
      });
      mount.querySelectorAll(".level-bar-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
    });
  });

  // ── Weekly chart (points par semaine) ──
  // Render after cockpit so the mount element exists
  if (window._profileWeekData) {
    setTimeout(() => renderWeeklyChart(), 100);
  }
}
