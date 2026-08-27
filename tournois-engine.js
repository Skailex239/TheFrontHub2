/**
 * tournois-engine.js — Moteur Power Ranking + stats tournoi (port JS vanilla de PR-Front).
 *
 * Source : src/lib/pr.ts, src/lib/tournament-stats.ts, src/lib/format.ts
 * Règles :
 *  - Chaque phase d'un tournoi attribue des points à chaque joueur listé :
 *      placement précis → points de places[place], sinon defaultPoints de la phase.
 *  - Tranches (ranges) vérifiées après places, avant defaultPoints.
 *  - Points multipliés par le coefficient du tier (major ×2.5, standard ×1.0, minor ×0.5),
 *    SAUF si la phase a ignoreTierMultiplier=true.
 *  - Aucune décroissance : tout se cumule.
 *  - Une "victoire" = phase finale (ou countsAsFinal) remportée (place 1).
 *    Un "top 3" = finale, place ≤ 3.
 */

const FINAL_PHASE = "finale";

export class DataError extends Error {}

/* ════════════════════════════════════════════════════════════════════
 *  Barème & points
 * ════════════════════════════════════════════════════════════════════ */

/** Points de base pour un placement dans une phase, selon le barème. */
export function basePoints(scoring, tournament, phaseType, place) {
  const formatConf = scoring.formats[tournament.format];
  if (!formatConf) {
    throw new DataError(
      `Tournoi "${tournament.slug}" : format inconnu "${tournament.format}".`
    );
  }
  const phaseConf = formatConf.phases[phaseType];
  if (!phaseConf) {
    throw new DataError(
      `Tournoi "${tournament.slug}" : phase inconnue "${phaseType}".`
    );
  }
  if (place != null && phaseConf.places[String(place)] != null) {
    return phaseConf.places[String(place)];
  }
  if (place != null && Array.isArray(phaseConf.ranges)) {
    const range = phaseConf.ranges.find(
      (r) => place >= r.min && (r.max == null || place <= r.max)
    );
    if (range) return range.points;
  }
  return phaseConf.defaultPoints;
}

/** Le multiplicateur de tier s'applique-t-il à cette phase ? */
export function phaseUsesTierMultiplier(scoring, tournament, phaseType) {
  const phaseConf = scoring.formats[tournament.format]?.phases?.[phaseType];
  return !phaseConf?.ignoreTierMultiplier;
}

/** Cette phase compte-t-elle comme le classement final du tournoi ? */
export function isFinalPhase(scoring, tournament, phaseType) {
  if (phaseType === FINAL_PHASE) return true;
  const phaseConf = scoring.formats[tournament.format]?.phases?.[phaseType];
  return phaseConf?.countsAsFinal === true;
}

export function tierMultiplier(scoring, tournament) {
  return scoring.tiers[tournament.tier] ?? 1;
}

/** Récompense (Plutonium, etc.) d'un joueur pour une place finale donnée. */
export function rewardPoints(scoring, tournament, place) {
  const conf = scoring.rewards?.[tournament.tier];
  if (!conf || place == null) return 0;
  if (conf.places[String(place)] != null) return conf.places[String(place)];
  if (Array.isArray(conf.ranges)) {
    const range = conf.ranges.find(
      (r) => place >= r.min && (r.max == null || place <= r.max)
    );
    if (range) return range.points;
  }
  return 0;
}

/* ════════════════════════════════════════════════════════════════════
 *  Calcul du Power Ranking
 * ════════════════════════════════════════════════════════════════════ */

/** Calcule le PR de tous les joueurs apparaissant dans les tournois donnés. */
export function computePlayerPRs(tournaments, scoring) {
  const prs = new Map();
  const getOrCreate = (id) => {
    let pr = prs.get(id);
    if (!pr) {
      pr = {
        playerId: id,
        points: 0,
        events: 0,
        wins: 0,
        top3: 0,
        bestPlace: null,
        avgPlace: null,
        awards: [],
      };
      prs.set(id, pr);
    }
    return pr;
  };

  const sorted = [...tournaments].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const mult = tierMultiplier(scoring, t);
    const seen = new Set();
    for (const phase of t.phases) {
      const formatConf = scoring.formats[t.format];
      const phaseLabel = formatConf?.phases?.[phase.type]?.label ?? phase.type;
      for (const p of phase.placements) {
        const pr = getOrCreate(p.player);
        const place = p.place ?? null;
        const base = basePoints(scoring, t, phase.type, place);
        const phaseMult = phaseUsesTierMultiplier(scoring, t, phase.type) ? mult : 1;
        const award = {
          tournamentSlug: t.slug,
          tournamentName: t.name,
          tournamentDate: t.date,
          format: t.format,
          tier: t.tier,
          phaseType: phase.type,
          phaseLabel,
          place,
          basePoints: base,
          points: Math.round(base * phaseMult),
        };
        pr.awards.push(award);
        pr.points += award.points;
        seen.add(p.player);
        if (isFinalPhase(scoring, t, phase.type) && place != null) {
          if (place === 1) pr.wins += 1;
          if (place <= 3) pr.top3 += 1;
          pr.bestPlace = pr.bestPlace == null ? place : Math.min(pr.bestPlace, place);
        }
      }
    }
    for (const id of seen) getOrCreate(id).events += 1;
  }

  // Placement moyen sur le classement final de chaque tournoi.
  const bySlug = new Map(tournaments.map((t) => [t.slug, t]));
  for (const pr of prs.values()) {
    const finalPlaces = pr.awards
      .filter((a) => {
        const t = bySlug.get(a.tournamentSlug);
        return t != null && isFinalPhase(scoring, t, a.phaseType) && a.place != null;
      })
      .map((a) => a.place);
    pr.avgPlace =
      finalPlaces.length > 0
        ? finalPlaces.reduce((s, v) => s + v, 0) / finalPlaces.length
        : null;
  }
  return prs;
}

/* ════════════════════════════════════════════════════════════════════
 *  Tableau de bord — Classement par points (FFA +10 / Team +5 par victoire)
 * ════════════════════════════════════════════════════════════════════ */

// Barème du Tableau de bord : points attribués selon le format et la place
// en phase finale. FFA : 1er=+10 (comme demandé), podium dégressif.
// Team : 1er=+5 (comme demandé), podium dégressif.
const DASHBOARD_POINTS = {
  ffa: { 1: 10, 2: 7, 3: 5, 4: 3, 5: 1 },
  team: { 1: 5, 2: 3, 3: 2 },
};

// Détermine si un tournoi est FFA ou Team à partir du format/série/nom.
export function isTeamTournament(t) {
  const fmt = (t.format || "").toLowerCase();
  if (fmt === "team" || fmt === "2v2" || fmt === "bracket") {
    // bracket peut être FFA ou team — on vérifie le nom
    const name = `${t.name || ""} ${t.series || ""}`.toLowerCase();
    if (name.includes("2v2") || name.includes("team") || name.includes("équipe")) {
      return true;
    }
    // bracket sans indication team → on considère FFA par défaut
    return false;
  }
  const name = `${t.name || ""} ${t.series || ""}`.toLowerCase();
  if (name.includes("2v2") || name.includes("team") || name.includes("équipe")) {
    return true;
  }
  return false;
}

// Retourne la clé de semaine ISO (YYYY-Www) d'une date.
export function weekKey(iso) {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  // Trouver le lundi de la semaine
  const day = d.getUTCDay() || 7; // 0=dimanche → 7
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1));
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth();
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((monday - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

// Renvoie la clé de semaine actuelle (UTC).
export function currentWeekKey() {
  return weekKey(new Date().toISOString());
}

/**
 * Calcule le classement Tableau de bord.
 * Points : FFA 1er=+10, 2e=+7, 3e=+5, 4e=+3, 5e=+1
 *          Team 1er=+5, 2e=+3, 3e=+2
 * @param {Array} tournaments
 * @param {Array} players
 * @param {object} scoring
 * @param {object} [opts] — { weekOnly: string|null } pour filtrer par semaine
 * @returns {Array} classement trié par points décroissants
 */
export function computeDashboardRanking(tournaments, players, scoring, opts = {}) {
  const { weekOnly = null } = opts;
  const byId = new Map(players.map((p) => [p.discordId, p]));
  const map = new Map();
  const getOrCreate = (id) => {
    let e = map.get(id);
    if (!e) {
      e = {
        playerId: id,
        points: 0,
        ffaWins: 0,
        teamWins: 0,
        wins: 0,
        top3: 0,
        events: 0,
        bestPlace: null,
        awards: [],
      };
      map.set(id, e);
    }
    return e;
  };

  const sorted = [...tournaments].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    if (weekOnly) {
      const wk = weekKey(t.date);
      if (wk !== weekOnly) continue;
    }
    const isTeam = isTeamTournament(t);
    const ptsTable = isTeam ? DASHBOARD_POINTS.team : DASHBOARD_POINTS.ffa;
    const seen = new Set();
    for (const phase of t.phases) {
      if (!isFinalPhase(scoring, t, phase.type)) continue;
      for (const p of phase.placements) {
        if (p.place == null) continue;
        const e = getOrCreate(p.player);
        const pts = ptsTable[p.place] || 0;
        if (pts > 0) {
          e.points += pts;
          e.awards.push({
            tournamentSlug: t.slug,
            tournamentName: t.name,
            tournamentDate: t.date,
            format: isTeam ? "team" : "ffa",
            tier: t.tier,
            place: p.place,
            points: pts,
          });
        }
        if (p.place === 1) {
          e.wins += 1;
          if (isTeam) e.teamWins += 1;
          else e.ffaWins += 1;
        }
        if (p.place <= 3) e.top3 += 1;
        e.bestPlace = e.bestPlace == null ? p.place : Math.min(e.bestPlace, p.place);
        seen.add(p.player);
      }
    }
    for (const id of seen) getOrCreate(id).events += 1;
  }

  const arr = [...map.values()];
  arr.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.top3 !== a.top3) return b.top3 - a.top3;
    const ba = a.bestPlace ?? Infinity;
    const bb = b.bestPlace ?? Infinity;
    if (bb !== ba) return bb - ba;
    const na = byId.get(a.playerId)?.name ?? a.playerId;
    const nb = byId.get(b.playerId)?.name ?? b.playerId;
    return na.localeCompare(nb, "fr");
  });
  return arr
    .filter((e) => e.points > 0 || e.events > 0)
    .map((e, i) => ({
      ...e,
      rank: i + 1,
      player: byId.get(e.playerId) ?? null,
    }));
}

/** Classement complet, trié : points → victoires → meilleure place → nom. */
export function computeLeaderboard(tournaments, players, scoring) {
  const byId = new Map(players.map((p) => [p.discordId, p]));
  const prs = [...computePlayerPRs(tournaments, scoring).values()];
  prs.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    const ba = a.bestPlace ?? Infinity;
    const bb = b.bestPlace ?? Infinity;
    if (bb !== ba) return bb - ba;
    const na = byId.get(a.playerId)?.name ?? a.playerId;
    const nb = byId.get(b.playerId)?.name ?? b.playerId;
    return na.localeCompare(nb, "fr");
  });
  return prs.map((pr, i) => ({
    ...pr,
    rank: i + 1,
    player: byId.get(pr.playerId) ?? null,
  }));
}

/* ════════════════════════════════════════════════════════════════════
 *  Stats par joueur sur un tournoi (depuis details.games)
 * ════════════════════════════════════════════════════════════════════ */

const STAGE_ORDER = { qualifier: 1, semifinal: 2, final: 3 };

export function computeTournamentPlayerStats(tournament) {
  const map = new Map();
  const rounds = tournament.details?.games ?? [];
  for (const round of rounds) {
    const stage = round.stage ?? null;
    for (const game of round.entries) {
      for (const res of game.results ?? []) {
        let s = map.get(res.player);
        if (!s) {
          s = {
            playerId: res.player,
            gamesPlayed: 0,
            wins: 0,
            kills: 0,
            survived: 0,
            bestPlace: null,
            furthestStage: null,
            playtimeMin: 0,
            avgGamePoints: null,
          };
          map.set(res.player, s);
        }
        s.gamesPlayed += 1;
        if (res.place === 1) s.wins += 1;
        s.kills += res.kills ?? 0;
        if (res.result === "survived") s.survived += 1;
        s.bestPlace = s.bestPlace == null ? res.place : Math.min(s.bestPlace, res.place);
        if (stage) {
          const cur = s.furthestStage ? STAGE_ORDER[s.furthestStage] : 0;
          if (STAGE_ORDER[stage] > cur) s.furthestStage = stage;
        }
        s.playtimeMin += res.minutes ?? 0;
        if (res.points != null) {
          s.avgGamePoints = (s.avgGamePoints ?? 0) + res.points;
        }
      }
    }
  }
  for (const s of map.values()) {
    if (s.avgGamePoints != null) {
      s.avgGamePoints = Math.round((s.avgGamePoints / s.gamesPlayed) * 10) / 10;
    }
  }
  return map;
}

/* ════════════════════════════════════════════════════════════════════
 *  Helpers de formatage
 * ════════════════════════════════════════════════════════════════════ */

const LOCALE = "fr-FR";

function parseIso(iso) {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatPoints(n) {
  return new Intl.NumberFormat(LOCALE).format(n);
}

export function formatDate(iso) {
  const d = parseIso(iso);
  if (!d) return iso;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function formatDateShort(iso) {
  const d = parseIso(iso);
  if (!d) return iso;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function formatDateTime(iso) {
  const d = parseIso(iso);
  if (!d) return iso;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function initials(name) {
  const clean = name.replace(/^\[[^\]]+\]\s*/, "").trim();
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
}

export function placeLabel(place) {
  return place == null ? "—" : `#${place}`;
}

/* ════════════════════════════════════════════════════════════════════
 *  Chargement des données (fetch côté client depuis /data/)
 * ════════════════════════════════════════════════════════════════════ */

let _dataCache = null;
// ⚠️ Perf (audit 2026-08-27) : on mémoïse la PROMESSE, pas le résultat.
// Avant, deux appels concurrents (DOMContentLoaded + hashchange déclenché par
// la redirection #/home au 1er chargement) voyaient tous deux _dataCache=null
// et téléchargeaient CHAQUE fichier de données 2 fois (~3,4 Mo doublés).
let _dataPromise = null;

/**
 * Charge et cache toutes les données tournoi.
 * Retourne { players, scoring, tournaments, calendar, leaderboard }.
 * Les appels concurrents partagent le même chargement (dédupliqué).
 */
export function loadData() {
  if (_dataCache) return Promise.resolve(_dataCache);
  if (!_dataPromise) {
    _dataPromise = loadDataInternal().catch((e) => {
      // Ne pas garder l'échec en cache : un retry pourra relancer le chargement.
      _dataPromise = null;
      throw e;
    });
  }
  return _dataPromise;
}

async function loadDataInternal() {
  const [playersRes, scoringRes, calendarRes] = await Promise.all([
    fetch("data/players.json", { cache: "no-cache" }),
    fetch("data/scoring.config.json", { cache: "no-cache" }),
    fetch("data/calendar.json", { cache: "no-cache" }),
  ]);
  if (!playersRes.ok || !scoringRes.ok) {
    throw new Error("Impossible de charger les données tournoi.");
  }
  const playersJson = await playersRes.json();
  const scoring = await scoringRes.json();
  const calendar = calendarRes.ok ? await calendarRes.json() : [];

  const players = (playersJson.players || []).filter(
    (p) => p && typeof p.discordId === "string" && typeof p.name === "string"
  );

  // Liste des fichiers de tournois — on découvre le dossier via une liste
  // générée côté serveur, ou on hardcode la liste connue.
  // Pour rester statique, on utilise un manifeste.
  const manifestRes = await fetch("data/tournaments/manifest.json", { cache: "no-cache" }).catch(() => null);
  let slugs = [];
  if (manifestRes && manifestRes.ok) {
    slugs = await manifestRes.json();
  } else {
    // Fallback : liste connue (sera mise à jour avec le manifeste)
    slugs = [
      "2026-summer-ffa-major",
      "2026-summer-ffa-minor-4",
      "openfront-minor-1",
      "openfront-minor-2",
      "openfront-minor-3",
      "openfront-minor-4",
      "openfront-minor-5",
    ];
  }

  const tournamentResults = await Promise.all(
    slugs.map((slug) =>
      fetch(`data/tournaments/${slug}.json`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  );
  const tournaments = tournamentResults
    .filter(Boolean)
    .filter((t) => t && t.slug && t.format && Array.isArray(t.phases))
    .sort((a, b) => b.date.localeCompare(a.date));

  const leaderboard = computeLeaderboard(tournaments, players, scoring);

  _dataCache = { players, scoring, tournaments, calendar, leaderboard };
  return _dataCache;
}

/** Récupère l'entrée leaderboard d'un joueur par son discordId. */
export function getPlayerEntry(leaderboard, discordId) {
  return leaderboard.find((e) => e.playerId === discordId) ?? null;
}

/** Récupère un joueur par discordId. */
export function getPlayer(players, discordId) {
  return players.find((p) => p.discordId === discordId) ?? null;
}

/** Récupère un tournoi par slug. */
export function getTournament(tournaments, slug) {
  return tournaments.find((t) => t.slug === slug) ?? null;
}
