/**
 * playtime-stats.js — Calcul du temps de jeu et stats par carte.
 *
 * Le temps de jeu = Σ game.durationSeconds.
 * L'API OpenFront enregistre la durée RÉELLE par joueur, donc si un joueur
 * quitte une game en cours, son durationSeconds reflète le temps réellement
 * joué (pas la durée totale de la game). Le temps de jeu total est donc un
 * vrai "temps passé à jouer".
 */

/* ════════════════════════════════════════════════════════════════
   Helpers de formatage
   ════════════════════════════════════════════════════════════════ */

export function formatDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}j ${remH}h`;
}

export function formatDurationCompact(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}j ${remH}h`;
}

export function formatPct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

export function formatFrenchDate(ms) {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(ms));
  } catch { return "—"; }
}

/* ════════════════════════════════════════════════════════════════
   Classification des games
   ════════════════════════════════════════════════════════════════ */

export function classifyGame(g) {
  const mode = String(g.mode || "").toLowerCase();
  const rt = String(g.rankedType || "").toLowerCase();
  const isTeam =
    mode === "team" ||
    mode.startsWith("2v2") ||
    mode.startsWith("3v3") ||
    mode.startsWith("4v4") ||
    rt === "2v2";
  const isRanked = rt === "1v1" || rt === "2v2" || rt === "ranked";
  if (isTeam) return isRanked ? "teamRanked" : "teamCasual";
  return isRanked ? "ffaRanked" : "ffaCasual";
}

export function gameDurationSec(g) {
  const d = g.durationSeconds ?? g.duration;
  const n = typeof d === "number" ? d : parseFloat(String(d ?? "0"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function gameVisibility(g) {
  const v = String(g.visibility || "").toLowerCase();
  if (v === "private") return "private";
  if (v === "singleplayer" || v === "single") return "singleplayer";
  if (v === "public") return "public";
  const rt = String(g.rankedType || "").toLowerCase();
  if (rt === "singleplayer") return "singleplayer";
  return "public";
}

/* ════════════════════════════════════════════════════════════════
   Calcul complet des stats
   ════════════════════════════════════════════════════════════════ */

/**
 * Calcule le temps de jeu + stats par carte + activité depuis une liste de games.
 */
export function computePlaytimeStats(games) {
  let totalPlaytimeSec = 0;
  let longestGameSec = 0;
  let shortestGameSec = Infinity;

  const byCategory = {
    ffaCasual:  { games: 0, playtimeSec: 0, wins: 0 },
    ffaRanked:  { games: 0, playtimeSec: 0, wins: 0 },
    teamCasual: { games: 0, playtimeSec: 0, wins: 0 },
    teamRanked: { games: 0, playtimeSec: 0, wins: 0 },
  };
  const byVisibility = { public: 0, private: 0, singleplayer: 0 };
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const byDayMap = new Map();
  const results = { victory: 0, defeat: 0, incomplete: 0, other: 0 };
  const mapAgg = new Map();
  const modeAgg = new Map();

  for (const g of games) {
    const dur = gameDurationSec(g);
    totalPlaytimeSec += dur;
    if (dur > longestGameSec) longestGameSec = dur;
    if (dur > 0 && dur < shortestGameSec) shortestGameSec = dur;

    const cat = classifyGame(g);
    byCategory[cat].games++;
    byCategory[cat].playtimeSec += dur;
    if (g.result === "victory") byCategory[cat].wins++;

    byVisibility[gameVisibility(g)]++;

    if (g.start) {
      const t = new Date(g.start).getTime();
      if (Number.isFinite(t)) {
        try {
          const hourStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Paris", hour: "2-digit", hour12: false,
          }).format(new Date(t));
          const hour = parseInt(hourStr, 10);
          if (hour >= 0 && hour < 24) byHour[hour]++;

          const weekdayStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Paris", weekday: "short",
          }).format(new Date(t));
          const wdMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
          const wd = wdMap[weekdayStr];
          if (wd != null) byWeekday[wd]++;

          const dayKey = new Intl.DateTimeFormat("fr-FR", {
            timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric",
          }).format(new Date(t));
          const existing = byDayMap.get(dayKey) || { count: 0, playtimeSec: 0 };
          existing.count++;
          existing.playtimeSec += dur;
          byDayMap.set(dayKey, existing);
        } catch { /* ignore TZ errors */ }
      }
    }

    if (g.result === "victory") results.victory++;
    else if (g.result === "defeat") results.defeat++;
    else if (g.result === "incomplete") results.incomplete++;
    else results.other++;

    const mapName = g.map || "Inconnue";
    const t = g.start ? new Date(g.start).getTime() : 0;
    const m = mapAgg.get(mapName) || {
      count: 0, wins: 0, losses: 0, incompletes: 0, playtimeSec: 0, lastPlayed: 0,
    };
    m.count++;
    m.playtimeSec += dur;
    if (g.result === "victory") m.wins++;
    else if (g.result === "defeat") m.losses++;
    else if (g.result === "incomplete") m.incompletes++;
    if (t > m.lastPlayed) m.lastPlayed = t;
    mapAgg.set(mapName, m);

    const modeName = g.mode || "Inconnu";
    const mo = modeAgg.get(modeName) || { count: 0, playtimeSec: 0, wins: 0 };
    mo.count++;
    mo.playtimeSec += dur;
    if (g.result === "victory") mo.wins++;
    modeAgg.set(modeName, mo);
  }

  const byMap = [...mapAgg.entries()].map(([map, a]) => ({
    map,
    count: a.count,
    wins: a.wins,
    losses: a.losses,
    incompletes: a.incompletes,
    playtimeSec: a.playtimeSec,
    avgDuration: a.count > 0 ? a.playtimeSec / a.count : 0,
    winRate: a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : 0,
    lastPlayed: a.lastPlayed,
  })).sort((a, b) => b.count - a.count);

  const byMode = [...modeAgg.entries()].map(([mode, a]) => ({ mode, ...a })).sort((a, b) => b.count - a.count);

  const byDay = [...byDayMap.entries()].map(([date, a]) => ({ date, ...a }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);

  // Streaks
  const sortedByDateDesc = [...games].filter((g) => g.start)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  let currentStreak = 0;
  for (const g of sortedByDateDesc) {
    if (g.result === "victory") currentStreak++;
    else break;
  }
  const sortedAsc = [...games].filter((g) => g.start)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  let bestStreak = 0;
  let running = 0;
  for (const g of sortedAsc) {
    if (g.result === "victory") {
      running++;
      if (running > bestStreak) bestStreak = running;
    } else {
      running = 0;
    }
  }

  return {
    totalGames: games.length,
    totalPlaytimeSec,
    avgGameDurationSec: games.length > 0 ? totalPlaytimeSec / games.length : 0,
    longestGameSec,
    shortestGameSec: shortestGameSec === Infinity ? 0 : shortestGameSec,
    byCategory,
    byVisibility,
    byMap,
    byMode,
    byHour,
    byWeekday,
    byDay,
    results,
    currentStreak,
    bestStreak,
  };
}

/* ════════════════════════════════════════════════════════════════
   Extraction des wins carrière depuis l'objet stats agrégé
   ════════════════════════════════════════════════════════════════ */

export function extractCareerWins(stats) {
  const w = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  if (!stats || typeof stats !== "object") return w;

  const CASUAL_VIS = ["Public", "Private", "Singleplayer"];
  const FFA_MODES = ["Free For All", "Humans Vs Nations"];
  for (const vis of CASUAL_VIS) {
    const visData = stats[vis];
    if (!visData) continue;
    for (const mode of FFA_MODES) {
      const modeData = visData[mode];
      if (!modeData) continue;
      for (const diff of Object.keys(modeData)) {
        const d = modeData[diff];
        if (d && d.wins != null) w.ffaCasual += Number(d.wins) || 0;
      }
    }
    const teamData = visData["Team"];
    if (teamData) {
      for (const diff of Object.keys(teamData)) {
        const d = teamData[diff];
        if (d && d.wins != null) w.teamCasual += Number(d.wins) || 0;
      }
    }
  }

  const r1 = stats.Ranked && stats.Ranked["1v1"];
  if (r1 && r1.wins != null) w.ffaRanked = Number(r1.wins) || 0;
  const r2 = stats.Ranked && stats.Ranked["2v2"];
  if (r2 && r2.wins != null) w.teamRanked = Number(r2.wins) || 0;

  return w;
}

export function totalWins(w) {
  return (w.ffaCasual || 0) + (w.ffaRanked || 0) + (w.teamCasual || 0) + (w.teamRanked || 0);
}

export function pointsFor(w) {
  const PTS_FFA_CASUAL = 10, PTS_FFA_RANKED = 1, PTS_TEAM_CASUAL = 5, PTS_TEAM_RANKED = 1;
  return (w.ffaCasual || 0) * PTS_FFA_CASUAL +
         (w.ffaRanked || 0) * PTS_FFA_RANKED +
         (w.teamCasual || 0) * PTS_TEAM_CASUAL +
         (w.teamRanked || 0) * PTS_TEAM_RANKED;
}

export function formatPoints(n) {
  try { return new Intl.NumberFormat("fr-FR").format(n || 0); }
  catch { return String(n || 0); }
}
