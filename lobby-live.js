/**
 * lobby-live.js — v5.32 — Filtre des parties + alertes du lobby TheFrontHub.
 *
 * Module compagnon de lobby.js (qui publie l'event window « tfh:lobby:update »
 * à chaque snapshot/counts). v5.21 : le bandeau ne garde que l'essentiel.
 * v5.22 : filtre d'alerte + cartes. v5.28 : filtre OFFICIEL OpenFront
 * (DetailedGameViewFilters). v5.29 — LE FILTRE FILTRE VRAIMENT L'AFFICHAGE :
 *
 *   1. FILTRE (entonnoir)     → les parties qui cochent le filtre s'affichent
 *                              dans le lobby, les autres sont MASQUÉES
 *                              (sections + bandeau « prochaine partie »).
 *                              Le prédicat est exposé à lobby.js via
 *                              window.TFH_LOBBY_FILTER + event
 *                              « tfh:lobby:filter-changed » à chaque changement.
 *                              FILTRES (multi-sélections, vide = tout) :
 *                              • TYPE DE SALON   : FFA / Équipes / HvN
 *                              • SOURCE          : Public / Hébergé
 *                              • JOUEURS PAR ÉQ. : Duos / Trios / Quatuors
 *                              • NOMBRE D'ÉQUIPES: 2..8
 *                              • bornes min/max  : joueurs présents,
 *                                capacité, taille de l'équipe
 *                              • Masquer les salons vides + Réinitialiser
 *                              • PROFILS sauvegardés (max 20, comme OF)
 *                              • sélection de CARTES (atlas, vignettes ?v=2)
 *   2. ALERTE (optionnelle)   → au-dessus du filtre : son + notification
 *                              DÈS QU'UNE partie qui coche le filtre s'ouvre
 *                              (ou atteint « joueurs présents min »).
 *                              v5.29 : FIABILITÉ — plus de trou noir de 60 s :
 *                              les parties ouvertes en rafale sont regroupées
 *                              sur 5 s, puis CHAQUE lot sonne. Une partie qui
 *                              démarre vite n'absorbe plus l'alerte des autres.
 *                              Son plus long (~2 s, carillon 2×3 notes) et
 *                              plus fort (gain ×2). Au moment où on ACTIVE
 *                              l'alerte, les parties qui correspondent déjà
 *                              au filtre sonnent immédiatement (preuve que
 *                              ça marche), ensuite seules les NOUVELLES.
 *                              v5.30 : si l'alerte est activée AVANT l'arrivée
 *                              du 1er snapshot, l'annonce « preuve » part dès
 *                              que le flux arrive (trou noir supprimé).
 *   2bis. CLOCHE D'UNE CARTE   → v5.30 : « prévenir quand le lobby démarre »
 *                              et plus seulement quand il est PLEIN. v5.31 —
 *                              FIX « l'alerte ne marche pas » : le serveur
 *                              OpenFront RETIRE le salon de la liste DÈS QU'IL
 *                              est plein (phase Active, broadcast 500 ms) —
 *                              le client ne voit donc JAMAIS « n ≥ cap », et
 *                              l'ancien bip « plein » ne partait jamais ; pire,
 *                              une cloche posée sur une carte pleine (données
 *                              fraîches ou fallback) était ARMÉE À 0 puis
 *                              SUPPRIMÉE en silence au snapshot suivant.
 *                              Désormais :
 *                              • armement IMMÉDIAT et INCONDITIONNEL au clic ;
 *                              • PREUVE FULL : la partie était dans le snapshot
 *                              complet précédent et le snapshot complet
 *                              courant ne la contient plus → bip IMMÉDIAT
 *                              (le lobby a démarré) ;
 *                              • GARDE-FOU 1 s : les déclencheurs temporels
 *                              (compte à rebours, absence ≥ 15 s) tournent
 *                              même si AUCUNE frame n'arrive (horloge serveur
 *                              interpolée) — fini le bip « jamais ou 5 min
 *                              trop tard » quand le flux est calme ;
 *                              • startsAt OU autoStartAt (salons hébergés)
 *                              pris en compte pour le compte à rebours.
 *   3. Suivi « ma partie »    → clic sur une carte = tu lances la partie ;
 *                              dès que le flux voit qu'elle démarre, le chat
 *                              de la partie s'ouvre (lobby-chat.js).
 *   4. v5.32 — INTERRUPTEUR DU FILTRE : le filtre peut désormais être
 *                              ACTIVÉ ou DÉSACTIVÉ sans perdre sa
 *                              configuration (chips, bornes, cartes
 *                              conservées). Désactivé = TOUTES les parties
 *                              s'affichent (l'entonnoir se vide, le résumé
 *                              l'annonce) ; réactivé = les critères
 *                              sauvegardés re-filtrent l'affichage. La couche
 *                              ALERTE reste indépendante (son propre
 *                              interrupteur) : elle continue de surveiller
 *                              les critères enregistrés.
 *
 * Chargé en script autonome (IIFE, defer). Zéro dépendance.
 */
(function () {
  "use strict";

  /* ── i18n (même convention que lobby.js) ─────────────────────────────── */
  const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params) : fb);
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /* ── Constantes ──────────────────────────────────────────────────────── */
  const LS_ALERTS = "tfh_lobby_alerts_v3";      // v5.28 : filtre officiel OpenFront
  const LS_ALERTS_V2 = "tfh_lobby_alerts_v2";   // migration depuis l'ancien format
  const LS_ALERTS_V1 = "tfh_lobby_alerts_v1";   // (rétro-compat)
  const LS_PROFILES = "tfh_lobby_alert_profiles_v1"; // v5.28 : profils de filtres
  const MAX_PROFILES = 20;               // comme OpenFront (DetailedGameViewFilters)
  const MAX_PROFILE_NAME = 32;
  const LS_WATCH  = "tfh_lobby_watch_v1";
  const LS_MINE   = "tfh_lobby_mine_v1";      // parties que JE lance (chat auto)
  const WATCH_TTL       = 3 * 3600_000;       // une surveillance expire après 3 h
  const WATCH_GONE_MS   = 5 * 60_000;         // partie absente > 5 min → dé-surveillance
  const MINE_TTL        = 3 * 3600_000;       // suivi « ma partie » expire après 3 h
  const MINE_GONE_MS    = 8_000;              // absente d'un snapshot complet > 8 s → démarrée
  // v5.29 — FIABILITÉ DE L'ALERTE : l'ancien cooldown de 60 s créait un trou
  // noir — les parties ouvertes pendant le délai n'étaient annoncées QU'À LA
  // FIN du cooldown, et celles déjà lancées (les FFA partent vite) étaient
  // purement et simplement SUPPRIMÉES du lot → « l'alerte ne marche qu'une
  // fois ». Désormais : regroupement sur 5 s seulement, et AUCUNE alerte
  // détectée n'est jamais jetée — chaque lot déclenche le son.
  const NEW_ALERT_MERGE_MS = 5_000; // parties ouvertes en rafale → 1 son par lot de 5 s
  const ALERTED_MAX     = 400;          // plafond du Set de dédup session
  // v5.30 — cloche d'une carte : une partie surveillée qui quitte le flux
  // (lobby lancé) doit sonner. 15 s d'absence consécutive = elle a démarré
  // (les snapshots « full » reprennent tout l'état ; une seule frame perdue
  // ne déclenche donc pas de faux bip). Au-delà de WATCH_GONE_MS sans avoir
  // été vue « non pleine » dans la session → nettoyage silencieux (entrée
  // d'une session précédente : ne PAS sonner des heures après coup).
  const WATCH_GONE_START_MS = 15_000;
  // v5.31 — preuve « sortie de liste » sur snapshot complet : la frame full
  // précédente doit dater de moins de 10 s pour être considérée comme un flux
  // STABLE (une reconnexion / bascule proxy produit une frame full qui vient
  // d'un AUTRE serveur : sa liste peut différer → pas de bip sur cette base).
  const FULL_EVIDENCE_GAP_MS = 10_000;
  // v5.31 — garde-fou : les déclencheurs temporels (compte à rebours, absence)
  // tournent chaque seconde même si AUCUNE frame n'arrive.
  const WATCHDOG_TICK_MS = 1_000;
  // v5.30 — alias wire → atlas : l'enum wire « Tourney 2 Teams » slugifie en
  // « tourney2teams » alors que la clé atlas (vignettes + sélecteur) est
  // « tourney1 ». Sans la table, sélectionner une carte Tourney filtrait
  // TOUT (aucune partie affichée, aucune alerte).
  const MAP_SLUG_ALIASES = {
    tourney2teams: "tourney1",
    tourney3teams: "tourney2",
    tourney4teams: "tourney3",
    tourney8teams: "tourney4",
  };
  const MODES = ["ffa", "team", "special"];

  /* ── État persistant ─────────────────────────────────────────────────── */
  const load = (k, fb) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; }
    catch { return fb; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

  // v5.28 — modèle de filtres OFFICIEL OpenFront (DetailedGameViewFilters.ts) :
  // tableaux vides = aucune restriction ; bornes null = aucune restriction.
  const DEFAULT_FILTERS = {
    enabled: false, maps: [],
    modes: [],        // "ffa" | "teams" | "hvn"
    sources: [],      // "public" | "hosted"
    teamConfigs: [],  // "Duos" | "Trios" | "Quads" | "2".."8" (valeurs officielles)
    hideEmpty: false,
    minJoined: null, maxJoined: null,
    minCapacity: null, maxCapacity: null,
    minTeamSize: null, maxTeamSize: null,
    // v5.32 — interrupteur du filtre : true = les critères filtrent
    // l'affichage ; false = suspendu (tout s'affiche, critères conservés).
    // Absent (anciens builds) → true (rétro-compat : le filtrage existant
    // ne doit pas disparaître après la mise à jour).
    filterOn: true,
  };

  // Migration douce : v1/v2 (enabled/mode/minPlayers/maps/compact/ranked) → v3
  let _alertStore = load(LS_ALERTS, null);
  if (!_alertStore) {
    const v2 = load(LS_ALERTS_V2, null) || load(LS_ALERTS_V1, null);
    if (v2 && typeof v2 === "object") _alertStore = v2;
  }
  const settings = Object.assign({}, DEFAULT_FILTERS, _alertStore || {});
  if (_alertStore) {
    if ((!Array.isArray(settings.modes) || !settings.modes.length) && settings.mode === "ffa") settings.modes = ["ffa"];
    if ((!Array.isArray(settings.modes) || !settings.modes.length) && settings.mode === "team") settings.modes = ["teams", "hvn"];
    if (settings.minJoined == null && Number(settings.minPlayers) > 0) settings.minJoined = Math.round(Number(settings.minPlayers));
  }
  delete settings.mode; delete settings.minPlayers; delete settings.compact; delete settings.ranked; // clés v1/v2
  if (!Array.isArray(settings.maps)) settings.maps = [];
  // v5.32 — l'interrupteur du filtre : absent/false→booléen strict. Les
  // anciens builds n'avaient pas la clé = filtre actif dès qu'un critère
  // existait → undefined DOIT valoir true (sinon le filtrage existant
  // disparaîtrait silencieusement après la mise à jour).
  settings.filterOn = settings.filterOn !== false;
  for (const k of ["modes", "sources", "teamConfigs"]) if (!Array.isArray(settings[k])) settings[k] = [];
  for (const k of ["minJoined", "maxJoined", "minCapacity", "maxCapacity", "minTeamSize", "maxTeamSize"]) {
    // NB : Number(null) === 0 → test explicite de null/"" avant conversion
    const v = settings[k];
    if (v == null || v === "") { settings[k] = null; continue; }
    const n = Number(v);
    settings[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  let watch   = load(LS_WATCH, {});       // { gameId: { map, mode, addedAt, lastSeen } }
  for (const w of Object.values(watch)) w.armedAt = 0; // ré-armé par session (anti re-bip au rechargement)
  let mine    = load(LS_MINE, {});        // { gameId: { map, addedAt, lastSeen } }
  const firedFull = new Set();            // ids déjà notifiés « pleine » (session)
  let seenIds = null;                     // ids du snapshot complet précédent (détection nouvelles)
  // v5.20.1 — état anti-spam des alertes « nouvelles parties »
  let pendingFresh = [];                  // alertes en attente du flush (regroupées)
  let newAlertTimer = null;               // flush programmé à la fin du cooldown
  let lastNewAlert = 0;                   // ts du dernier bip « nouvelles parties »
  let alertedIds = new Set();             // une partie n'alerte JAMAIS 2 fois par session
  let lastCounts = new Map();             // id → numClients au passage précédent (détection de seuil)
  // v5.31 — horloge serveur interpolée + datation de la dernière frame full
  // (le bip « sortie de liste » immédiat exige un flux complet STABLE).
  let lastServerNow = 0;
  let lastServerNowAt = 0;
  let lastFullAt = 0;
  // v5.30 — alerte activée avant l'arrivée du 1er snapshot : l'annonce « preuve »
  // (parties qui cochent DÉJÀ le filtre) doit partir au 1er « full », sinon les
  // parties présentes à cet instant ne sonneraient JAMAIS.
  let announceOnFirstSnapshot = false;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let strip = null;
  let els = {};

  /* ══════════════════════════════════════════════════════════════════════
     Son (WebAudio — carillon 2×3 notes, plus LONG et plus FORT en v5.29)
     ══════════════════════════════════════════════════════════════════════ */

  let audioCtx = null;
  function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch { return null; }
  }

  function beep() {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      // v5.29 — carillon plus long (~2,1 s au total) et plus fort :
      // 2 répétitions de 3 notes ascendantes (G5 → Do6 → Mi6), octave
      // basse en triangle pour la richesse, gain crête 0,32 (≈ +6 dB vs
      // l'ancien 0,16). Les FFA partent vite : le son doit se faire entendre.
      const NOTES = [[784, 0.00, 0.34], [1046.5, 0.30, 0.38], [1318.5, 0.60, 0.62]];
      const PEAK = 0.32;
      const t0 = ctx.currentTime + 0.02;
      for (const rep of [0, 1]) {
        const base = t0 + rep * 1.15;
        for (const [freq, off, dur] of NOTES) {
          const osc = ctx.createOscillator();
          const sub = ctx.createOscillator();
          const gain = ctx.createGain();
          const subGain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          sub.type = "triangle";
          sub.frequency.value = freq / 2;
          subGain.gain.value = 0.45;
          gain.gain.setValueAtTime(0.0001, base + off);
          gain.gain.exponentialRampToValueAtTime(PEAK, base + off + 0.03);
          gain.gain.setValueAtTime(PEAK, base + off + Math.max(0.03, dur * 0.55));
          gain.gain.exponentialRampToValueAtTime(0.0001, base + off + dur);
          osc.connect(gain);
          sub.connect(subGain).connect(gain);
          gain.connect(ctx.destination);
          osc.start(base + off); sub.start(base + off);
          osc.stop(base + off + dur + 0.05); sub.stop(base + off + dur + 0.05);
        }
      }
    } catch { /* audio indisponible : silencieux */ }
  }

  /* ══════════════════════════════════════════════════════════════════════
     Alertes — notifications + moteur
     ══════════════════════════════════════════════════════════════════════ */

  function notify(title, body, tag) {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(title, { body, tag, icon: "favicon-180x180.png" });
        setTimeout(() => { try { n.close(); } catch { /* ignore */ } }, 10_000);
      }
    } catch { /* ignore */ }
    window.showToast?.(title + (body ? " — " + body : ""), "info", 7000, "bell");
  }

  function gameLabel(g) {
    const cfg = g.gameConfig || {};
    return String(cfg.gameMap || "?").slice(0, 24);
  }

  /** Slug de map (même règle que lobby.js mapSlug — copie locale, zéro dépendance).
   *  v5.30 : + alias Tourney (enum wire « Tourney 2 Teams » → clé atlas tourney1). */
  function mapSlugOf(mapName) {
    const s = typeof mapName === "string"
      ? mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "")
      : "";
    return MAP_SLUG_ALIASES[s] || s;
  }

  /* ── v5.28 — FAITS + FILTRE OFFICIEL (port de DetailedGameViewFilters.ts) ── */

  /** Format d'équipe nommé → taille (constantes officielles OpenFront). */
  const NAMED_TEAM_SIZES = { duos: 2, trios: 3, quads: 4, quatuors: 4 };
  const NAMED_TEAM_CONFIG = { duos: "Duos", trios: "Trios", quads: "Quads", quatuors: "Quads" };

  /** Valeurs officielles Game.ts : GameMode.FFA = "Free For All", Team = "Team",
   *  HumansVsNations = "Humans Vs Nations". */
  function isHvNValue(v) {
    return typeof v === "string" && v.trim().toLowerCase() === "humans vs nations";
  }

  /** Chaque dérivable d'un lobby pour filtrer/afficher (cf. lobbyFacts officiel). */
  function lobbyFacts(g) {
    const cfg = g.gameConfig || {};
    const capacity = Number(cfg.maxPlayers) > 0 ? Number(cfg.maxPlayers) : null;
    const joined = Number(g.numClients) || 0;
    const source = g.publicGameType === "hosted" ? "hosted" : "public";
    const pt = cfg.playerTeams;
    const teamMode = cfg.gameMode === "Team" || g.__tfhBucket === "team";

    if (!teamMode) {
      return { mode: "ffa", source, joined, capacity, teamConfig: null, teamCount: null, teamSize: null };
    }
    if (isHvNValue(pt)) {
      return { mode: "hvn", source, joined, capacity, teamConfig: null, teamCount: null, teamSize: null };
    }
    if (typeof pt === "number" && pt > 0) {
      return {
        mode: "teams", source, joined, capacity,
        teamConfig: String(pt), teamCount: pt,
        teamSize: capacity !== null ? Math.floor(capacity / pt) : null,
      };
    }
    if (typeof pt === "string") {
      const key = pt.trim().toLowerCase();
      const size = NAMED_TEAM_SIZES[key];
      if (size !== undefined) {
        return {
          mode: "teams", source, joined, capacity,
          teamConfig: NAMED_TEAM_CONFIG[key], teamSize: size,
          teamCount: capacity !== null ? Math.floor(capacity / size) : null,
        };
      }
    }
    return { mode: "teams", source, joined, capacity, teamConfig: null, teamCount: null, teamSize: null };
  }

  /** Une borne active exclut les lobbies qui n'affichent pas la valeur
   *  (comportement officiel : pas de passe-droite silencieux). */
  function withinRange(value, min, max) {
    if (min == null && max == null) return true;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
  }

  /** Une partie passe-t-elle TOUS les filtres (modèle officiel + cartes) ?
   *  `bucket` (optionnel) : section lobby.js d'origine (ffa/team/special) —
   *  sert à annoter la partie si le moteur d'alertes ne l'a pas encore vue. */
  function matchesFilters(g, bucket) {
    if (bucket && !g.__tfhBucket) g.__tfhBucket = bucket;
    const facts = lobbyFacts(g);
    if (settings.modes.length > 0 && !settings.modes.includes(facts.mode)) return false;
    if (settings.sources.length > 0 && !settings.sources.includes(facts.source)) return false;
    if (settings.teamConfigs.length > 0) {
      if (facts.teamConfig === null) return false;
      if (!settings.teamConfigs.includes(facts.teamConfig)) return false;
    }
    if (settings.hideEmpty && facts.joined === 0) return false;
    if (!withinRange(facts.joined, settings.minJoined, settings.maxJoined)) return false;
    if (!withinRange(facts.capacity, settings.minCapacity, settings.maxCapacity)) return false;
    if (!withinRange(facts.teamSize, settings.minTeamSize, settings.maxTeamSize)) return false;
    // Cartes (sélection multiple — vide = toutes)
    const sel = Array.isArray(settings.maps) ? settings.maps : [];
    if (sel.length && !sel.includes(mapSlugOf((g.gameConfig || {}).gameMap))) return false;
    return true;
  }

  /** Au moins UN critère de filtre actif ? (dès qu'un critère est posé, le
   *  lobby n'affiche PLUS que les parties qui le cochent — v5.29). */
  function hasActiveCriteria(s) {
    const f = s || settings;
    return !!(
      (Array.isArray(f.modes) && f.modes.length) ||
      (Array.isArray(f.sources) && f.sources.length) ||
      (Array.isArray(f.teamConfigs) && f.teamConfigs.length) ||
      f.hideEmpty === true ||
      (Array.isArray(f.maps) && f.maps.length) ||
      f.minJoined != null || f.maxJoined != null ||
      f.minCapacity != null || f.maxCapacity != null ||
      f.minTeamSize != null || f.maxTeamSize != null
    );
  }

  /* ── v5.29 — PONT VERS LOBBY.JS : le filtre filtre l'AFFICHAGE ──────────
   *  lobby.js consulte window.TFH_LOBBY_FILTER à chaque rendu : les parties
   *  qui cochent le filtre s'affichent, les autres sont masquées. Chaque
   *  changement de filtre (chips, bornes, cartes, profil, reset) émet
   *  « tfh:lobby:filter-changed » → re-rendu immédiat de la liste. */
  window.TFH_LOBBY_FILTER = {
    // v5.32 — le filtre ne s'applique que si l'interrupteur est ON et qu'au
    // moins un critère est posé. OFF = lobby.js affiche TOUT (critères
    // conservés pour une réactivation sans reconfiguration).
    active: () => settings.filterOn !== false && hasActiveCriteria(),
    matches: (g, bucket) => matchesFilters(g, bucket),
  };

  /** Persiste `settings` + répercute partout (UI, résumé, lobby.js). */
  function commitFilters() {
    save(LS_ALERTS, settings);
    syncFilterUI();
    updateMapsSummary();
    updateFilterSummary();
    renderBell(); // v5.29 : l'entonnoir se remplit/ se vide selon le filtre
    try { window.dispatchEvent(new CustomEvent("tfh:lobby:filter-changed", {})); } catch { /* ignore */ }
  }

  /** v5.32 — interrupteur du filtre (ON/OFF sans perdre la configuration).
   *  OFF : TOUTES les parties s'affichent, l'entonnoir se vide, les critères
   *  restent enregistrés ; ON : les critères re-filtrent l'affichage. La
   *  couche alerte (settings.enabled) est INDÉPENDANTE et continue de
   *  surveiller les critères enregistrés. */
  function setFilterOn(on) {
    settings.filterOn = on !== false;
    save(LS_ALERTS, settings);
    commitFilters();
    window.showToast?.(settings.filterOn
      ? T("lobby.filter_on_toast", "Filtre activé", {})
      : T("lobby.filter_off_toast", "Filtre désactivé — toutes les parties s'affichent", {}),
      settings.filterOn ? "success" : "info", 3000);
  }

  function annotateBuckets(games) {
    for (const k of MODES) for (const g of games[k] || []) g.__tfhBucket = k;
  }

  function findGameById(games, id) {
    for (const k of MODES) {
      const found = (games[k] || []).find((g) => String(g.gameID || g.id) === String(id));
      if (found) return found;
    }
    return null;
  }

  function allGames(games) {
    return [...(games.ffa || []), ...(games.team || []), ...(games.special || [])];
  }

  /* ══════════════════════════════════════════════════════════════════════
     Suivi « ma partie » — le joueur clique une carte pour lancer sa partie ;
     dès que le flux voit qu'elle démarre, on ouvre le chat de la partie.
     ══════════════════════════════════════════════════════════════════════ */

  window.addEventListener("tfh:lobby:my-game", (e) => {
    const d = e.detail || {};
    const id = d.gameId;
    if (!id) return;
    mine[id] = { map: String(d.map || ""), addedAt: Date.now(), lastSeen: Date.now() };
    save(LS_MINE, mine);
  });

  function fireMyGameStarted(id, g, reason) {
    const map = (g && gameLabel(g)) || (mine[id] && mine[id].map) || "";
    delete mine[id];
    save(LS_MINE, mine);
    beep();
    notify(
      T("lobby.mygame_title", "Ta partie démarre ! 🎮"),
      T("lobby.mygame_body", "Le chat de la partie est ouvert — les inscrits qui la rejoignent arrivent dans le salon."),
      "tfh-mygame-" + id
    );
    window.dispatchEvent(new CustomEvent("tfh:lobby:my-game-started", {
      detail: { gameId: id, map, reason },
    }));
  }

  /* ── v5.20.1 : regroupement + cooldown des alertes « nouvelles parties » ── */

  /** Pousse une alerte candidate dans la file d'attente (si alertes actives). */
  function queueFreshAlert(g, id) {
    alertedIds.add(id);
    if (!settings.enabled) return; // alertes coupées : on n'accumule rien
    pendingFresh.push({ id, map: gameLabel(g), mode: modeLabelOf(g), n: Number(g.numClients) || 0 });
    if (pendingFresh.length > 30) pendingFresh.shift(); // garde-fou mémoire
  }

  /** Émet AU PLUS UN son + une notification agrégée par lot de 5 s.
   *  v5.29 : plus JAMAIS de suppression — une partie détectée est annoncée
   *  même si elle a déjà démarré entre-temps (les FFA partent en quelques
  *  secondes : l'info reste utile, et c'est LA plainte n°1 du proprio). */
  function flushNewAlerts(force) {
    if (newAlertTimer) { clearTimeout(newAlertTimer); newAlertTimer = null; }
    if (!pendingFresh.length) return;
    if (!settings.enabled) { pendingFresh = []; return; }
    if (!force) {
      const wait = NEW_ALERT_MERGE_MS - (Date.now() - lastNewAlert);
      if (wait > 0) {
        // Rafale en cours : on garde en attente, flush à la fin de la fenêtre.
        newAlertTimer = setTimeout(flushNewAlerts, wait + 50);
        return;
      }
    }
    const batch = pendingFresh;
    pendingFresh = [];
    lastNewAlert = Date.now();
    beep();
    const g0 = batch[0];
    const extra = batch.length - 1;
    notify(
      extra > 0
        ? T("lobby.alert_new_many_title", `${batch.length} nouvelles parties ! 🎮`, { n: batch.length })
        : T("lobby.alert_new_title", "Nouvelle partie ! 🎮"),
      T("lobby.alert_new_body", `${g0.map} vient de s'ouvrir`, { map: g0.map }) +
        (extra > 0 ? " " + T("lobby.alert_new_extra", `(+${extra} autre${extra > 1 ? "s" : ""})`, { n: extra }) : ""),
      "tfh-new-" + g0.id
    );
  }

  /** v5.29 — au moment où on ACTIVE l'alerte (ou qu'on applique un profil) :
   *  les parties qui correspondent DÉJÀ au filtre sonnent immédiatement —
   *  l'utilisateur voit/entend tout de suite que la chaîne filtre→alerte
   *  fonctionne. Une seule notification agrégée, sans attendre 5 s. */
  function announceCurrentMatches() {
    if (!settings.enabled) return;
    const matching = allGames(currentGames).filter((g) => matchesFilters(g));
    if (!matching.length) return;
    for (const g of matching) {
      const id = String(g.gameID || g.id);
      if (!alertedIds.has(id)) queueFreshAlert(g, id);
    }
    flushNewAlerts(true);
  }

  function runMyGameEngine(detail) {
    const games = detail.games || {};
    const ids = Object.keys(mine);
    if (!ids.length) return;
    let dirty = false;
    const now = Date.now();
    // v5.20.1 : startsAt est en horloge SERVEUR — compare avec l'heure serveur
    // (publiée par lobby.js), pas l'horloge du navigateur (décalage possible).
    const sNow = Number(detail.serverNow) > 0 ? Number(detail.serverNow) : now;
    for (const id of ids) {
      const m = mine[id];
      if (!m) continue;
      if (now - (m.addedAt || now) > MINE_TTL) { delete mine[id]; dirty = true; continue; }
      const g = findGameById(games, id);
      if (g) {
        m.lastSeen = now;
        const cap = Number((g.gameConfig || {}).maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        // OpenFront lance automatiquement un lobby public dès qu'il est plein
        // (et le RETIRE aussitôt de la liste — v5.31), ou quand le compte à
        // rebours (startsAt / autoStartAt) tombe à zéro.
        const effStart = Number(g.startsAt) || Number(g.autoStartAt) || 0;
        if (cap > 0 && n >= cap) { dirty = true; fireMyGameStarted(id, g, "full"); }
        else if (effStart > 0 && effStart <= sNow + 1500) { dirty = true; fireMyGameStarted(id, g, "countdown"); }
      } else if (now - (m.lastSeen || m.addedAt) > MINE_GONE_MS) {
        // Plus vue depuis > 8 s (sur N'IMPORTE QUEL événement — les counts
        // patchent les parties existantes, ils ne retirent jamais une partie
        // de la liste) → le lobby a démarré (il quitte la liste) ou s'est
        // terminé. On ouvre le chat : le salon reste utile dans les deux cas.
        dirty = true;
        fireMyGameStarted(id, null, "gone");
      }
    }
    if (dirty) save(LS_MINE, mine);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Moteur d'alertes
     ══════════════════════════════════════════════════════════════════════ */

  function runAlertEngine(detail) {
    const games = detail.games || {};
    annotateBuckets(games);
    const now = Date.now();
    // startsAt est en horloge SERVEUR : on utilise l'horloge publiée par
    // lobby.js, sinon l'horloge serveur interpolée localement (v5.31 — le
    // garde-fou 1 s tourne même sans frame, la comparaison doit rester juste).
    const sNow = Number(detail.serverNow) > 0 ? Number(detail.serverNow)
      : (lastServerNow > 0 ? lastServerNow + (now - lastServerNowAt) : now);

    // 1) Surveillances (cloche d'une carte) : pleine ? démarre ? disparue ?
    //    Quatre déclencheurs sonnent (v5.31) :
    //      a) lobby PLEIN vu dans le flux (transitoire — 1 bip/session) ;
    //      b) startsAt/autoStartAt atteint (auto-start au compte à rebours) ;
    //      c) SORTIE DE LISTE sur snapshot complet (preuve immédiate) ;
    //      d) partie absente ≥ 15 s (secours temporel, flux calme).
    //    detail.fullEvidence : le snapshot complet courant est non vide et la
    //    frame full précédente datait de < 10 s (flux stable) — voir onUpdate.
    let watchDirty = false;
    for (const id of Object.keys(watch)) {
      const w = watch[id];
      const g = findGameById(games, id);
      if (g) {
        w.lastSeen = now;
        const cap = Number((g.gameConfig || {}).maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        // v5.31 — heure de lancement EFFECTIVE : startsAt (salons programmés)
        // sinon autoStartAt (salons hébergés, échéance de lancement auto).
        const startsAt = Number(g.startsAt) || Number(g.autoStartAt) || 0;
        if (cap > 0 && n >= cap) {
          // v5.31 — vu PLEINE dans le flux (transitoire < 1 s côté serveur,
          // ou snapshot fallback en retard) : on sonne UNE FOIS par session
          // (firedFull), ARMÉE OU PAS — l'entrée restaurée après rechargement
          // correspond à un lobby réellement plein = en train de démarrer.
          if (!firedFull.has(id)) {
            firedFull.add(id);
            beep();
            notify(
              T("lobby.alert_full_title", "Lobby plein ! 🔔"),
              T("lobby.alert_full_body", `${gameLabel(g)} est complète (${n}/${cap}) — file rejoindre !`, { map: gameLabel(g), n, cap }),
              "tfh-full-" + id
            );
          }
          delete watch[id]; // pleine (sonnée ou pas) : plus rien à surveiller
          watchDirty = true;
        } else if (startsAt > 0 && startsAt <= sNow + 1500) {
          // Le compte à rebours touche à sa fin : le lobby démarre
          // MAINTENANT (plein ou pas). On sonne et on dé-surveille.
          firedFull.add(id);
          delete watch[id];
          watchDirty = true;
          beep();
          notify(
            T("lobby.alert_start_title", "Le lobby démarre ! 🎮"),
            T("lobby.alert_start_body", `${gameLabel(g)} vient de lancer la partie — file rejoindre !`, { map: gameLabel(g) }),
            "tfh-start-" + id
          );
        } else if (!w.armedAt) {
          w.armedAt = now; // vue non pleine → alerte armée pour cette session
          watchDirty = true;
        }
      } else {
        const absentFor = now - (w.lastSeen || 0);
        // v5.31 — la partie a QUITTÉ la liste : c'est ÇA, le lancement réel.
        //   a) PREUVE FULL (IMMÉDIAT) : le snapshot complet précédent la
        //      contenait et le snapshot complet courant ne la contient plus
        //      (flux stable + snapshot non vide) → bip TOUT DE SUITE.
        //      C'est le cas « lobby plein → partie lancée » : côté serveur le
        //      salon est RETIRÉ de la liste dès qu'il est plein — le client
        //      ne voit jamais « n ≥ cap ».
        //   b) PREUVE TEMPORELLE (secours) : armée et absente depuis 15 s à
        //      5 min → bip (frames complètes rares : fallback HTTP, flux calme).
        const leftFullList =
          detail.fullEvidence &&
          seenIds !== null && seenIds.has(id) &&
          absentFor <= WATCH_GONE_MS;
        const goneAwhile =
          w.armedAt > 0 &&
          absentFor >= WATCH_GONE_START_MS &&
          absentFor <= WATCH_GONE_MS &&
          now - (w.addedAt || now) <= WATCH_TTL;
        if (leftFullList || goneAwhile) {
          firedFull.add(id);
          delete watch[id];
          watchDirty = true;
          beep();
          notify(
            T("lobby.alert_start_title", "Le lobby démarre ! 🎮"),
            T("lobby.alert_start_body", `${w.map || "Le lobby"} vient de lancer la partie — file rejoindre !`, { map: w.map || "Le lobby" }),
            "tfh-start-" + id
          );
        } else if (now - (w.lastSeen || w.addedAt || now) > WATCH_GONE_MS) {
          delete watch[id]; // partie terminée / entrée d'une session précédente
          watchDirty = true;
        } else if (now - (w.addedAt || now) > WATCH_TTL) {
          delete watch[id]; // expiration douce
          watchDirty = true;
        }
      }
    }
    if (watchDirty) { save(LS_WATCH, watch); renderWatchList(); }
    syncCardBells();

    // 1bis) Suivi « ma partie » (le tick 1 s le fait aussi tourner — v5.31)
    runMyGameEngine({ games, serverNow: sNow });

    // 2) Alertes « nouvelles parties » — fiable (v5.29) :
    //      • une partie ne déclenche AU PLUS UNE alerte par session ;
    //      • déclencheurs : création d'une partie qui passe les filtres, OU
    //        franchissement du seuil « joueurs min. » (de < min à ≥ min) ;
    //      • regroupement : les parties ouvertes en rafale (même fenêtre de
    //        5 s) font UN son agrégé — mais AUCUNE n'est jamais jetée.
    const prevSeen = seenIds;
    if (detail.full) {
      seenIds = new Set(allGames(games).map((g) => String(g.gameID || g.id)));
      for (const k of lastCounts.keys()) if (!seenIds.has(k)) lastCounts.delete(k);
    }
    // v5.28 : seuil « joueurs présents min » du filtre officiel (bornes min/max)
    const wantMin = Math.max(0, Math.round(Number(settings.minJoined) || 0));
    // v5.30 — annonce différée : l'alerte a été activée avant le 1er snapshot.
    if (detail.full && announceOnFirstSnapshot && settings.enabled) {
      announceOnFirstSnapshot = false;
      announceCurrentMatches();
    }
    for (const g of allGames(games)) {
      const id = String(g.gameID || g.id);
      const n = Number(g.numClients) || 0;
      const prevN = lastCounts.get(id);
      lastCounts.set(id, n);
      if (alertedIds.has(id) || !matchesFilters(g)) continue;
      const isNew = !!(detail.full && prevSeen && !prevSeen.has(id));
      const crossed = wantMin > 0 && prevN !== undefined && prevN < wantMin && n >= wantMin;
      if ((isNew || crossed) && n >= wantMin) queueFreshAlert(g, id);
    }
    if (alertedIds.size > ALERTED_MAX) {
      alertedIds = new Set([...alertedIds].slice(-ALERTED_MAX / 2));
    }
    flushNewAlerts();
  }

  function modeLabelOf(g) {
    const cfg = g.gameConfig || {};
    if (g.__tfhBucket === "special") return T("lobby.sec_special", "Spécial");
    if (cfg.rankedType) return cfg.rankedType === "2v2" ? T("lobby.ranked_2v2", "Classé 2v2") : T("lobby.ranked_1v1", "Classé 1v1");
    return g.__tfhBucket === "team" ? T("lobby.filter_team", "Team") : T("lobby.filter_ffa", "FFA");
  }

  /* ══════════════════════════════════════════════════════════════════════
     UI — construction du bandeau alertes (v5.21 : compteur « Parties
     analysées », stats des cartes, chips de mode et courbe « Joueurs dans
     le lobby » retirés sur demande du propriétaire — ne reste que les
     alertes, discrètes, en haut des cartes)
     ══════════════════════════════════════════════════════════════════════ */

  /** v5.29 — entonnoir : la tuile s'appelle « Filtre » (c'est d'abord un
   *  filtre d'affichage ; l'alerte est une couche activable par-dessus). */
  const funnelSvg = (active) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="${active ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;

  function buildStrip() {
    const viewEl = document.getElementById("lobby-view");
    if (!viewEl || document.getElementById("lobby-live-strip")) return;

    strip = document.createElement("section");
    strip.id = "lobby-live-strip";
    strip.className = "llive-strip";
    strip.setAttribute("aria-label", T("lobby.alert_title", "Filtre des parties"));
    strip.innerHTML = `
      <div class="llive-row">
        <div class="llive-tile llive-tile-bell">
          <button type="button" class="llive-bell" data-role="ll-bell" aria-expanded="false"
                  title="${esc(T("lobby.alert_title", "Filtre des parties"))}" aria-label="${esc(T("lobby.alert_title", "Filtre des parties"))}">
            ${funnelSvg(false)}
            <span class="llive-bell-badge" data-role="ll-badge" hidden>0</span>
          </button>
          <span class="llive-tile-label">${esc(T("lobby.alert_tile_label", "Filtre"))}</span>
        </div>
      </div>
      <div class="llive-panel" data-role="ll-panel" hidden>
        <!-- v5.29 — entête : le panneau s'appelle FILTRE, l'alerte est une
             couche en bas. Le résumé dit combien de parties sont masquées. -->
        <div class="llive-head">
          <span class="llive-head-title">${esc(T("lobby.f_panel_title", "Filtre des parties"))}</span>
          <span class="llive-summary" data-role="ll-filter-summary"></span>
        </div>
        <!-- v5.32 — INTERRUPTEUR DU FILTRE : ON = les critères filtrent
             l'affichage ; OFF = tout s'affiche, la configuration (chips,
             bornes, cartes) est CONSERVÉE pour une réactivation immédiate. -->
        <div class="llive-filter-line">
          <label class="llive-toggle">
            <input type="checkbox" data-role="ll-filter-on">
            <span class="llive-toggle-track" aria-hidden="true"></span>
            <span>${esc(T("lobby.filter_enable", "Filtre activé — masque les parties hors filtre"))}</span>
          </label>
        </div>
        <!-- filtre OFFICIEL OpenFront (cf. DetailedGameViewModal) -->
        <div class="llive-filters">
          <div class="llive-frow">
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_room_type", "Type de salon"))}</legend>
              <div class="llive-chips" data-role="ll-modes" role="group"
                   aria-label="${esc(T("lobby.f_room_type", "Type de salon"))}">
                <button type="button" data-v="ffa" aria-pressed="false">${esc(T("lobby.f_ffa", "Chacun pour soi"))}</button>
                <button type="button" data-v="teams" aria-pressed="false">${esc(T("lobby.f_teams", "Équipes"))}</button>
                <button type="button" data-v="hvn" aria-pressed="false">${esc(T("lobby.f_hvn", "Humains vs Nations"))}</button>
              </div>
            </fieldset>
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_source", "Source"))}</legend>
              <div class="llive-chips" data-role="ll-sources" role="group"
                   aria-label="${esc(T("lobby.f_source", "Source"))}">
                <button type="button" data-v="public" aria-pressed="false">${esc(T("lobby.f_public", "Public"))}</button>
                <button type="button" data-v="hosted" aria-pressed="false">${esc(T("lobby.f_hosted", "Hébergé"))}</button>
              </div>
            </fieldset>
          </div>
          <div class="llive-frow">
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_players_per_team", "Joueurs par équipe"))}</legend>
              <div class="llive-chips" data-role="ll-named" role="group"
                   aria-label="${esc(T("lobby.f_players_per_team", "Joueurs par équipe"))}">
                <button type="button" data-v="Duos" aria-pressed="false">${esc(T("lobby.f_duos", "Duos"))}</button>
                <button type="button" data-v="Trios" aria-pressed="false">${esc(T("lobby.f_trios", "Trios"))}</button>
                <button type="button" data-v="Quads" aria-pressed="false">${esc(T("lobby.f_quads", "Quatuors"))}</button>
              </div>
            </fieldset>
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_team_count", "Nombre d'équipes"))}</legend>
              <div class="llive-chips llive-chips-num" data-role="ll-counts" role="group"
                   aria-label="${esc(T("lobby.f_team_count", "Nombre d'équipes"))}">
                ${[2,3,4,5,6,7,8].map((n) => `<button type="button" data-v="${n}" aria-pressed="false">${n}</button>`).join("")}
              </div>
            </fieldset>
          </div>
          <div class="llive-frow llive-frow-ranges">
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_joined", "Joueurs présents"))}</legend>
              <div class="llive-range">
                <input type="number" min="0" max="300" inputmode="numeric" placeholder="${esc(T("lobby.f_min", "Min"))}"
                       data-role="ll-min-joined" aria-label="${esc(T("lobby.f_joined_min_aria", "Joueurs présents minimum"))}">
                <span aria-hidden="true">–</span>
                <input type="number" min="0" max="300" inputmode="numeric" placeholder="${esc(T("lobby.f_max", "Max"))}"
                       data-role="ll-max-joined" aria-label="${esc(T("lobby.f_joined_max_aria", "Joueurs présents maximum"))}">
              </div>
            </fieldset>
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_capacity", "Capacité"))}</legend>
              <div class="llive-range">
                <input type="number" min="0" max="300" inputmode="numeric" placeholder="${esc(T("lobby.f_min", "Min"))}"
                       data-role="ll-min-capacity" aria-label="${esc(T("lobby.f_capacity_min_aria", "Capacité minimum"))}">
                <span aria-hidden="true">–</span>
                <input type="number" min="0" max="300" inputmode="numeric" placeholder="${esc(T("lobby.f_max", "Max"))}"
                       data-role="ll-max-capacity" aria-label="${esc(T("lobby.f_capacity_max_aria", "Capacité maximum"))}">
              </div>
            </fieldset>
            <fieldset class="llive-field">
              <legend>${esc(T("lobby.f_team_size", "Taille de l'équipe"))}</legend>
              <div class="llive-range">
                <input type="number" min="0" max="100" inputmode="numeric" placeholder="${esc(T("lobby.f_min", "Min"))}"
                       data-role="ll-min-teamsize" aria-label="${esc(T("lobby.f_team_size_min_aria", "Taille d'équipe minimum"))}">
                <span aria-hidden="true">–</span>
                <input type="number" min="0" max="100" inputmode="numeric" placeholder="${esc(T("lobby.f_max", "Max"))}"
                       data-role="ll-max-teamsize" aria-label="${esc(T("lobby.f_team_size_max_aria", "Taille d'équipe maximum"))}">
              </div>
            </fieldset>
          </div>
          <div class="llive-frow llive-frow-tail">
            <label class="llive-check">
              <input type="checkbox" data-role="ll-hideempty">
              <span>${esc(T("lobby.f_hide_empty", "Masquer les salons vides"))}</span>
            </label>
            <button type="button" class="llive-reset" data-role="ll-reset">${esc(T("lobby.f_reset", "Réinitialiser"))}</button>
          </div>
        </div>
        <div class="llive-maps">
          <div class="llive-maps-head">
            <span class="llive-maps-label">${esc(T("lobby.alert_maps", "Cartes"))}</span>
            <span class="llive-maps-summary" data-role="ll-maps-summary"></span>
            <button type="button" class="llive-maps-toggle" data-role="ll-maps-toggle"
                    aria-expanded="false">${esc(T("lobby.alert_maps_toggle", "Choisir…"))}</button>
          </div>
          <div class="llive-maps-body" data-role="ll-maps-body" hidden>
            <input type="search" class="llive-maps-search" data-role="ll-maps-search"
                   placeholder="${esc(T("lobby.alert_maps_search", "Rechercher une carte…"))}"
                   aria-label="${esc(T("lobby.alert_maps_search", "Rechercher une carte…"))}">
            <div class="llive-maps-actions">
              <button type="button" data-role="ll-maps-all">${esc(T("lobby.alert_maps_select_all", "Toutes"))}</button>
              <button type="button" data-role="ll-maps-none">${esc(T("lobby.alert_maps_clear", "Aucune"))}</button>
            </div>
            <div class="llive-maps-list" data-role="ll-maps-list" role="group"
                 aria-label="${esc(T("lobby.alert_maps", "Cartes à surveiller"))}"></div>
          </div>
        </div>
        <div class="llive-profiles">
          <span class="llive-maps-label">${esc(T("lobby.f_profiles", "Profils"))}</span>
          <select data-role="ll-prof-select" aria-label="${esc(T("lobby.f_profiles", "Profils"))}"></select>
          <input type="text" maxlength="32" data-role="ll-prof-name"
                 placeholder="${esc(T("lobby.f_profile_name", "Nom du profil"))}"
                 aria-label="${esc(T("lobby.f_profile_name", "Nom du profil"))}">
          <button type="button" class="llive-prof-btn" data-role="ll-prof-save">${esc(T("lobby.f_profile_save", "Sauvegarder"))}</button>
          <button type="button" class="llive-prof-btn" data-role="ll-prof-del">${esc(T("lobby.f_profile_delete", "Supprimer"))}</button>
        </div>
        <!-- v5.29 — la couche ALERTE vient APRÈS le filtre : d'abord on filtre
             l'affichage, ensuite on peut sonner quand une partie correspond. -->
        <div class="llive-alert-line">
          <span class="llive-maps-label">${esc(T("lobby.alert_section_title", "Alerte"))}</span>
          <label class="llive-toggle">
            <input type="checkbox" data-role="ll-enabled">
            <span class="llive-toggle-track" aria-hidden="true"></span>
            <span>${esc(T("lobby.alert_enable", "Alerte activée — son + notification"))}</span>
          </label>
          <button type="button" class="llive-test-sound" data-role="ll-test"
                  title="${esc(T("lobby.alert_test_title", "Tester le son de l'alerte"))}">
            🔊 ${esc(T("lobby.alert_test", "Test"))}
          </button>
        </div>
        <p class="llive-panel-hint">${esc(T("lobby.alert_hint", "Les parties qui cochent le filtre s'affichent, les autres sont masquées. Active l'alerte pour être prévenu (son + notification) dès qu'une partie correspondante s'ouvre. Garde cet onglet ouvert."))}</p>
        <div class="llive-watch-list" data-role="ll-watch"></div>
      </div>`;

    viewEl.parentNode.insertBefore(strip, viewEl);

    els = {
      badge:     strip.querySelector("[data-role=ll-badge]"),
      bell:      strip.querySelector("[data-role=ll-bell]"),
      panel:     strip.querySelector("[data-role=ll-panel]"),
      enabled:   strip.querySelector("[data-role=ll-enabled]"),
      filterOn:  strip.querySelector("[data-role=ll-filter-on]"), // v5.32
      test:      strip.querySelector("[data-role=ll-test]"),
      filterSummary: strip.querySelector("[data-role=ll-filter-summary]"),
      // v5.28 — filtre officiel : groupes de chips + bornes min/max
      chips: {
        modes:       strip.querySelector("[data-role=ll-modes]"),
        sources:     strip.querySelector("[data-role=ll-sources]"),
        named:       strip.querySelector("[data-role=ll-named]"),
        counts:      strip.querySelector("[data-role=ll-counts]"),
      },
      ranges: {
        minJoined:   strip.querySelector("[data-role=ll-min-joined]"),
        maxJoined:   strip.querySelector("[data-role=ll-max-joined]"),
        minCapacity: strip.querySelector("[data-role=ll-min-capacity]"),
        maxCapacity: strip.querySelector("[data-role=ll-max-capacity]"),
        minTeamSize: strip.querySelector("[data-role=ll-min-teamsize]"),
        maxTeamSize: strip.querySelector("[data-role=ll-max-teamsize]"),
      },
      hideEmpty: strip.querySelector("[data-role=ll-hideempty]"),
      reset:     strip.querySelector("[data-role=ll-reset]"),
      profSelect: strip.querySelector("[data-role=ll-prof-select]"),
      profName:   strip.querySelector("[data-role=ll-prof-name]"),
      profSave:   strip.querySelector("[data-role=ll-prof-save]"),
      profDel:    strip.querySelector("[data-role=ll-prof-del]"),
      mapsHead:  strip.querySelector("[data-role=ll-maps-summary]").parentNode,
      mapsSummary: strip.querySelector("[data-role=ll-maps-summary]"),
      mapsToggle:  strip.querySelector("[data-role=ll-maps-toggle]"),
      mapsBody:    strip.querySelector("[data-role=ll-maps-body]"),
      mapsSearch:  strip.querySelector("[data-role=ll-maps-search]"),
      mapsAll:     strip.querySelector("[data-role=ll-maps-all]"),
      mapsNone:    strip.querySelector("[data-role=ll-maps-none]"),
      mapsList:    strip.querySelector("[data-role=ll-maps-list]"),
      watchList: strip.querySelector("[data-role=ll-watch]"),
    };

    // État initial des contrôles
    els.enabled.checked = !!settings.enabled;
    if (els.filterOn) els.filterOn.checked = settings.filterOn !== false; // v5.32
    syncFilterUI();
    refreshProfilesUI();
    updateMapsSummary();
    updateFilterSummary();

    // ── Interactions ──
    // v5.31 : la bascule du panneau (entonnoir + clic extérieur) est gérée
    // par UN SEUL gestionnaire document, posé plus bas — voir le bloc
    // « OUVERTURE/FERMETURE du panneau ».

    // v5.32 — interrupteur du filtre : ON/OFF sans perdre la configuration.
    els.filterOn.addEventListener("change", () => setFilterOn(els.filterOn.checked));
    els.enabled.addEventListener("change", () => {
      settings.enabled = els.enabled.checked;
      save(LS_ALERTS, settings);
      if (settings.enabled) {
        ensureAudio(); // geste utilisateur : débloque l'audio
        if ("Notification" in window && Notification.permission === "default") {
          Notification.requestPermission().catch(() => { /* ignore */ });
        }
        window.showToast?.(T("lobby.alert_on_toast", "Alerte activée — son + notification"), "success", 3500, "bell");
        // v5.29 — preuve immédiate : les parties qui correspondent DÉJÀ au
        // filtre sonnent tout de suite (1 notification agrégée). Ensuite,
        // seules les NOUVELLES parties déclenchent le son.
        // v5.30 — si le flux n'est pas encore arrivé (0 partie connue),
        // l'annonce part au 1er snapshot : les parties présentes à cet
        // instant ne doivent pas rester muettes.
        if (!allGames(currentGames).length) announceOnFirstSnapshot = true;
        announceCurrentMatches();
      } else {
        pendingFresh = []; // alerte coupée : vide la file en attente
        announceOnFirstSnapshot = false;
        window.showToast?.(T("lobby.alert_off_toast", "Alerte désactivée"), "info", 2500);
      }
      renderBell();
    });
    // v5.28 — interactions du filtre officiel : chips multi-sélection,
    // bornes min/max, « masquer les salons vides », réinitialisation, profils.
    const CHIP_KEYS = { modes: "modes", sources: "sources", named: "teamConfigs", counts: "teamConfigs" };
    for (const [role, key] of Object.entries(CHIP_KEYS)) {
      const box = els.chips[role];
      if (!box) continue;
      box.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-v]");
        if (!btn) return;
        const v = btn.dataset.v;
        const arr = new Set(settings[key]);
        if (arr.has(v)) arr.delete(v); else arr.add(v);
        settings[key] = [...arr];
        commitFilters(); // v5.29 : sauvegarde + re-rendu du lobby filtré
      });
    }
    for (const [key, input] of Object.entries(els.ranges)) {
      if (!input) continue;
      input.addEventListener("change", () => {
        const raw = String(input.value).trim();
        if (raw === "") { settings[key] = null; }
        else {
          const n = Math.floor(Number(raw));
          settings[key] = Number.isFinite(n) && n >= 0 ? n : null;
        }
        input.value = settings[key] == null ? "" : String(settings[key]);
        commitFilters(); // v5.29
      });
    }
    els.hideEmpty.addEventListener("change", () => {
      settings.hideEmpty = els.hideEmpty.checked;
      commitFilters(); // v5.29
    });
    els.reset.addEventListener("click", () => {
      // Réinitialise les FILTRES — l'état des alertes (enabled) ET de
      // l'interrupteur du filtre (filterOn, v5.32) est conservé : ce sont
      // des choix explicites de l'utilisateur, « Réinitialiser » ne porte
      // que sur les critères.
      const keepEnabled = settings.enabled;
      const keepFilterOn = settings.filterOn !== false;
      Object.assign(settings, JSON.parse(JSON.stringify(DEFAULT_FILTERS)), { enabled: keepEnabled, filterOn: keepFilterOn });
      commitFilters(); // v5.29
      window.showToast?.(T("lobby.f_reset_toast", "Filtres réinitialisés"), "info", 2500);
    });
    els.profSelect.addEventListener("change", () => {
      const name = els.profSelect.value;
      if (!name) return;
      const profiles = loadProfiles();
      if (!Object.prototype.hasOwnProperty.call(profiles, name)) return;
      const f = normalizeFilters(profiles[name]);
      const keepEnabled = settings.enabled; // les profils filtrent, l'alarme reste telle quelle
      const keepFilterOn = settings.filterOn !== false; // v5.32 : idem pour l'interrupteur
      Object.assign(settings, f, { enabled: keepEnabled, filterOn: keepFilterOn });
      commitFilters(); // v5.29
      announceCurrentMatches(); // si l'alerte est active : son immédiat si des parties cochent déjà
      window.showToast?.(T("lobby.f_profile_applied", `Profil « ${name} » appliqué`, { name }), "success", 3000);
    });
    els.profSave.addEventListener("click", () => {
      const stored = saveProfile(els.profName.value, settings);
      if (!stored) {
        window.showToast?.(T("lobby.f_profile_bad_name", "Donne un nom au profil (max 20 profils)"), "error", 3500);
        return;
      }
      els.profName.value = "";
      refreshProfilesUI(stored);
      window.showToast?.(T("lobby.f_profile_saved", `Profil « ${stored} » sauvegardé`, { name: stored }), "success", 3000);
    });
    els.profDel.addEventListener("click", () => {
      const name = els.profSelect.value;
      if (!name) {
        window.showToast?.(T("lobby.f_profile_none_selected", "Aucun profil sélectionné"), "info", 2500);
        return;
      }
      if (deleteProfile(name)) {
        refreshProfilesUI("");
        window.showToast?.(T("lobby.f_profile_deleted", `Profil « ${name} » supprimé`, { name }), "info", 3000);
      }
    });
    els.test.addEventListener("click", () => {
      ensureAudio(); // geste utilisateur : débloque l'audio
      beep();
    });
    els.mapsToggle.addEventListener("click", () => {
      const open = els.mapsBody.hidden;
      els.mapsBody.hidden = !open;
      els.mapsToggle.setAttribute("aria-expanded", String(open));
      if (open) loadMapsCatalog();
    });
    els.mapsSearch.addEventListener("input", () => renderMapsList());
    els.mapsAll.addEventListener("click", () => {
      // sélectionne toutes les cartes VISIBLES (recherche respectée)
      const sel = new Set(settings.maps);
      els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        sel.add(cb.value);
        cb.checked = true;
        cb.closest(".llive-map-item")?.classList.add("is-on");
      });
      settings.maps = [...sel];
      commitFilters(); // v5.29
    });
    els.mapsNone.addEventListener("click", () => {
      settings.maps = [];
      commitFilters(); // v5.29
      els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.checked = false;
        cb.closest(".llive-map-item")?.classList.remove("is-on");
      });
    });

    // v5.31 — OUVERTURE/FERMETURE du panneau : UN SEUL gestionnaire document.
    // L'ancienne paire « clic bouton + clic extérieur » pouvait se marcher
    // dessus (ordre d'exécution, cible détachée quand renderBell() remplace
    // le SVG de l'entonnoir pendant l'interaction) → « j'appuie sur le filtre
    // et rien ne se passe ». Ici : clic dans la tuile = bascule ; clic hors
    // tuile ET hors panneau = fermeture. Un seul chemin, aucune course.
    document.addEventListener("click", (e) => {
      const tgt = e.target;
      const inTile = !!(tgt && typeof tgt.closest === "function" && tgt.closest(".llive-tile-bell"));
      const inPanel = !!(tgt && typeof tgt.closest === "function" && tgt.closest(".llive-panel"));
      if (!els.panel) return;
      if (inTile) {
        const open = els.panel.hidden;
        els.panel.hidden = !open;
        els.bell.setAttribute("aria-expanded", String(open));
      } else if (!inPanel && !els.panel.hidden) {
        els.panel.hidden = true;
        els.bell.setAttribute("aria-expanded", "false");
      }
    });

    // Ouverture/fermeture de surveillance depuis les cartes (lobby.js émet)
    window.addEventListener("tfh:lobby:watch-toggle", (e) => {
      const id = e.detail && e.detail.gameId;
      if (!id) return;
      toggleWatch(id);
    });

    renderBell();
    renderWatchList();
  }

  /* ── v5.28 — synchro UI + profils de filtres (cf. DetailedGameViewFilters) ── */

  /** Répercute `settings` sur tous les contrôles du panneau (chips, bornes,
   *  cases). Les groupes vides = aucune restriction (rien d'enfoncé). */
  function syncFilterUI() {
    if (!els.panel) return;
    for (const box of Object.values(els.chips)) {
      if (!box) continue;
      const key = box === els.chips.modes ? "modes"
        : box === els.chips.sources ? "sources" : "teamConfigs";
      const arr = Array.isArray(settings[key]) ? settings[key] : [];
      box.querySelectorAll("button[data-v]").forEach((btn) => {
        const on = arr.includes(btn.dataset.v);
        btn.setAttribute("aria-pressed", String(on));
        btn.classList.toggle("is-on", on);
      });
    }
    for (const [key, input] of Object.entries(els.ranges)) {
      if (input) input.value = settings[key] == null ? "" : String(settings[key]);
    }
    if (els.hideEmpty) els.hideEmpty.checked = settings.hideEmpty === true;
    if (els.filterOn) els.filterOn.checked = settings.filterOn !== false; // v5.32
  }

  const TEAM_CONFIG_ALLOWED = ["Duos", "Trios", "Quads", "2", "3", "4", "5", "6", "7", "8"];

  /** Coerce une entrée non fiable (localStorage, anciens builds) en filtre
   *  utilisable — port du normalizeFilters officiel. */
  function normalizeFilters(raw) {
    const f = JSON.parse(JSON.stringify(DEFAULT_FILTERS));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return f;
    const arr = (v, allowed) => (Array.isArray(v)
      ? [...new Set(v.filter((x) => typeof x === "string" && allowed.includes(x)))] : []);
    f.modes = arr(raw.modes, ["ffa", "teams", "hvn"]);
    f.sources = arr(raw.sources, ["public", "hosted"]);
    f.teamConfigs = arr(raw.teamConfigs, TEAM_CONFIG_ALLOWED);
    f.hideEmpty = raw.hideEmpty === true;
    for (const k of ["minJoined", "maxJoined", "minCapacity", "maxCapacity", "minTeamSize", "maxTeamSize"]) {
      const v = raw[k];
      if (v == null || v === "") { f[k] = null; continue; }
      const n = Number(v);
      f[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }
    f.maps = Array.isArray(raw.maps) ? raw.maps.filter((x) => typeof x === "string").slice(0, 500) : [];
    return f;
  }

  /** Profils : enregistrement SANS prototype (noms arbitraires sûrs), comme
   *  l'officiel — `profiles["__proto__"]` ne peut pas polluer. */
  function emptyProfiles() { return Object.create(null); }

  function hasProfile(profiles, name) {
    return Object.prototype.hasOwnProperty.call(profiles, name);
  }

  function loadProfiles() {
    const raw = load(LS_PROFILES, null);
    const profiles = emptyProfiles();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return profiles;
    for (const [name, val] of Object.entries(raw)) {
      if (hasProfile(raw, name) && val && typeof val === "object") {
        profiles[name] = normalizeFilters(val);
      }
    }
    return profiles;
  }

  function persistProfiles(profiles) { save(LS_PROFILES, profiles); }

  /** Sauvegarde (ou écrase) un profil. Retourne le nom stocké ou null. */
  function saveProfile(name, filters) {
    const trimmed = String(name || "").trim().slice(0, MAX_PROFILE_NAME);
    if (!trimmed) return null;
    const profiles = loadProfiles();
    if (!hasProfile(profiles, trimmed) && Object.keys(profiles).length >= MAX_PROFILES) return null;
    const f = normalizeFilters(filters);
    delete f.enabled; // un profil = des filtres, pas l'état de l'alarme
    delete f.filterOn; // v5.32 : ni l'état de l'interrupteur du filtre
    profiles[trimmed] = f;
    persistProfiles(profiles);
    return trimmed;
  }

  function deleteProfile(name) {
    const profiles = loadProfiles();
    if (!hasProfile(profiles, name)) return false;
    delete profiles[name];
    persistProfiles(profiles);
    return true;
  }

  /** Reconstruit le <select> des profils ; sélectionne `selectedName` (ou rien). */
  function refreshProfilesUI(selectedName) {
    if (!els.profSelect) return;
    const profiles = loadProfiles();
    const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b, "fr"));
    const current = selectedName !== undefined
      ? selectedName
      : (names.includes(els.profSelect.value) ? els.profSelect.value : "");
    els.profSelect.innerHTML =
      `<option value="">${esc(T("lobby.f_profile_none", "Aucun profil"))}</option>` +
      names.map((n) => `<option value="${esc(n)}"${n === current ? " selected" : ""}>${esc(n)}</option>`).join("");
    els.profDel.disabled = !current;
  }

  function renderBell() {
    if (!els.badge) return;
    const n = Object.keys(watch).length;
    els.badge.hidden = n === 0;
    els.badge.textContent = String(n);
    // v5.32 — l'entonnoir n'est rempli que si le filtre est VRAIMENT appliqué
    // (interrupteur ON + au moins un critère) ; OFF = entonnoir vide.
    const filtering = settings.filterOn !== false && hasActiveCriteria();
    // v5.29 — entonnoir : rempli quand le filtre (affichage) est actif ;
    // halo « has-alerts » quand l'ALERTE (son) est activée.
    els.bell.classList.toggle("has-alerts", !!settings.enabled);
    els.bell.classList.toggle("is-filtering", filtering);
    els.bell.innerHTML = funnelSvg(filtering);
    if (els.badge.parentNode !== els.bell) els.bell.appendChild(els.badge);
  }

  /** v5.29 — ligne de résumé de l'entête du panneau : « Filtre actif —
   *  N partie(s) masquée(s) » ou « Aucun filtre actif ». Fraîchie à chaque
   *  snapshot (les comptes bougent) et à chaque changement de filtre. */
  function updateFilterSummary() {
    if (!els.filterSummary) return;
    // v5.32 — interrupteur OFF : le filtre est suspendu, TOUTES les parties
    // s'affichent (les critères restent enregistrés mais ne filtrent plus).
    if (settings.filterOn === false) {
      strip?.classList.toggle("is-filtering", false);
      strip?.classList.toggle("is-filter-off", true);
      els.filterSummary.textContent = T("lobby.filter_off_summary", "Filtre désactivé — toutes les parties s'affichent");
      els.filterSummary.classList.remove("is-active");
      els.filterSummary.title = T("lobby.filter_off_title", "Le filtre est coupé : la configuration est conservée, réactive l'interrupteur pour la réappliquer");
      return;
    }
    strip?.classList.toggle("is-filter-off", false);
    const active = hasActiveCriteria();
    strip?.classList.toggle("is-filtering", active);
    if (!active) {
      els.filterSummary.textContent = T("lobby.f_inactive_summary", "Aucun filtre actif — toutes les parties s'affichent");
      els.filterSummary.classList.remove("is-active");
      return;
    }
    const games = allGames(currentGames);
    const visible = games.filter((g) => matchesFilters(g)).length;
    const hidden = games.length - visible;
    els.filterSummary.textContent = hidden > 0
      ? T("lobby.f_active_hidden", `${hidden} partie${hidden > 1 ? "s" : ""} masquée${hidden > 1 ? "s" : ""}`, { n: hidden, s: hidden > 1 ? "s" : "" })
      : T("lobby.f_active_ok", "tout correspond au filtre");
    els.filterSummary.classList.add("is-active");
    els.filterSummary.title = T("lobby.f_active_title", "Filtre actif — les parties qui ne le cochent pas sont masquées");
  }

  function renderWatchList() {
    if (!els.watchList) return;
    const ids = Object.keys(watch);
    els.watchList.innerHTML = ids.length
      ? `<p class="llive-watch-title">${esc(T("lobby.alert_watching", "Lobbies surveillés (prévenir quand pleins)"))}</p>` +
        ids.map((id) => {
          const w = watch[id];
          return `<span class="llive-watch-chip" title="${esc(id)}">
            ${esc(w.map || id)}
            <button type="button" data-unwatch="${esc(id)}" aria-label="${esc(T("lobby.watch_remove_aria", "Ne plus surveiller"))}">&times;</button>
          </span>`;
        }).join("")
      : `<p class="llive-watch-hint">${esc(T("lobby.alert_watch_hint", "Astuce : clique la cloche d'une carte pour être prévenu quand le lobby est plein."))}</p>`;
    els.watchList.querySelectorAll("[data-unwatch]").forEach((btn) => {
      btn.addEventListener("click", () => toggleWatch(btn.dataset.unwatch));
    });
    renderBell();
  }

  function toggleWatch(id) {
    if (watch[id]) {
      delete watch[id];
      window.showToast?.(T("lobby.watch_off_toast", "Surveillance retirée"), "info", 2500);
    } else {
      const g = findGameById(currentGames, id);
      // v5.31 — armement IMMÉDIAT et INCONDITIONNEL : le clic EST l'intention
      // (« préviens-moi quand CE lobby démarre »). L'ancien armement
      // conditionnel (plein → armedAt = 0) rendait la cloche MUELLE sur une
      // carte pleine — le moteur supprimait alors l'entrée au snapshot
      // suivant, en silence. Le cas « rechargement de page » reste protégé :
      // boot() remet armedAt à 0, et les entrées absentes > 5 min sont
      // nettoyées sans bip.
      watch[id] = {
        map: g ? gameLabel(g) : "",
        mode: g ? modeLabelOf(g) : "",
        addedAt: Date.now(),
        lastSeen: Date.now(),
        armedAt: Date.now(),
      };
      ensureAudio(); // geste utilisateur : audio prêt pour le bip « pleine »
      window.showToast?.(
        T("lobby.watch_on_toast", "OK ! Je te préviens dès que ce lobby démarre 🔔"),
        "success", 4000, "bell"
      );
    }
    save(LS_WATCH, watch);
    renderWatchList();
    syncCardBells();
  }

  /* ── v5.22 — sélecteur de cartes (catalogue atlas, 132 cartes) ──────── */

  let mapsCatalog = null;       // [{ slug, name }] — chargé au 1er dépliage
  let mapsLoading = false;

  function loadMapsCatalog() {
    if (mapsCatalog || mapsLoading) { if (mapsCatalog) renderMapsList(); return; }
    mapsLoading = true;
    els.mapsList.innerHTML = `<p class="llive-maps-empty">${esc(T("lobby.alert_maps_loading", "Chargement des cartes…"))}</p>`;
    fetch("atlas-data/maps_data.json?v=132", { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((d) => {
        mapsCatalog = Object.keys(d || {}).map((slug) => {
          const e = d[slug] || {};
          return { slug, name: e.translated_name || e.display_name || e.enum_key || slug };
        }).sort((a, b) => a.name.localeCompare(b.name, "fr"));
      })
      .catch(() => {
        // Repli : les cartes actuellement en lobby (catalogue indisponible)
        const seen = new Map();
        allGames(currentGames).forEach((g) => {
          const raw = String((g.gameConfig || {}).gameMap || "");
          const slug = mapSlugOf(raw);
          if (slug && !seen.has(slug)) seen.set(slug, raw);
        });
        mapsCatalog = [...seen.entries()].map(([slug, raw]) => ({ slug, name: raw }))
          .sort((a, b) => a.name.localeCompare(b.name, "fr"));
      })
      .finally(() => {
        mapsLoading = false;
        renderMapsList();
      });
  }

  function renderMapsList() {
    if (!els.mapsList || !mapsCatalog) return;
    const q = String((els.mapsSearch && els.mapsSearch.value) || "").trim().toLowerCase();
    const sel = new Set(settings.maps);
    const items = mapsCatalog.filter((m) => !q || m.name.toLowerCase().includes(q) || m.slug.includes(q));
    els.mapsList.innerHTML = items.length
      ? items.map((m) => `
        <label class="llive-map-item${sel.has(m.slug) ? " is-on" : ""}">
          <input type="checkbox" value="${esc(m.slug)}"${sel.has(m.slug) ? " checked" : ""}>
          <img class="llive-map-thumb" alt="" loading="lazy" draggable="false"
               src="atlas-data/thumbnails/${esc(m.slug)}.webp?v=2"
               onerror="this.style.visibility='hidden'">
          <span class="llive-map-name">${esc(m.name)}</span>
        </label>`).join("")
      : `<p class="llive-maps-empty">${esc(T("lobby.alert_maps_empty", "Aucune carte trouvée"))}</p>`;
    els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const s = new Set(settings.maps);
        if (cb.checked) s.add(cb.value); else s.delete(cb.value);
        settings.maps = [...s];
        commitFilters(); // v5.29
        cb.closest(".llive-map-item")?.classList.toggle("is-on", cb.checked);
      });
    });
  }

  function updateMapsSummary() {
    if (!els.mapsSummary) return;
    const n = Array.isArray(settings.maps) ? settings.maps.length : 0;
    els.mapsSummary.textContent = n === 0
      ? T("lobby.alert_maps_all", "Toutes")
      : T("lobby.alert_maps_custom", `${n} choisie${n > 1 ? "s" : ""}`, { n, s: n > 1 ? "s" : "" });
    els.mapsSummary.classList.toggle("is-filtered", n > 0);
  }

  /** Répercute l'état de surveillance sur les cloches des cartes. */
  function syncCardBells() {
    const setBtn = window._lobbyDebug && window._lobbyDebug.setWatchBtn;
    document.querySelectorAll(".lobby-card[data-game-id]").forEach((card) => {
      const btn = card.querySelector("[data-role=watch]");
      if (btn && setBtn) setBtn(btn, !!watch[card.dataset.gameId]);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     Écoute du flux live
     ══════════════════════════════════════════════════════════════════════ */

  let currentGames = { ffa: [], team: [], special: [] };

  function onUpdate(e) {
    const detail = e.detail || {};
    currentGames = detail.games || currentGames;
    const sNow = Number(detail.serverNow) || 0;
    if (sNow > 0) { lastServerNow = sNow; lastServerNowAt = Date.now(); } // v5.31 : interpolation 1 s
    // v5.31 — prevFullAt = date de la frame full PRÉCÉDENTE : le bip immédiat
    // « sortie de liste » n'est valide que si la frame précédente datait de
    // moins de FULL_EVIDENCE_GAP_MS (flux stable — pas une reconnexion).
    const prevFullAt = lastFullAt;
    if (detail.full) lastFullAt = Date.now();
    buildStrip();
    updateFilterSummary(); // v5.29 : le compte de parties masquées suit le flux
    // v5.20.2 — snapshot DÉGRADÉ (parties terminées, pas de live) : le moteur
    // d'alertes et le suivi « ma partie » restent éteints — bip/notification
    // pour une partie déjà terminée = spam sans objet (l'utilisateur ne peut
    // plus la rejoindre).
    if (!detail.degraded) {
      runAlertEngine({
        games: currentGames,
        full: !!detail.full,
        serverNow: sNow, // v5.20.1 : horloge serveur pour startsAt
        fullEvidence: !!detail.full &&
          allGames(currentGames).length > 0 &&
          prevFullAt > 0 && Date.now() - prevFullAt <= FULL_EVIDENCE_GAP_MS,
      });
    }
  }

  function boot() {
    buildStrip();
    window.addEventListener("tfh:lobby:update", onUpdate);
    // v5.31 — GARDE-FOU 1 s : les déclencheurs TEMPORELS (compte à rebours
    // atteint, absence ≥ 15 s) tournent même si AUCUNE frame n'arrive —
    // l'ancien code ne tournait QUE sur événements : flux calme = bip en
    // retard ou JAMAIS. full:false → pas de détection « nouvelles parties »
    // ni de preuve « sortie de liste » ici (réservés aux vraies frames).
    setInterval(() => {
      runAlertEngine({ games: currentGames, full: false, serverNow: 0 });
    }, WATCHDOG_TICK_MS);
    // v5.29 — filtre persisté (localStorage) : prévient lobby.js d'un
    // re-rendu initial filtré (l'événement part APRÈS l'exposition de
    // window.TFH_LOBBY_FILTER,lobby.js est déjà à l'écoute).
    // v5.32 — uniquement si le filtre est VRAIMENT actif (interrupteur ON
    // + critères) : OFF, aucune liste filtrée à peindre au démarrage.
    if (window.TFH_LOBBY_FILTER && window.TFH_LOBBY_FILTER.active()) {
      try { window.dispatchEvent(new CustomEvent("tfh:lobby:filter-changed", {})); } catch { /* ignore */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
