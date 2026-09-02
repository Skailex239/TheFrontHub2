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

/* ── Vignettes de cartes : nom affiché → slug (atlas-data/maps_data.json,
   précalculé en dictionnaire compact pour un lookup instantané) ── */
const MAP_SLUGS={achiran:"achiran",aegean:"aegean",africa:"africa",alps:"alps",amazonriver:"amazonriver",antarctica:"antarctica",archipelagosea:"archipelagosea",arctic:"arctic",asia:"asia",australia:"australia",baikal:"baikal",baikalnukewars:"baikalnukewars",bajacalifornia:"bajacalifornia",balkans:"balkans",beringsea:"beringsea",beringstrait:"beringstrait",betweentwoseas:"betweentwoseas",blacksea:"blacksea",bosphorusstraits:"bosphorusstraits",branchingpaths:"branchingpaths",britannia:"britannia",britanniaclassic:"britanniaclassic",caribbean:"caribbean",caspiansea:"caspiansea",caucasus:"caucasus",centralasia:"centralasia",china:"china",colombia:"colombia", continua:"continua",danelaw:"danelaw",danishstraits:"danishstraits",degehabur:"degehabur",degahbour:"degahbour",dfz:"dfz",easterisland:"easterisland",europe:"europe",europeclassic:"europeclassic",falklandislands:"falklandislands",fars:"fars",france:"france",gatewaytotheatlantic:"gatewaytotheatlantic",germany:"germany",ghangisgolf:"ghangisgolf",ghana:"ghana",gobi:"gobi",greatlakes:"greatlakes",greece:"greece",greenland:"greenland",halfearth:"halfearth",hawaii:"hawaii",himalaya:"himalaya",iceland:"iceland",india:"india",indonesia:"indonesia",iowa:"iowa",iran:"iran",italia:"italia",italy:"italy",japan:"japan",japanneureich:"japanneureich",kalahari:"kalahari",kamtchatka:"kamtchatka",korea:"korea",lisboa:"lisboa",luna:"luna",maharaja:"maharaja",mallorca:"mallorca",manchuria:"manchuria",mapuche:"mapuche",mars:"mars",medina:"medina",mediterranean:"mediterranean",menam:"menam",montreal:"montreal",namibia:"namibia",naussicaa:"naussicaa",netherlands:"netherlands",newcaledonia:"newcaledonia",newengland:"newengland",newyork:"newyork",northamerica:"northamerica",norway:"norway",oceania:"oceania",pangaea:"pangaea",paris:"paris",patagonia:"patagonia",persepolis:"persepolis",poland:"poland",quebec:"quebec",richelieu:"richelieu",rome:"rome",sahara:"sahara",sardaigne:"sardaigne",sardinia:"sardinia",scandinavia:"scandinavia",southamerica:"southamerica",straitofgibraltar:"straitofgibraltar",suezcanal:"suezcanal",switzerland:"switzerland",taiwan:"taiwan",turkey:"turkey",uk:"uk",ukraine:"ukraine",vostok:"vostok",warsaw:"warsaw",westus:"westus",world:"world",yenisei:"yenisei",yemen:"yemen",znation:"znation"};

/** Thumbnail URL for a map display name (null si le nom est inconnu). */
function mapThumbUrl(name) {
  if (!name) return null;
  const slug = MAP_SLUGS[String(name).replace(/[^a-z0-9]/gi, "").toLowerCase()];
  return slug
    ? `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`
    : null;
}

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
    return new Date(iso).toLocaleDateString('fr-FR', { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString('fr-FR', { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
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

  const badgeEl = document.getElementById("profile-public-badge-text");
  if (badgeEl) badgeEl.textContent = publicId || "—";
  const pidBtn = document.getElementById("profile-public-badge");
  if (pidBtn) {
    pidBtn.dataset.pid = publicId || "";
    pidBtn.style.display = publicId ? "" : "none";
  }

  // Badge « vérifié » : masqué par défaut sur un profil public (donnée non chargée)
  const verifiedEl = document.getElementById("profile-verified");
  if (verifiedEl) verifiedEl.hidden = true;

  // Date d'arrivée : masquée sur un profil public (donnée non chargée)
  const joinedEl = document.getElementById("profile-joined-text");
  if (joinedEl) joinedEl.parentElement.style.display = "none";

  // Affiche la bannière "Profil public" + bouton retour
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "flex";

  // Masque le bouton de déconnexion (ce n'est pas notre session)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "none";

  // Avatar dégradé + initiale (cohérent avec le flux normal)
  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    avatarEl.innerHTML = "";
    avatarEl.textContent = (username || "J").charAt(0).toUpperCase();
  }

  // Réinitialise les chips meta (remplies par renderPrecomputedStats)
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) metaEl.innerHTML = "";

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

  // Chip Public ID copiable (bouton pf2-id-pid)
  const badgeEl = document.getElementById("profile-public-badge-text");
  if (badgeEl) badgeEl.textContent = profile.publicId || "—";
  const pidBtn = document.getElementById("profile-public-badge");
  if (pidBtn) {
    pidBtn.dataset.pid = profile.publicId || "";
    pidBtn.style.display = profile.publicId ? "" : "none";
  }

  // Badge « vérifié » (donnée Firestore : profile.verified)
  const verifiedEl = document.getElementById("profile-verified");
  if (verifiedEl) verifiedEl.hidden = !profile.verified;

  // Date d'arrivée (profile.createdAt)
  const joinedEl = document.getElementById("profile-joined-text");
  if (joinedEl) {
    joinedEl.textContent = profile.createdAt
      ? "Membre depuis le " + formatDateShort(profile.createdAt)
      : "Membre";
    joinedEl.parentElement.style.display = profile.createdAt ? "" : "none";
  }

  // Masque la bannière "Profil public" (flux normal = propre profil)
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "none";

  // Ré-affiche le bouton de déconnexion (flux normal)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "";

  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    // Avatar dégradé + initiale (design system — cohérent avec la sidebar)
    avatarEl.innerHTML = "";
    avatarEl.textContent = (profile.username || user.displayName || "J").charAt(0).toUpperCase();
  }

  // Cockpit: ensure #cockpit-status-meta exists inside the header card.
  // Populated later by renderPrecomputedStats with level/playtime/streak chips.
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) metaEl.innerHTML = "";

  // Applique le skin VIP résolu par publicId (le listener VIP re-appliquera quand
  // les rewards arriveront). Fallback username = null ici car pas encore chargé.
  applyProfileSkin(profile, null);
}

/** Copie le Public ID dans le presse-papiers (chip de la carte identité). */
window.copyPublicId = function (btn) {
  const pid = btn?.dataset?.pid || (currentProfile && currentProfile.publicId) || "";
  if (!pid) return;
  const done = () => showToast("Public ID copié : " + pid, "success");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(pid).then(done).catch(() => {
      showToast("Public ID : " + pid, "info");
    });
  } else {
    showToast("Public ID : " + pid, "info");
  }
};

/* ── Main view: load stats ── */

async function loadStats(publicId) {
  // Reset stat cards + panneau Elo pendant le chargement
  setText("stat-alltime-value", "…");
  setText("stat-alltime-sub", "");
  hideError();
  const eloPanel = document.getElementById("pf2-elo-panel");
  if (eloPanel) eloPanel.hidden = true;
  const peersPanel = document.getElementById("pf2-peers-panel");
  if (peersPanel) peersPanel.hidden = true;

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
    setText("stat-alltime-value", "—");
    setText("stat-alltime-sub", "");
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
            publicId: publicId,
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
            // Sorted players (voisins de classement pour « Autour de toi »)
            weeklySorted: weeklySorted,
          };
        }
      }
    } catch (e) {
      console.warn("[profile] Week stats load failed:", e.message);
    }

    // ── Historique hebdo (weekly_history.json.gz) — non-blocking ──
    // Alimenté par sync-dashboard.js : un snapshot figé par semaine écoulée,
    // la semaine en cours est rafraîchie toutes les 5 min. Chaque lundi,
    // une nouvelle colonne S1, S2, S3… s'ajoute au graphique du profil.
    fetch("weekly_history.json.gz", { cache: "no-cache" })
      .then(async (res) => {
        if (res.ok) {
          const ds = new DecompressionStream("gzip");
          window._profileWeekHistory = await new Response(res.body.pipeThrough(ds)).json();
        } else {
          const fb = await fetch("weekly_history.json", { cache: "no-cache" });
          if (fb.ok) window._profileWeekHistory = await fb.json();
        }
        if (window._profileWeekHistory) renderWeeklyChart();
      })
      .catch(() => { /* pas encore d'historique (1re semaine) → courbe à 1 point */ });

    // All-time score
    const allTimeScore = stats.wins * 4 + (stats.total - stats.wins);

    setText("stat-alltime-value", new Intl.NumberFormat("fr-FR").format(weekTotalPoints || allTimeScore));
    setText("stat-alltime-sub", weekRank !== "—" ? `Semaine : ${weekScore} pts · #${weekRank}` : "");

    // Chip hebdo (Niv/temps/série sont posés par renderPrecomputedStats)
    const metaEl = document.getElementById("cockpit-status-meta");
    if (metaEl && weekRank !== "—") {
      let chip = document.getElementById("pf2-chip-week");
      if (!chip) {
        chip = document.createElement("span");
        chip.id = "pf2-chip-week";
        chip.className = "pf2-chip";
        metaEl.appendChild(chip);
      }
      chip.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg> Hebdo #${weekRank} · ${new Intl.NumberFormat("fr-FR").format(weekScore)} pts`;
    }

    // ── Panneau « Autour de toi » : voisins du classement hebdo ──
    const weekData = window._profileWeekData;
    const peersPanel = document.getElementById("pf2-peers-panel");
    const peersList = document.getElementById("pf2-peers-list");
    if (peersPanel && peersList && weekData?.weeklySorted && currentProfile?.publicId === publicId) {
      const sorted = weekData.weeklySorted;
      const idx = sorted.findIndex(p => p.publicId === publicId);
      if (idx >= 0) {
        const from = Math.max(0, idx - 2);
        const rows = sorted.slice(from, Math.min(sorted.length, from + 5));
        peersList.innerHTML = rows.map((p, i) => {
          const rank = from + i + 1;
          const isMe = p.publicId === publicId;
          return `<div class="pf2-peer${isMe ? " is-me" : ""}">
            <span class="pf2-peer-rank">${rank}</span>
            <span class="pf2-peer-name">${esc(p.username || p.publicId || "Joueur")}</span>
            <span class="pf2-peer-score">${new Intl.NumberFormat("fr-FR").format(p.weekly_points || 0)}</span>
          </div>`;
        }).join("");
        peersPanel.hidden = false;
      }
    }

    // ── Panneau « Elo Classé » (ranked.json) ──
    const ranked1v1 = await eloPromise;
    const ranked2v2 = await getRankedEntry(publicId, "2v2");
    if (eloPanel && (ranked1v1?.elo != null || ranked2v2?.elo != null)) {
      const v11 = document.getElementById("elo-1v1");
      const s11 = document.getElementById("elo-1v1-sub");
      const v22 = document.getElementById("elo-2v2");
      const s22 = document.getElementById("elo-2v2-sub");
      if (ranked1v1?.elo != null) {
        setText("elo-1v1", new Intl.NumberFormat("fr-FR").format(ranked1v1.elo));
        if (s11) s11.textContent = `Peak ${ranked1v1.peakElo ?? "—"}${ranked1v1.rank ? ` · #${ranked1v1.rank}` : ""}`;
      } else if (v11) {
        v11.textContent = "—";
        if (s11) s11.textContent = "Non classé";
      }
      if (ranked2v2?.elo != null) {
        setText("elo-2v2", new Intl.NumberFormat("fr-FR").format(ranked2v2.elo));
        if (s22) s22.textContent = `Peak ${ranked2v2.peakElo ?? "—"}${ranked2v2.rank ? ` · #${ranked2v2.rank}` : ""}`;
      } else if (v22) {
        v22.textContent = "—";
        if (s22) s22.textContent = "Non classé";
      }
      eloPanel.hidden = false;

      // Chip Elo dans les chips meta
      if (metaEl && ranked1v1?.elo != null) {
        let chip = document.getElementById("pf2-chip-elo");
        if (!chip) {
          chip = document.createElement("span");
          chip.id = "pf2-chip-elo";
          chip.className = "pf2-chip";
          metaEl.appendChild(chip);
        }
        chip.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 10 6-5 6 5"/><path d="m6 15 6-5 6 5"/><path d="m6 20 6-5 6 5"/></svg> Elo ${new Intl.NumberFormat("fr-FR").format(ranked1v1.elo)}`;
      }
    }

    // Recent games — fetched from /public/player/{id}/games (separate endpoint).
    // Used only for the weekly chart now — the full recent games list
    // is rendered by renderPrecomputedStats via loadAllGamesForStats().
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
  // (fix 2026-08-29 : FIRESTORE_BASE n'existe plus depuis la migration MySQL —
  //  la vérification pointait vers une variable undefined → ReferenceError
  //  avalé par le catch, check mort. Remplacé par l'API MySQL public-aliases.)
  try {
    const aliasesRes = await fetch("/api/public-aliases.php", { cache: "no-store" });
    if (aliasesRes.ok) {
      const aliasesData = await aliasesRes.json();
      const aliases = aliasesData.aliases || [];
      for (const alias of aliases) {
        if (alias.publicId === publicId && String(alias.uid) !== String(currentUser.uid)) {
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

// État visuel des boutons Discord pendant la redirection OAuth (modal + gate)
function setDiscordRedirecting(redirecting) {
  const btns = document.querySelectorAll(".auth-btn.discord, .pf-discord-btn, #auth-btn-discord");
  btns.forEach((btn) => {
    const label = btn.querySelector(".auth-btn-label");
    if (redirecting) {
      btn.disabled = true;
      btn.classList.add("is-redirecting");
      if (label) label.textContent = "Redirection vers Discord…";
    } else {
      btn.disabled = false;
      btn.classList.remove("is-redirecting");
      if (label) label.textContent = "Continuer avec Discord";
    }
  });
}

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.handleLogin = async function (provider) {
  if (window._loginInProgress) return;
  window._loginInProgress = true;
  setDiscordRedirecting(true);
  try {
    // Discord uniquement — loginWithDiscord() redirige vers l'OAuth
    await window.loginWithDiscord();
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[profile] Login error:", e);
    window._loginInProgress = false;
    setDiscordRedirecting(false);
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
   Graphique en lignes : semaines sur l'axe X (S1, S2, S3… — l'historique
   s'accumule semaine après semaine, voir sync-dashboard.js), score sur
   l'axe Y gauche, position sur l'axe Y droite (inversé).
   Lignes colorées par mode : FFA=rouge, Team=bleu, Classé=violet, Total=noir.
   Points avec cercle contenant le rang (#X) sur la série Total. */

/* Construit la liste chronologique des semaines :
   historique figé (weekly_history.json) + point live (semaine en cours,
   données les plus fraîches) en dernière position. */
function buildWeeklyWeeks(data) {
  const weeks = [];
  const hist = window._profileWeekHistory;
  const histWeeks = hist && hist.weeks ? Object.entries(hist.weeks).sort((a, b) => a[0].localeCompare(b[0])) : [];
  for (const [key, wk] of histWeeks) {
    const p = wk && wk.players ? wk.players[data.publicId] : null;
    weeks.push({
      key,
      start: (wk && wk.start) || key,
      total: p ? p.t || 0 : 0,
      ffa: p ? p.f || 0 : 0,
      team: p ? p.te || 0 : 0,
      ranked: p ? p.r || 0 : 0,
      rank: p && p.k ? p.k : "—",
    });
  }
  // Semaine en cours : refresh avec les données live (dashboard_scores)
  const liveKey = (data.weekStart || "").slice(0, 10);
  const liveIdx = weeks.findIndex((w) => w.key === liveKey);
  if (liveIdx >= 0) {
    const w = weeks[liveIdx];
    w.total = data.total;
    w.ffa = data.ffa;
    w.team = data.team;
    w.ranked = data.ffaRanked + data.teamRanked;
    w.rank = data.rank;
  } else {
    weeks.push({
      key: liveKey || "live",
      start: data.weekStart || new Date().toISOString(),
      total: data.total,
      ffa: data.ffa,
      team: data.team,
      ranked: data.ffaRanked + data.teamRanked,
      rank: data.rank,
    });
  }
  weeks.forEach((w, i) => { w.label = "S" + (i + 1); });
  return weeks;
}

function renderWeeklyChart() {
  const data = window._profileWeekData;
  if (!data || !data.publicId) return;

  let wrap = document.getElementById("weekly-chart-card");
  if (!wrap) {
    // En HAUT du profil (sous les cartes de stats), puis fallbacks historiques
    const mount = document.getElementById("pf2-weekly-top") || document.getElementById("pf2-below") || document.getElementById("career-stats-section") || document.getElementById("playtime-section-mount");
    if (!mount) return;
    wrap = document.createElement("div");
    wrap.id = "weekly-chart-card";
    wrap.className = "pf2-panel";
    wrap.innerHTML = `
      <header class="pf2-panel-head">
        <h3>Points par semaine</h3>
        <i class="pf2-panel-rule"></i>
        <span class="pf2-panel-sub">Performance hebdomadaire (FFA, Team, Classé) — une nouvelle semaine s'ajoute chaque lundi</span>
      </header>
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

  // ── Data : S1 → Sn (historique) + semaine en cours en dernier point ──
  const weeks = buildWeeklyWeeks(data);
  if (weeks.length === 0) return;
  const rankedScore = data.ffaRanked + data.teamRanked;
  const isLive = (i) => i === weeks.length - 1; // dernier point = semaine en cours (live)
  const series = [
    { label: "FFA", color: "#ef4444", points: weeks.map((w, i) => ({ score: w.ffa, rank: w.rank, detail: isLive(i) ? { wins: data.ffaCasual } : {}, date: w.start })) },
    { label: "Team", color: "#2196f3", points: weeks.map((w, i) => ({ score: w.team, rank: w.rank, detail: isLive(i) ? { wins: data.teamCasual } : {}, date: w.start })) },
    { label: "Class\u00e9", color: "#9333ea", points: weeks.map((w, i) => ({ score: w.ranked, rank: w.rank, detail: isLive(i) ? { ffa1v1: data.ffaRanked, team2v2: data.teamRanked } : {}, date: w.start })) },
    { label: "Total", color: "#111827", points: weeks.map((w, i) => ({ score: w.total, rank: w.rank, detail: isLive(i) ? { ffa: data.ffa, team: data.team, ranked: rankedScore, allTime: data.allTimePoints } : { ffa: w.ffa, team: w.team, ranked: w.ranked }, date: w.start })) },
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

  // ── X-axis labels (S1, S2, … — échantillonnés si trop nombreuses) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "center";
  const labelStep = weeks.length > 12 ? Math.ceil(weeks.length / 12) : 1;
  weeks.forEach((w, i) => {
    if (i % labelStep === 0 || i === weeks.length - 1) {
      ctx.fillText(w.label, xForIndex(i), padding.top + chartH + 20);
    }
  });

  // "Semaines" label centered
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText("Semaines", padding.left + chartW / 2, H - 8);

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
      const wMeta = weeks[found.weekIndex] || {};
      const dateStr = wMeta.start ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" }).format(new Date(wMeta.start)) : "";
      const wkTitle = `${wMeta.label || ""}${dateStr ? ` <span style=\"color:#9ca3af;font-weight:400\">· semaine du ${dateStr}</span>` : ""}`;
      let html = `<div style="font-weight:700;color:#fff;margin-bottom:4px">${found.series.label} — ${wkTitle}</div>`;
      html += `<div style="color:#9ca3af;font-size:11px;margin-bottom:6px">Score: <span style="color:${found.series.color};font-weight:700">${found.point.score} pts</span></div>`;

      if (found.series.label === "FFA") {
        if (d.wins !== undefined) html += `<div style="font-size:11px;color:#a89480">Wins FFA: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Team") {
        if (d.wins !== undefined) html += `<div style="font-size:11px;color:#a89480">Wins Team: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Class\u00e9") {
        if (d.ffa1v1 !== undefined) html += `<div style="font-size:11px;color:#a89480">1v1: ${d.ffa1v1 || 0} wins</div>`;
        if (d.team2v2 !== undefined) html += `<div style="font-size:11px;color:#a89480">2v2: ${d.team2v2 || 0} wins</div>`;
      } else if (found.series.label === "Total") {
        html += `<div style="font-size:11px;color:#a89480">FFA: ${d.ffa || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Team: ${d.team || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Class\u00e9: ${d.ranked || 0} pts</div>`;
        if (found.point.rank && found.point.rank !== "—") html += `<div style="font-size:11px;color:#a89480">Rang hebdo: #${found.point.rank}</div>`;
        if (d.allTime !== undefined) html += `<div style="font-size:11px;color:#a89480;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1)">All-time: ${d.allTime || 0} pts</div>`;
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
   RÉCOMPENSES v2 — codes + cosmétiques (design 2026-08)
   ════════════════════════════════════════════════════════════════ */

const RW_SUBMIT_LABEL = "Valider";

function setRwFeedback(type, msg) {
  const el = document.getElementById("rw-feedback");
  if (!el) return;
  el.className = "rw-feedback show " + type;
  const icon =
    type === "success"
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  el.innerHTML = icon + "<span>" + esc(msg) + "</span>";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearRwFeedback() {
  const el = document.getElementById("rw-feedback");
  if (el) {
    el.className = "rw-feedback";
    el.innerHTML = "";
  }
}

function renderRewardCodeCard(publicId) {
  _rewardCardState.publicId = publicId;
  const container = document.getElementById("reward-code-section");
  if (!container) return;

  container.innerHTML = `
    <div class="rw-card rw-card-compact">
      <div class="rw-header">
        <span class="rw-header-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
        </span>
        <div class="rw-header-text">
          <h2>Code de récompense</h2>
          <p>Entre un code pour débloquer un cosmétique pour ton pseudo.</p>
        </div>
      </div>
      <div class="rw-redeem">
        <div class="rw-redeem-row">
          <div class="rw-input-wrap">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <input type="text" id="reward-code-input" placeholder="TON-CODE-ICI" autocomplete="off" spellcheck="false">
          </div>
          <button type="button" class="rw-submit" id="reward-code-submit" disabled>
            <span class="auth-spinner" aria-hidden="true"></span>
            <span class="rw-submit-label">${RW_SUBMIT_LABEL}</span>
          </button>
        </div>
        <div class="rw-feedback" id="rw-feedback" role="status"></div>
      </div>
      <div class="rw-owned" id="rw-owned" hidden>
        <div class="rw-owned-head">
          <h3>Mes cosmétiques <span class="rw-count" id="owned-skins-count">0</span></h3>
          <span class="rw-gallery-hint">Clique pour activer</span>
        </div>
        <div class="rw-chips" id="rw-chips"></div>
      </div>
    </div>
  `;

  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");

  input.addEventListener("input", () => {
    input.value = normalizeCode(input.value);
    btn.disabled = !input.value.trim();
    clearRwFeedback();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleRedeem();
  });
  btn.addEventListener("click", handleRedeem);

  refreshOwnedSkins(publicId);
}

async function refreshOwnedSkins(publicId) {
  const ownedWrap = document.getElementById("rw-owned");
  if (!ownedWrap) return;

  try {
    const { ownedSkins, activeSkinId } = await fetchOwnedSkins(publicId);
    _rewardCardState.ownedSkins = ownedSkins;
    _rewardCardState.activeSkinId = activeSkinId;
    renderOwnedSkins(ownedSkins, activeSkinId);
  } catch (e) {
    console.warn("[profile] refreshOwnedSkins failed:", e);
  }
}

/**
 * Affiche les cosmétiques possédés en chips compactes.
 * La ligne n'apparaît QUE si le joueur possède au moins un skin du
 * catalogue — sinon la carte reste une simple entrée de code.
 * (Les ids hérités de l'ancien catalogue sont ignorés.)
 */
function renderOwnedSkins(ownedSkins, activeSkinId) {
  const wrap = document.getElementById("rw-owned");
  const chipsEl = document.getElementById("rw-chips");
  const countEl = document.getElementById("owned-skins-count");
  if (!wrap || !chipsEl) return;

  const owned = getUnlockableSkins().filter((s) =>
    ownedSkins.some((o) => o.skinId === s.id)
  );
  if (owned.length === 0) {
    wrap.hidden = true;
    chipsEl.innerHTML = "";
    if (countEl) countEl.textContent = "0";
    return;
  }

  wrap.hidden = false;
  if (countEl) countEl.textContent = String(owned.length);

  const isActive = (skinId) =>
    (skinId === DEFAULT_SKIN_ID && (!activeSkinId || activeSkinId === DEFAULT_SKIN_ID)) ||
    activeSkinId === skinId;

  const chip = (skin) => {
    const rarity = RARITY_META[skin.rarity] || RARITY_META.common;
    const active = isActive(skin.id);
    return `
      <button type="button" class="rw-chip ${active ? "active" : ""}" data-skin-id="${esc(skin.id)}" title="${esc(skin.description)}">
        <span class="rw-chip-preview"><span class="${skin.cssClass}">${esc(skin.name)}</span></span>
        <span class="rw-chip-dot" style="background:${rarity.color}"></span>
        ${active ? '<span class="rw-chip-badge">Actif</span>' : ""}
      </button>
    `;
  };

  chipsEl.innerHTML = chip(getSkin(DEFAULT_SKIN_ID)) + owned.map(chip).join("");

  chipsEl.querySelectorAll(".rw-chip[data-skin-id]").forEach((el) => {
    el.addEventListener("click", () => handleActivate(el.dataset.skinId));
  });
}

async function handleRedeem() {
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");
  const label = btn ? btn.querySelector(".rw-submit-label") : null;
  if (!input || !input.value.trim()) return;

  const code = input.value.trim();
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;

  btn.disabled = true;
  btn.classList.add("is-redirecting");
  if (label) label.textContent = "Validation…";
  clearRwFeedback();

  try {
    const result = await redeemCode(code, publicId);
    let message = result.message;

    // Auto-activation : le skin débloqué s'applique aussitôt au pseudo.
    // (Peut échouer pour un id hérité hors catalogue → message dégradé.)
    try {
      await activateSkin(publicId, result.skinId);
      message = result.alreadyOwned
        ? `Skin « ${result.skinName} » déjà dans ta collection — réactivé.`
        : `Skin « ${result.skinName} » débloqué et activé !`;
    } catch (e) {
      if (!result.alreadyOwned) message = `${result.message} Active-le ci-dessous.`;
    }

    setRwFeedback("success", message);
    showToast(
      result.alreadyOwned
        ? `Skin « ${result.skinName} » réactivé`
        : `Cosmétique « ${result.skinName} » débloqué !`,
      result.alreadyOwned ? "info" : "success"
    );
    input.value = "";
    await refreshOwnedSkins(publicId);
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    setRwFeedback("error", e.message || "Code invalide ou expiré.");
    showToast(e.message || "Code invalide", "error");
  } finally {
    btn.disabled = true; // sera ré-activé par l'input listener si besoin
    btn.classList.remove("is-redirecting");
    if (label) label.textContent = RW_SUBMIT_LABEL;
  }
}

async function handleActivate(skinId) {
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;
  try {
    const result = await activateSkin(publicId, skinId);
    _rewardCardState.activeSkinId = result.activeSkinId;
    showToast(
      skinId === DEFAULT_SKIN_ID ? "Skin standard activé" : `Skin « ${getSkin(skinId).name} » activé`,
      "success"
    );
    renderOwnedSkins(_rewardCardState.ownedSkins, result.activeSkinId);
    // Rafraîchit le pseudo du hero avec le skin actif
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
  container.innerHTML = `<div class="pf2-loading"><div class="pf2-loading-spinner"></div><span>Chargement du dossier…</span></div>`;
}

/* ════════════════════════════════════════════════════════════════
   ALL GAMES PAGINATION (for playtime + map stats)
   ════════════════════════════════════════════════════════════════ */

async function loadAllGamesForStats(publicId) {
  if (_allGamesLoading) return;
  _allGamesLoading = true;

  const mount = document.getElementById("career-stats-section");
  if (mount) mount.innerHTML = `<div class="pf2-loading"><div class="pf2-loading-spinner"></div><span>Chargement du dossier…</span></div>`;

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
      <div class="pf2-fallback">
        <div class="pf2-fallback-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h3>Stats en cours de calcul</h3>
        <p>Notre serveur prépare ton dossier. Recharge la page dans 1-2 minutes.</p>
        <button type="button" class="pf2-fallback-btn" onclick="location.reload()">Recharger</button>
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
      const el = document.getElementById("pf2-recent");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (k === "m") {
      const el = document.getElementById("pf2-maps");
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
window.cockpitShareProfile = cockpitShareProfile;

/* ════════════════════════════════════════════════════════════════
   RENDER PRE-COMPUTED STATS — layout « A · Dossier »
   (from player-stats/<pid>.json — instant display, zero calculation)
   ════════════════════════════════════════════════════════════════ */

function renderPrecomputedStats(stats, mount) {
  if (!mount || !stats) return;
  mount.innerHTML = "";
  // Idempotence : vide aussi les zones hors mount (rappels loadStats / profils publics)
  const sideExtra = document.getElementById("pf2-side-extra");
  if (sideExtra) sideExtra.innerHTML = "";
  const below = document.getElementById("pf2-below");
  if (below) below.innerHTML = "";
  const weeklyCard = document.getElementById("weekly-chart-card");
  if (weeklyCard) weeklyCard.remove();
  setupCockpitKeyboardShortcuts();

  const fmt = (n) => new Intl.NumberFormat("fr-FR").format(Number(n) || 0);

  // ─────────── Cartes statistiques (au-dessus de la grille) ───────────
  const results = stats.results || {};
  setText("stat-games", fmt(stats.totalGames));
  setText("stat-wins", fmt(stats.totalWins));
  setText("stat-winrate", stats.formatted?.winrate || "—");
  setText("stat-maps", String(stats.maps?.length || 0));
  setText("stat-games-sub", stats.formatted?.avgGameDuration ? `Durée moy. ${stats.formatted.avgGameDuration}` : "");
  setText("stat-wins-sub", stats.streaks?.best ? `Record série : ${stats.streaks.best}` : "");
  setText("stat-winrate-sub", results.victory != null ? `${fmt(results.victory)}V · ${fmt(results.defeat || 0)}D` : "");
  setText("stat-maps-sub", "");

  // ─────────── Chips meta (niveau / temps de jeu / série) ───────────
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) {
    const playtimeHours = Math.floor((stats.playtime?.totalSec || 0) / 3600);
    const streak = stats.streaks?.current || 0;
    const level = stats.level ?? Math.floor((stats.points || 0) / 100);
    const flameSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
    const starSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const clockSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    metaEl.innerHTML = `
      <span class="pf2-chip">${starSvg} Niv. ${level}</span>
      <span class="pf2-chip">${clockSvg} ${playtimeHours} h</span>
      <span class="pf2-chip${streak > 0 ? " is-active" : ""}">${flameSvg} Série de ${streak}</span>
    `;
  }

  // ─────────── Badge de synchro ───────────
  const syncedDate = stats.lastSyncedAt ? new Date(stats.lastSyncedAt) : null;
  const syncedStr = syncedDate ? syncedDate.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "récemment";
  const badge = document.createElement("div");
  badge.className = "pf2-sync";
  badge.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Données synchronisées · ${fmt(stats.totalGames)} parties · MAJ ${syncedStr}`;
  mount.appendChild(badge);

  // ─────────── Panneau : Parties récentes ───────────
  const recentGames = stats.recentGames || [];
  const recentPanel = document.createElement("section");
  recentPanel.className = "pf2-panel";
  recentPanel.id = "pf2-recent";
  recentPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>Parties récentes</h3>
      <span class="pf2-panel-count">${fmt(stats.totalGames)}</span>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">clique pour les détails</span>
    </header>
    <div class="pf2-recent-list"></div>
  `;
  const recentList = recentPanel.querySelector(".pf2-recent-list");
  if (recentGames.length > 0) {
    recentList.innerHTML = recentGames.slice(0, 20).map((g) => {
      const win = g.result === "victory";
      const loss = g.result === "defeat";
      const pillCls = win ? "pf2-pill-win" : loss ? "pf2-pill-loss" : "pf2-pill-other";
      const label = win ? "Victoire" : loss ? "Défaite" : (g.result || "—");
      const dateStr = g.start ? formatFrenchDate(new Date(g.start).getTime()) : "—";
      const durStr = g.durationSeconds ? formatDurationCompact(Number(g.durationSeconds) || 0) : "—";
      const thumb = mapThumbUrl(g.map);
      const letter = esc((g.map || "?").charAt(0).toUpperCase());
      return `
        <div class="pf2-gamerow" data-game-id="${esc(String(g.gameId ?? ""))}" role="button" tabindex="0" aria-label="Détails de la partie — ${esc(g.map || "carte inconnue")}">
          <span class="pf2-gamerow-thumb">${letter}${thumb ? `<img src="${thumb}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
          <div class="pf2-gamerow-info">
            <p class="pf2-gamerow-map">${esc(g.map || "Carte inconnue")}</p>
            <p class="pf2-gamerow-meta">${esc(COCKPIT_CAT_LABELS[g.category] || g.mode || "—")} · ${g.totalPlayers || "?"} joueurs</p>
          </div>
          <div class="pf2-gamerow-right">
            <span class="pf2-pill ${pillCls}">${label}</span>
            <span class="pf2-gamerow-date">${esc(dateStr)} · ${esc(durStr)}</span>
          </div>
        </div>
      `;
    }).join("");
  } else {
    recentList.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
  }
  mount.appendChild(recentPanel);
  if (recentGames.length > 0) attachGameRowClickHandlers(recentPanel, recentGames.slice(0, 20));

  // ─────────── Panneau : Temps par catégorie ───────────
  const cat = stats.playtime?.byCategory || {};
  const totalSec = stats.playtime?.totalSec || 0;
  const catRows = ["ffaCasual", "ffaRanked", "teamCasual", "teamRanked"].map((key) => ({
    key,
    playtimeSec: cat[key]?.playtimeSec || 0,
    games: cat[key]?.games || 0,
  }));
  const catPanel = document.createElement("section");
  catPanel.className = "pf2-panel";
  catPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>Temps par catégorie</h3>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">${esc(stats.formatted?.totalPlaytime || "—")} au total</span>
    </header>
    ${catRows.map((c) => {
      const pct = totalSec > 0 ? (c.playtimeSec / totalSec) * 100 : 0;
      const hours = c.playtimeSec / 3600;
      const hoursStr = hours >= 1 ? `${Math.floor(hours)} h ${Math.floor((hours % 1) * 60)} m` : `${Math.floor(c.playtimeSec / 60)} m`;
      return `
        <div class="pf2-cat-row">
          <div class="pf2-cat-label">
            <span class="pf2-cat-name">${esc(COCKPIT_CAT_LABELS[c.key] || c.key)}</span>
            <span class="pf2-cat-hours">${esc(hoursStr)} · ${Math.round(pct)} %</span>
          </div>
          <div class="pf2-cat-track">
            <div class="pf2-cat-fill" style="background:${COCKPIT_CAT_COLORS[c.key] || "#ff7a00"}" data-target-width="${pct.toFixed(2)}"></div>
          </div>
          <div class="pf2-cat-sub">${fmt(c.games)} parties</div>
        </div>
      `;
    }).join("")}
  `;
  mount.appendChild(catPanel);

  // ─────────── Panneau : Activité par jour ───────────
  const wd = stats.activity?.byWeekday || [0, 0, 0, 0, 0, 0, 0];
  const maxWd = Math.max(...wd, 1);
  const peakWdIdx = wd.indexOf(Math.max(...wd));
  const weekPanel = document.createElement("section");
  weekPanel.className = "pf2-panel";
  weekPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>Activité par jour</h3>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">Pic : ${esc(COCKPIT_WEEKDAYS[peakWdIdx] || "—")} (${fmt(maxWd)} parties)</span>
    </header>
    <div class="pf2-week">
      ${wd.map((count, i) => {
        const h = Math.max(2, (count / maxWd) * 100);
        const isPeak = i === peakWdIdx && count > 0;
        return `
          <div class="pf2-week-col${isPeak ? " is-peak" : ""}" title="${esc(COCKPIT_WEEKDAYS[i])} — ${fmt(count)} parties">
            <div class="pf2-week-track">
              <div class="pf2-week-fill" data-target-height="${h.toFixed(2)}"></div>
            </div>
            <div class="pf2-week-label">${esc(COCKPIT_WEEKDAYS[i])}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  mount.appendChild(weekPanel);

  // ─────────── Colonne droite : Objectifs · Succès · Niveau · 7 jours ───────────

  // Milestones (objectifs) — fallback calculé si absentes
  const ms = stats.nextMilestones || (() => {
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
  const goals = [
    { name: "Victoires", value: ms.wins.current, target: ms.wins.target },
    { name: "Heures de jeu", value: ms.playtime.current ?? Math.floor((stats.playtime?.totalSec || 0) / 3600), target: ms.playtime.target },
    { name: "Cartes explorées", value: ms.maps.current ?? (stats.maps?.length || 0), target: ms.maps.target },
  ];
  if (sideExtra) {
    const goalsPanel = document.createElement("section");
    goalsPanel.className = "pf2-panel";
    goalsPanel.innerHTML = `
      <header class="pf2-panel-head"><h3>Objectifs</h3><i class="pf2-panel-rule"></i></header>
      ${goals.map((g) => {
        const pct = g.target > 0 ? Math.min(100, (g.value / g.target) * 100) : 0;
        const remaining = Math.max(0, g.target - g.value);
        return `
          <div class="pf2-goal">
            <div class="pf2-goal-head">
              <span class="pf2-goal-name">${esc(g.name)}</span>
              <span class="pf2-goal-value">${fmt(g.value)} / ${fmt(g.target)}</span>
            </div>
            <div class="pf2-goal-track">
              <div class="pf2-goal-fill" data-target-width="${pct.toFixed(2)}"></div>
            </div>
            <div class="pf2-goal-sub">${remaining > 0 ? `${fmt(remaining)} restants` : "Objectif atteint !"}</div>
          </div>
        `;
      }).join("")}
    `;
    sideExtra.appendChild(goalsPanel);

    // ── Succès (tuiles) ──
    const achvData = stats.achievements;
    if (achvData?.list?.length) {
      const ACHV_ICONS = {
        "first-win": `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
        "ten-wins": `<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>`,
        "hundred-wins": `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
        "marathon": `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
        "weekend": `<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>`,
        "cartographer": `<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>`,
        "streak5": `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
        "streak10": `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
        "polyvalent": `<path d="m6 10 6-5 6 5"/><path d="m6 15 6-5 6 5"/><path d="m6 20 6-5 6 5"/>`,
        "night-owl": `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`,
      };
      const lockSvg = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const achvPanel = document.createElement("section");
      achvPanel.className = "pf2-panel";
      achvPanel.innerHTML = `
        <header class="pf2-panel-head">
          <h3>Succès</h3>
          <span class="pf2-panel-count">${achvData.unlockedCount ?? achvData.list.filter((a) => a.unlocked).length}/${achvData.list.length}</span>
          <i class="pf2-panel-rule"></i>
        </header>
        <div class="pf2-achv-grid">
          ${achvData.list.map((a) => {
            const icon = a.unlocked
              ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACHV_ICONS[a.id] || ACHV_ICONS["first-win"]}</svg>`
              : lockSvg;
            const prog = !a.unlocked && a.progress?.target > 0
              ? `<div class="pf2-achv-progress"><div class="pf2-achv-progress-fill" style="width:${Math.min(100, Math.round((a.progress.current / a.progress.target) * 100))}%"></div></div>`
              : "";
            return `
              <div class="pf2-achv${a.unlocked ? "" : " is-locked"}">
                <span class="pf2-achv-icon">${icon}</span>
                <p class="pf2-achv-name">${esc(a.name)}</p>
                <p class="pf2-achv-desc">${esc(a.desc)}</p>
                ${prog}
              </div>
            `;
          }).join("")}
        </div>
      `;
      sideExtra.appendChild(achvPanel);
    }

    // ── Niveau ──
    const level = stats.level ?? Math.floor((stats.points || 0) / 100);
    const levelProgress = stats.levelProgress ?? ((stats.points || 0) % 100);
    const levelPct = Math.min(100, levelProgress);
    const levelPanel = document.createElement("section");
    levelPanel.className = "pf2-panel";
    levelPanel.innerHTML = `
      <header class="pf2-panel-head"><h3>Niveau</h3><i class="pf2-panel-rule"></i></header>
      <div class="pf2-level-head">
        <span class="pf2-level-title">Niveau ${level}</span>
        <span class="pf2-level-sub">${levelProgress} / 100 pts → Niv. ${level + 1}</span>
      </div>
      <div class="pf2-level-track">
        <div class="pf2-level-fill" data-target-width="${levelPct.toFixed(2)}"></div>
      </div>
      <div class="pf2-level-stats">
        <span>${fmt(levelProgress)} pts</span>
        <span>${esc(stats.formatted?.points || fmt(stats.points))} pts total</span>
      </div>
    `;
    sideExtra.appendChild(levelPanel);

    // ── 7 derniers jours (sparkline) ──
    const sparkValues = stats.sparkline7d || [0, 0, 0, 0, 0, 0, 0];
    const sparkTotal = sparkValues.reduce((s, v) => s + (Number(v) || 0), 0);
    const sparkPanel = document.createElement("section");
    sparkPanel.className = "pf2-panel";
    sparkPanel.innerHTML = `
      <header class="pf2-panel-head">
        <h3>7 derniers jours</h3>
        <i class="pf2-panel-rule"></i>
        <span class="pf2-panel-sub">${fmt(sparkTotal)} parties</span>
      </header>
      <div class="pf2-spark-wrap">${cockpitSparkline(sparkValues)}</div>
      <div class="pf2-spark-axis"><span>J-6</span><span></span><span></span><span></span><span></span><span></span><span>Auj.</span></div>
    `;
    sideExtra.appendChild(sparkPanel);
  }

  // ─────────── Sous la grille : stats par carte ───────────
  if (below && stats.maps && stats.maps.length > 0) {
    below.innerHTML = "";
    const allMaps = stats.maps;
    const topMaps = allMaps.slice(0, 10);
    const mapRowHtml = (m) => {
      const wr = m.winRate * 100;
      const wrColor = wr >= 60 ? "is-win" : wr >= 40 ? "" : "is-loss";
      return `<tr>
        <td>${esc(m.map)}</td>
        <td>${fmt(m.count)}</td>
        <td class="is-win">${fmt(m.wins)}</td>
        <td class="is-loss">${fmt(m.losses)}</td>
        <td class="${wrColor}" style="font-weight:700">${esc(m.formatted?.winRate || "—")}</td>
        <td>${esc(m.formatted?.avgDuration || "—")}</td>
        <td class="is-last">${esc(m.formatted?.lastPlayed || "—")}</td>
      </tr>`;
    };
    const mapPanel = document.createElement("section");
    mapPanel.className = "pf2-panel";
    mapPanel.id = "pf2-maps";
    mapPanel.innerHTML = `
      <header class="pf2-panel-head">
        <h3>Statistiques par carte</h3>
        <span class="pf2-panel-count">${allMaps.length}</span>
        <i class="pf2-panel-rule"></i>
      </header>
      <button type="button" id="pf2-maps-toggle" class="pf2-maps-toggle" aria-expanded="false">Voir les ${allMaps.length} cartes</button>
      <div class="pf2-maps-body" id="pf2-maps-body">
        <div class="pf2-maps-wrap">
          <table class="pf2-maps-table">
            <thead><tr><th>Carte</th><th>Parties</th><th>V</th><th>D</th><th>Winrate</th><th>Durée moy.</th><th>Dernière</th></tr></thead>
            <tbody>${topMaps.map(mapRowHtml).join("")}</tbody>
          </table>
        </div>
      </div>
    `;
    below.appendChild(mapPanel);
    const toggleBtn = mapPanel.querySelector("#pf2-maps-toggle");
    const mapsBody = mapPanel.querySelector("#pf2-maps-body");
    if (toggleBtn && mapsBody) {
      let expanded = false;
      toggleBtn.addEventListener("click", () => {
        expanded = !expanded;
        mapsBody.classList.toggle("is-open", expanded);
        toggleBtn.textContent = expanded ? "Masquer les cartes" : `Voir les ${allMaps.length} cartes`;
        toggleBtn.setAttribute("aria-expanded", String(expanded));
        const tbody = mapsBody.querySelector("tbody");
        if (tbody) tbody.innerHTML = (expanded ? allMaps : topMaps).map(mapRowHtml).join("");
      });
    }
  }

  // ── Animations au frame suivant (barres, sparkline) ──
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mount.querySelectorAll(".pf2-cat-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      mount.querySelectorAll(".pf2-week-fill").forEach((el) => {
        el.style.height = el.dataset.targetHeight + "%";
      });
      document.querySelectorAll(".pf2-goal-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      document.querySelectorAll(".pf2-level-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      document.querySelectorAll(".sparkline-path").forEach((el) => {
        el.style.strokeDashoffset = el.dataset.targetOffset || "0";
      });
    });
  });

  // ── Graphique hebdomadaire (points par semaine) ──
  if (window._profileWeekData) {
    setTimeout(() => renderWeeklyChart(), 100);
  }
}

/* ── Hook de debug (E2E / support) — même pattern que _lobbyDebug ── */
window._profileDebug = {
  showView,
  renderHero,
  renderPrecomputedStats,
  loadStats,
  renderWeeklyChart,
};
