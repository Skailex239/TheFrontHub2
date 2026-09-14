// scripts/test-lobby-wire-v34.js — Tests non-régression du décodeur zbin
// dual-stack (legacy 117 maps + v34 123 maps + trusted + gitCommit/active).
//
// Approche : encodeur « spec-driven » (miroir exact de lobby-wire.js) qui
// encode des objets JS vers le format zbin, puis round-trip via
// decodeLobbyMessage(). 8 cas de test :
//   1. full legacy  — 0 octet de présence PublicLobbyFull, sans trusted
//   2. full v34     — gitCommit + active présents, GameConfig avec trusted
//   3. full v34     — gitCommit/active ABSENTS (header à 0x00) → détection
//                     v34 quand même (décision par MSB, pas par contenu)
//   4. counts       — identique dans les 2 variantes
//   5. full legacy  — map Yenisei (ordinal 116) : le bug du décalage v5.14
//                     est corrigé (décode Yenisei, pas Yellow Sea)
//   6. full v34     — map Channel Islands (ordinal 29) décodée correctement
//   7. full legacy  — lobbies FFA + team + hosted, configs réalistes
//                     (rankedType, playerTeams Duos, mods, hostCheats…)
//   8. full v34     — gameConfig omis (opt) + startsAt omis + label/accent/
//                     featured présents (lobby « hosted » featured)
//
// Usage : node scripts/test-lobby-wire-v34.js  (exit 0 = tout passe)

"use strict";

const assert = require("assert");
const {
  decodeLobbyMessage,
  GAME_MAP_LEGACY,
  GAME_MAP_V34,
} = require("../lobby-wire.js");

/* ════════════════════ Encodeur zbin (miroir du décodeur) ════════════════ */

class Writer {
  constructor() {
    this.chunks = [];
    this.len = 0;
  }
  u8(b) {
    this.chunks.push(b);
    this.len++;
  }
  bytes(arr) {
    for (const b of arr) this.u8(b);
  }
  uint(n) {
    n = Math.floor(n);
    if (n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error("varint range");
    // LEB128, LSB-first
    const out = [];
    let v = n;
    do {
      let b = v % 0x80;
      v = Math.floor(v / 0x80);
      if (v > 0) b |= 0x80;
      out.push(b);
    } while (v > 0);
    this.bytes(out);
  }
  f64(v) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, true);
    this.bytes(new Uint8Array(buf));
  }
  str(s) {
    const utf8 = Buffer.from(String(s), "utf8");
    this.uint(utf8.length);
    this.bytes(utf8);
  }
  done() {
    return Buffer.from(this.chunks);
  }
}

// Descripteurs de schéma côté encodeur — mêmes shapes que le décodeur.
// Field: { key, type, opt, nul }
const ef = (key, type, mods) => ({
  key,
  type,
  opt: !!(mods && mods.opt),
  nul: !!(mods && mods.nul),
});

const eobj = (fields) => ({ obj: { fields } });

function planEnc(fields) {
  let bits = 0;
  const plans = fields.map((field) => {
    const isBool = field.type === "bool";
    const isConst = typeof field.type === "object" && "const" in field.type;
    return {
      field,
      isBool,
      isConst,
      presenceBit: field.opt ? bits++ : -1,
      nullBit: field.nul ? bits++ : -1,
      valueBit: isBool ? bits++ : -1,
    };
  });
  return { plans, headerBytes: Math.ceil(bits / 8) };
}

function encodeValue(w, type, value) {
  if (type === "uint") return w.uint(value);
  if (type === "f64") return w.f64(value);
  if (type === "str") return w.str(value);
  if (type === "bool") return w.u8(value ? 1 : 0);
  if (typeof type === "string") throw new Error(`type non géré en amont: ${type}`);
  if (type.enum) {
    const idx = type.enum.indexOf(value);
    if (idx < 0) throw new Error(`enum ordinal introuvable: ${value}`);
    return w.uint(idx);
  }
  if ("const" in type) return; // pas de corps
  if (type.obj) return encodeObject(w, type.obj, value);
  if (type.arr) {
    w.uint(value.length);
    for (const el of value) encodeValue(w, type.arr, el);
    return;
  }
  if (type.recordEnum) {
    const entries = Object.entries(value);
    w.uint(entries.length);
    for (const [k, v] of entries) {
      const idx = type.recordEnum.indexOf(k);
      if (idx < 0) throw new Error(`record key inconnue: ${k}`);
      w.uint(idx);
      encodeValue(w, type.val, v);
    }
    return;
  }
  if (type.recordStr) {
    const entries = Object.entries(value);
    w.uint(entries.length);
    for (const [k, v] of entries) {
      w.str(k);
      encodeValue(w, type.recordStr, v);
    }
    return;
  }
  if (type.union) {
    for (let i = 0; i < type.union.length; i++) {
      const t = type.union[i];
      if (t === "uint") {
        if (typeof value === "number") {
          w.uint(i);
          return encodeValue(w, "uint", value);
        }
        continue; // variante uint mais valeur non numérique
      } else if ("const" in t) {
        if (t.const === value) {
          w.uint(i);
          return; // variante const : pas de corps
        }
      } else if (t.enum && typeof value === "string") {
        w.uint(i);
        return encodeValue(w, t, value);
      }
    }
    throw new Error(`aucune variante d'union pour ${JSON.stringify(value)}`);
  }
  throw new Error("bad type descriptor");
}

function encodeObject(w, objSpec, value) {
  const { plans, headerBytes } = planEnc(objSpec.fields);
  // Header de présence
  const header = new Array(headerBytes).fill(0);
  const setBit = (i) => {
    header[i >> 3] |= 1 << (i & 7);
  };
  for (const p of plans) {
    const v = value[p.field.key];
    const present = !(p.field.opt) || v !== undefined;
    if (p.presenceBit >= 0 && present) setBit(p.presenceBit);
    if (p.nullBit >= 0 && v === null) setBit(p.nullBit);
    if (p.isBool && present && v === true) setBit(p.valueBit);
  }
  w.bytes(header);
  // Corps dans l'ordre de déclaration
  for (const p of plans) {
    const v = value[p.field.key];
    if (p.field.opt && v === undefined) continue;
    if (p.field.nul && v === null) continue;
    if (p.isBool) continue; // valeur dans le header
    if (p.isConst) continue;
    encodeValue(w, p.field.type, v);
  }
}

/* ════════════════════ Schémas de test (miroir lobby-wire v6) ════════════ */

const DIFFICULTY = ["Easy", "Medium", "Hard", "Impossible"];
const GAME_TYPE = ["Singleplayer", "Public", "Private"];
const GAME_MODE = ["Free For All", "Team"];
const RANKED_TYPE = ["1v1", "2v2"];
const GAME_MAP_SIZE = ["Compact", "Normal"];
const UNIT_TYPE = [
  "Transport", "Warship", "Shell", "SAMMissile", "Port", "Atom Bomb",
  "Hydrogen Bomb", "Trade Ship", "Missile Silo", "Defense Post",
  "SAM Launcher", "City", "MIRV", "MIRV Warhead", "Train", "Factory",
];
const PUBLIC_GAME_TYPE = ["ffa", "team", "special", "hosted"];
const LOBBY_ACCENT = ["gold", "blue", "green", "red"];
const DOOMSDAY_SPEED = ["slow", "normal", "fast", "veryfast"];
const NATIONS_PRESET = ["default", "disabled"];

function buildSchemas(variant, MAPS) {
  const DoomsdayClockConfig = eobj([
    ef("enabled", "bool", { opt: true }),
    ef("speed", { enum: DOOMSDAY_SPEED }, { opt: true }),
  ]);
  const OvertimeConfig = eobj([
    ef("enabled", "bool", { opt: true }),
    ef("startMinutes", "uint", { opt: true }),
  ]);
  const PublicGameModifiers = eobj([
    ef("isCompact", "bool", { opt: true }),
    ef("isRandomSpawn", "bool", { opt: true }),
    ef("isCrowded", "bool", { opt: true }),
    ef("isHardNations", "bool", { opt: true }),
    ef("startingGold", "uint", { opt: true }),
    ef("goldMultiplier", "f64", { opt: true }),
    ef("isAlliancesDisabled", "bool", { opt: true }),
    ef("isPortsDisabled", "bool", { opt: true }),
    ef("isNukesDisabled", "bool", { opt: true }),
    ef("isSAMsDisabled", "bool", { opt: true }),
    ef("isPeaceTime", "bool", { opt: true }),
    ef("isWaterNukes", "bool", { opt: true }),
    ef("isDoomsdayClock", "bool", { opt: true }),
  ]);
  const HostCheats = eobj([
    ef("infiniteGold", "bool", { opt: true }),
    ef("infiniteTroops", "bool", { opt: true }),
    ef("goldMultiplier", "f64", { opt: true, nul: true }),
    ef("startingGold", "uint", { opt: true, nul: true }),
  ]);
  const GameConfig = eobj([
    ef("gameMap", { enum: MAPS }),
    ef("difficulty", { enum: DIFFICULTY }),
    ef("donateGold", "bool"),
    ef("donateTroops", "bool"),
    ef("gameType", { enum: GAME_TYPE }),
    ef("gameMode", { enum: GAME_MODE }),
    ef("rankedType", { enum: RANKED_TYPE }, { opt: true }),
    ef("gameMapSize", { enum: GAME_MAP_SIZE }),
    ef("doomsdayClock", DoomsdayClockConfig, { opt: true }),
    ef("overtime", OvertimeConfig, { opt: true }),
    ef("publicGameModifiers", PublicGameModifiers, { opt: true }),
    ef("nations", { union: ["uint", { enum: NATIONS_PRESET }] }),
    ef("bots", "uint"),
    ef("infiniteGold", "bool"),
    ef("infiniteTroops", "bool"),
    ef("instantBuild", "bool"),
    ef("disableNavMesh", "bool", { opt: true }),
    ef("disableAlliances", "bool", { opt: true, nul: true }),
    ef("disableClanTags", "bool", { opt: true }),
    ef("liveStatsEnabled", "bool", { opt: true }),
    ef("anonymizeNames", "bool", { opt: true }),
    ef("nameReveals", { arr: "str" }, { opt: true }),
    ef("nameRevealPublicIds", { arr: "str" }, { opt: true }),
    ef("waterNukes", "bool", { opt: true, nul: true }),
    ef("randomSpawn", "bool"),
    ef("maxPlayers", "uint", { opt: true }),
    ef("allowedPublicIds", { arr: "str" }, { opt: true }),
    ...(variant === "v34" ? [ef("trusted", "bool", { opt: true })] : []),
    ef("maxTimerValue", "uint", { opt: true, nul: true }),
    ef("customAllianceDuration", "uint", { opt: true, nul: true }),
    ef("startDelay", "uint", { opt: true, nul: true }),
    ef("spawnImmunityDuration", "uint", { opt: true, nul: true }),
    ef("disabledUnits", { arr: { enum: UNIT_TYPE } }, { opt: true }),
    ef(
      "playerTeams",
      {
        union: [
          "uint",
          { const: "Duos" },
          { const: "Trios" },
          { const: "Quads" },
          { const: "Humans Vs Nations" },
        ],
      },
      { opt: true },
    ),
    ef("goldMultiplier", "f64", { opt: true, nul: true }),
    ef("startingGold", "uint", { opt: true, nul: true }),
    ef("hostCheats", HostCheats, { opt: true }),
  ]);
  const PublicGameInfo = eobj([
    ef("gameID", "str"),
    ef("numClients", "uint"),
    ef("startsAt", "uint", { opt: true }),
    ef("gameConfig", GameConfig, { opt: true }),
    ef("publicGameType", { enum: PUBLIC_GAME_TYPE }),
    ef("label", "str", { opt: true }),
    ef("accent", { enum: LOBBY_ACCENT }, { opt: true }),
    ef("featured", "bool", { opt: true }),
  ]);
  const PublicLobbyFullFields = [
    ef("type", { const: "full" }),
    ef("serverTime", "uint"),
    ef("games", { recordEnum: PUBLIC_GAME_TYPE, val: { arr: PublicGameInfo } }),
    ...(variant === "v34"
      ? [ef("gitCommit", "str", { opt: true }), ef("active", "bool", { opt: true })]
      : []),
  ];
  const PublicLobbyCounts = eobj([
    ef("type", { const: "counts" }),
    ef("serverTime", "uint"),
    ef("counts", { recordStr: "uint" }),
  ]);
  return { PublicLobbyFullFields, PublicLobbyCounts, PublicGameInfo };
}

const LEGACY = buildSchemas("legacy", GAME_MAP_LEGACY);
const V34 = buildSchemas("v34", GAME_MAP_V34);

function encodeFull(variant, msg) {
  const w = new Writer();
  w.uint(0); // tag "full"
  encodeObject(w, { fields: variant.PublicLobbyFullFields }, msg);
  return w.done();
}

function encodeCounts(msg) {
  const w = new Writer();
  w.uint(1);
  encodeObject(w, LEGACY.PublicLobbyCounts.obj, msg);
  return w.done();
}

/* ════════════════════ Fabriques de jeux réalistes ═══════════════════════ */

function makeGame(variant, over = {}) {
  const maps = variant === "v34" ? GAME_MAP_V34 : GAME_MAP_LEGACY;
  const cfg = {
    gameMap: maps[10], // Baikal
    difficulty: "Medium",
    donateGold: false,
    donateTroops: false,
    gameType: "Public",
    gameMode: "Free For All",
    gameMapSize: "Normal",
    nations: 0,
    bots: 25,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: true,
    ...over.cfg,
  };
  return {
    gameID: over.gameID || "aB3dEf9x",
    numClients: over.numClients ?? 12,
    ...("startsAt" in over ? { startsAt: over.startsAt } : { startsAt: 1789400000000 }),
    ...("gameConfig" in over ? { gameConfig: over.gameConfig } : { gameConfig: cfg }),
    publicGameType: over.publicGameType || "ffa",
    ...over.extra,
  };
}

function fullMsg(variant, games, extra = {}) {
  return {
    serverTime: 1789397114592,
    games,
    ...extra,
  };
}

/* ════════════════════════════ Les 8 tests ═══════════════════════════════ */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("Tests lobby-wire v6.0 (dual-stack legacy/v34)\n");

test("1. full LEGACY (sans trusted, 117 maps) → décodé en variante legacy", () => {
  const buf = encodeFull(LEGACY, fullMsg("legacy", { ffa: [makeGame("legacy")] }));
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg._schema, "legacy");
  assert.strictEqual(msg.games.ffa.length, 1);
  assert.strictEqual(msg.games.ffa[0].gameConfig.gameMap, "Baikal");
});

test("2. full V34 (gitCommit + active + trusted) → décodé en variante v34", () => {
  const buf = encodeFull(
    V34,
    fullMsg("v34", { ffa: [makeGame("v34", { cfg: { trusted: true } })] }, { gitCommit: "1fdd75a", active: true }),
  );
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg._schema, "v34");
  assert.strictEqual(msg.gitCommit, "1fdd75a");
  assert.strictEqual(msg.active, true);
  assert.strictEqual(msg.games.ffa[0].gameConfig.trusted, true);
});

test("3. full V34 sans gitCommit/active (header 0x00) → quand même v34", () => {
  const buf = encodeFull(V34, fullMsg("v34", { team: [makeGame("v34")] }));
  // Le premier octet du corps est 0x00 (header présence 3 bits tous à 0)
  assert.strictEqual(buf[1], 0x00, "header de présence v34 attendu à 0x00");
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg._schema, "v34");
  assert.strictEqual(msg.gitCommit, undefined);
  assert.strictEqual(msg.active, undefined);
  assert.strictEqual(msg.games.team.length, 1);
});

test("4. counts → décodé identique dans les 2 variantes", () => {
  const buf = encodeCounts({
    serverTime: 1789397114592,
    counts: { aB3dEf9x: 7, zZ9yX8w7: 0 },
  });
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg.type, "counts");
  assert.strictEqual(msg.counts.aB3dEf9x, 7);
  assert.strictEqual(msg.counts.zZ9yX8w7, 0);
});

test("5. full LEGACY map Yenisei (ord 116) → 'Yenisei' (bug décalage v5.14 corrigé)", () => {
  const yIdx = GAME_MAP_LEGACY.indexOf("Yenisei");
  assert.strictEqual(yIdx, 116, "Yenisei doit être l'ordinal 116 en legacy");
  const buf = encodeFull(
    LEGACY,
    fullMsg("legacy", {
      ffa: [makeGame("legacy", { cfg: { gameMap: "Yenisei" } })],
    }),
  );
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg.games.ffa[0].gameConfig.gameMap, "Yenisei");
});

test("6. full V34 map Channel Islands (ord 29) → 'Channel Islands'", () => {
  const cIdx = GAME_MAP_V34.indexOf("Channel Islands");
  assert.strictEqual(cIdx, 29, "Channel Islands doit être l'ordinal 29 en v34");
  const buf = encodeFull(
    V34,
    fullMsg("v34", { ffa: [makeGame("v34", { cfg: { gameMap: "Channel Islands" } })] }),
  );
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg.games.ffa[0].gameConfig.gameMap, "Channel Islands");
});

test("7. full LEGACY réaliste : FFA + team (Duos) + hosted (cheats, mods, ranked)", () => {
  const ffaGame = makeGame("legacy", {
    gameID: "fFa1aA2b",
    numClients: 40,
    cfg: {
      gameMap: "Europe",
      rankedType: "unranked" === "unranked" ? undefined : undefined,
      publicGameModifiers: {
        isCompact: false,
        isRandomSpawn: true,
        isCrowded: false,
        startingGold: 1000,
        goldMultiplier: 1.5,
      },
      disableAlliances: null,
      waterNukes: null,
      maxTimerValue: null,
    },
  });
  // rankedType absent si undefined
  delete ffaGame.gameConfig.rankedType;
  const teamGame = makeGame("legacy", {
    gameID: "tEa3mB4c",
    numClients: 8,
    publicGameType: "team",
    cfg: {
      gameMap: "Africa",
      gameMode: "Team",
      playerTeams: "Duos",
      bots: 0,
    },
  });
  const hostedGame = makeGame("legacy", {
    gameID: "hOs5tC6d",
    numClients: 2,
    publicGameType: "hosted",
    startsAt: 1789400500000,
    cfg: {
      gameMap: "Giant World Map",
      gameType: "Private",
      liveStatsEnabled: true,
      allowedPublicIds: ["hFaZs30i"],
      hostCheats: { infiniteGold: true, startingGold: 50000 },
      disabledUnits: ["Atom Bomb", "Hydrogen Bomb"],
      startDelay: 30,
      customAllianceDuration: 10,
      spawnImmunityDuration: 300,
      maxPlayers: 100,
    },
  });
  const buf = encodeFull(
    LEGACY,
    fullMsg("legacy", { ffa: [ffaGame], team: [teamGame], special: [], hosted: [hostedGame] }),
  );
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg._schema, "legacy");
  assert.strictEqual(msg.games.ffa[0].gameConfig.gameMap, "Europe");
  assert.strictEqual(msg.games.ffa[0].gameConfig.publicGameModifiers.goldMultiplier, 1.5);
  assert.strictEqual(msg.games.ffa[0].gameConfig.disableAlliances, null);
  assert.strictEqual(msg.games.team[0].gameConfig.playerTeams, "Duos");
  assert.strictEqual(msg.games.hosted[0].gameConfig.hostCheats.infiniteGold, true);
  assert.deepStrictEqual(msg.games.hosted[0].gameConfig.disabledUnits, [
    "Atom Bomb", "Hydrogen Bomb",
  ]);
  assert.strictEqual(msg.games.hosted[0].gameConfig.maxPlayers, 100);
});

test("8. full V34 hosted featured : gameConfig omis, label/accent/featured présents", () => {
  const g = makeGame("v34", {
    gameID: "v34hOsT1",
    gameConfig: undefined,
    publicGameType: "hosted",
    extra: {
      label: "Tournoi Skailex",
      accent: "gold",
      featured: true,
    },
  });
  const buf = encodeFull(
    V34,
    fullMsg("v34", { hosted: [g] }, { gitCommit: "577819ba0e1e13ecdbc8dede2ba33de542c88a67", active: false }),
  );
  const msg = decodeLobbyMessage(buf);
  assert.strictEqual(msg._schema, "v34");
  assert.strictEqual(msg.games.hosted[0].gameConfig, undefined);
  assert.strictEqual(msg.games.hosted[0].label, "Tournoi Skailex");
  assert.strictEqual(msg.games.hosted[0].accent, "gold");
  assert.strictEqual(msg.games.hosted[0].featured, true);
  assert.strictEqual(msg.gitCommit, "577819ba0e1e13ecdbc8dede2ba33de542c88a67");
  assert.strictEqual(msg.active, false);
});

// Test bonus : cohérence des tables
test("bonus. tables maps : legacy=117, v34=123, 5 insérations au milieu", () => {
  assert.strictEqual(GAME_MAP_LEGACY.length, 117);
  assert.strictEqual(GAME_MAP_V34.length, 123);
  for (const [name, after, before] of [
    ["Cape Cod", "Britannia Classic", "Caribbean"],
    ["Central America", "Caucasus", "China"],
    ["Channel Islands", "Central America", "China"],
    ["Gulf Of Mexico", "Gulf Of Guinea", "Gulf of St. Lawrence"],
    ["Qing China", "Pluto", "Russia"],
    ["Yangtze River", "World Inverted", "Yellow Sea"],
  ]) {
    const i = GAME_MAP_V34.indexOf(name);
    assert.ok(i > GAME_MAP_V34.indexOf(after), `${name} doit suivre ${after}`);
    assert.ok(i < GAME_MAP_V34.indexOf(before), `${name} doit précéder ${before}`);
    assert.strictEqual(GAME_MAP_LEGACY.indexOf(name), -1, `${name} absent en legacy`);
  }
});

console.log(`\n${passed}/9 tests passés`);
if (process.exitCode) {
  console.error("ÉCHEC");
  process.exit(1);
} else {
  console.log("OK — décodeur dual-stack validé");
}
