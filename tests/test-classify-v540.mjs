/* Test : port 1:1 de classify_speedrun (api/games-sync.php v5.40) — vérifie
 * la matrice de règles FFA normal/compact + team (miroir sync-teams.js). */
const TIME_OFFSET_S = 32;

function classify_speedrun(info) {
  const cfg = (info.config && typeof info.config === 'object') ? info.config : {};
  if (cfg.gameType !== 'Public') return [null, null, null, null];
  const mode = String(cfg.gameMode ?? '');
  const isTeamRun = mode === 'Team';
  if (!isTeamRun && mode !== 'Free For All') return [null, null, null, null];

  if (isTeamRun) {
    const pt = (typeof cfg.playerTeams === 'string') ? cfg.playerTeams : '';
    if (!['Duos', 'Trios', 'Quads', 'Humans Vs Nations'].includes(pt)) return [null, null, null, null];
  }

  let isCompact = null;
  if (cfg.gameMapSize === 'Compact' && Number(cfg.bots ?? 0) === 100) isCompact = true;
  else if (cfg.gameMapSize === 'Normal' && Number(cfg.bots ?? 0) === 400) isCompact = false;
  else return [null, null, null, null];
  if (isTeamRun && isCompact) return [null, null, null, null];

  const mods = (cfg.publicGameModifiers && typeof cfg.publicGameModifiers === 'object') ? cfg.publicGameModifiers : {};
  const active = Object.entries(mods).filter(([, v]) => v).map(([k]) => String(k));
  if (isCompact) { if (active.some(a => a !== 'isCompact')) return [null, null, null, null]; }
  else { if (active.length) return [null, null, null, null]; }

  if (cfg.randomSpawn === true) return [null, null, null, null];
  if (cfg.donateGold === true) return [null, null, null, null];
  if (cfg.donateTroops === true) return [null, null, null, null];
  if (cfg.infiniteGold) return [null, null, null, null];
  if (cfg.infiniteTroops) return [null, null, null, null];
  if (cfg.instantBuild) return [null, null, null, null];
  if (cfg.startingGold != null && Number(cfg.startingGold) !== 0) return [null, null, null, null];
  if (cfg.goldMultiplier != null && Number(cfg.goldMultiplier) !== 1) return [null, null, null, null];

  const players = Array.isArray(info.players) ? info.players : [];
  const minHumans = isCompact ? 3 : 10;
  if (players.length < minHumans) return [null, null, null, null];

  const winner = info.winner;
  if (!Array.isArray(winner) || winner.length < 2) return [null, null, null, null];
  const winnerKind = String(winner[0]);
  let winnerCid = null;
  if (isTeamRun) {
    if (winnerKind !== 'team') return [null, null, null, null];
  } else {
    if (winnerKind !== 'player') return [null, null, null, null];
    winnerCid = String(winner[1]);
    const wp = players.find(p => (p.clientID ?? null) === winnerCid);
    if (!wp || !wp.username) return [null, null, null, null];
  }

  let dur = null;
  if (info.duration != null && Number.isFinite(Number(info.duration))) {
    const d = Number(info.duration);
    dur = d > 100000 ? Math.round(d / 1000) : d;
  } else if (info.start != null && info.end != null) {
    const diff = Number(info.end) - Number(info.start);
    dur = diff > 100000 ? Math.round(diff / 1000) : diff;
  }
  if (dur == null || dur < 60) return [null, null, null, null];
  dur = Math.max(0, dur - TIME_OFFSET_S);

  return [isTeamRun ? 'team' : (isCompact ? 'compact' : 'normal'), dur, winnerCid, active.length ? active.slice(0, 6).join(',') : null];
}

// ── Cas de test ──
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
}
const players10 = Array.from({ length: 10 }, (_, i) => ({ clientID: 'c' + i, username: 'u' + i }));
const players9 = players10.slice(0, 9);
const players3 = players10.slice(0, 3);

// FFA normal valide
eq('FFA normal valide', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400 }, players: players10, winner: ['player', 'c1'], duration: 300 }), ['normal', 268, 'c1', null]);
// FFA compact valide (mod isCompact autorisé)
eq('FFA compact valide', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Compact', bots: 100, publicGameModifiers: { isCompact: true } }, players: players3, winner: ['player', 'c0'], duration: 120 }), ['compact', 88, 'c0', 'isCompact']);
// FFA compact sans mod isCompact : accepté par le miroir historique (seuls les
// mods AUTORISÉS-bis sont rejetés) — comportement prod inchangé.
eq('FFA compact sans badge isCompact', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Compact', bots: 100 }, players: players3, winner: ['player', 'c0'], duration: 120 }), ['compact', 88, 'c0', null]);
// FFA trop court
eq('FFA durée <60s', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400 }, players: players10, winner: ['player', 'c1'], duration: 59 }), [null, null, null, null]);
// FFA 9 joueurs normal → rejeté
eq('FFA 9 joueurs', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400 }, players: players9, winner: ['player', 'c1'], duration: 300 }), [null, null, null, null]);
// FFA mod actif → rejeté
eq('FFA mod doomsday', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400, publicGameModifiers: { isDoomsdayClock: true } }, players: players10, winner: ['player', 'c1'], duration: 300 }), [null, null, null, null]);
// FFA randomSpawn → rejeté
eq('FFA randomSpawn', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400, randomSpawn: true }, players: players10, winner: ['player', 'c1'], duration: 300 }), [null, null, null, null]);
// FFA Private → rejeté
eq('Private rejeté', classify_speedrun({ config: { gameType: 'Private', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400 }, players: players10, winner: ['player', 'c1'], duration: 300 }), [null, null, null, null]);
// FFA gagnant nation → rejeté
eq('FFA gagnant nation', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Free For All', gameMapSize: 'Normal', bots: 400 }, players: players10, winner: ['nation', 'x'] }), [null, null, null, null]);

// ── Team (v5.40, miroir sync-teams.js) ──
const teamWinner = ['team', 'Team 1', 'c0', 'c1'];
// Team Duos valide
eq('Team Duos valide', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Duos' }, players: players10, winner: teamWinner, duration: 450 }), ['team', 418, null, null]);
// Team Quads valide
eq('Team Quads valide', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Quads' }, players: players10, winner: ['team', 'Team 2', 'c0', 'c1', 'c2', 'c3'], duration: 610 }), ['team', 578, null, null]);
// Team HvN valide
eq('Team HvN valide', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Humans Vs Nations' }, players: players10, winner: ['team', 'Team 1', 'c0'], duration: 700 }), ['team', 668, null, null]);
// Team playerTeams NUMBER (grandes équipes couleur) → rejeté
eq('Team playerTeams=2 rejeté', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: '2' }, players: players10, winner: teamWinner, duration: 450 }), [null, null, null, null]);
// Team compact → rejeté (Normal+400 uniquement)
eq('Team compact rejeté', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Compact', bots: 100, playerTeams: 'Duos' }, players: players3, winner: teamWinner, duration: 450 }), [null, null, null, null]);
// Team 9 joueurs → rejeté
eq('Team 9 joueurs', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Duos' }, players: players9, winner: teamWinner, duration: 450 }), [null, null, null, null]);
// Team gagnant player (pas team) → rejeté
eq('Team gagnant player', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Duos' }, players: players10, winner: ['player', 'c0'], duration: 450 }), [null, null, null, null]);
// Team mod actif → rejeté
eq('Team mod actif', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Duos', publicGameModifiers: { isDoomsdayClock: true } }, players: players10, winner: teamWinner, duration: 450 }), [null, null, null, null]);
// Team durée en ms (records historiques) → OK
eq('Team durée ms', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Trios' }, players: players10, winner: teamWinner, duration: 450000 }), ['team', 418, null, null]);
// Sans winner → rejeté
eq('Team sans winner', classify_speedrun({ config: { gameType: 'Public', gameMode: 'Team', gameMapSize: 'Normal', bots: 400, playerTeams: 'Duos' }, players: players10, winner: null, duration: 450 }), [null, null, null, null]);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
