// Decoder for OpenFront's /lobbies WebSocket, which speaks "zbin" — the
// game's custom binary serialization (see OpenFrontIO/zbin) — instead of JSON.
//
// A zbin payload is a bare positional byte stream with no version byte and no
// field tags: the schema IS the format. This file mirrors the exact wire
// layout of PublicLobbyMessageSchema in OpenFrontIO/src/core/Schemas.ts:
//
//   frame        = varint union tag (0 = "full", 1 = "counts") + object body
//   object       = ceil(bits/8) presence-header bytes, then field bodies in
//                  declaration order. Bits are allocated per field, in
//                  declaration order, as (presence, null, bool-value) and
//                  packed LSB-first. Booleans and single-value literals write
//                  no body bytes.
//   varint       = unsigned LEB128 (arithmetic, full 2^53 range)
//   string       = varint byte length + UTF-8
//   float        = float64 little-endian (8 bytes)
//   enum         = varint ordinal in declaration order
//   array        = varint count + elements
//   record       = varint count + (key, value) pairs; keys are enum ordinals
//                  for partialRecord(enum, …) or plain strings otherwise
//   union        = varint variant tag + variant body
//
// ══ DUAL-STACK (v6.0) — fonctionne AVANT et APRÈS le passage à la v34 ══════
//
// Le jeu publie la v0.34.0 avec un schéma zbin MODIFIÉ (commit f02d746,
// 2026-09-12) :
//   1. PublicLobbyFull gagne `gitCommit: string.optional()` et
//      `active: boolean.optional()` (en fin d'objet) → le header de présence
//      passe de 0 octet à 1 octet (3 bits).
//   2. GameConfig regagne `trusted: boolean.optional()` (entre
//      allowedPublicIds et maxTimerValue) → +2 bits, décale tout ce qui suit.
//   3. L'enum GameMapType passe de 117 (prod live, SANS Yangtze River) à 123
//      maps (+ Yangtze River, Cape Cod, Central America, Channel Islands,
//      Gulf Of Mexico, Qing China — insérées AU MILIEU de l'enum).
//
// Toute insertion/réordonnancement change le layout : client et serveur
// doivent partager le même schéma. Ce décodeur gère les DEUX :
//   - variante "legacy" = prod live actuelle (bundles blue/green 577819b /
//     8b45be5, vérifiées le 2026-09-14 : 117 maps, pas de trusted,
//     pas de gitCommit/active) ;
//   - variante "v34" = repo openfrontio/OpenFrontIO main @ 1fdd75a
//     (futur déploiement v0.34.0).
//
// Détection par frame (déterministe) : dans un message "full" LEGACY, l'octet
// qui suit le tag d'union est le PREMIER OCTET du varint serverTime — or
// serverTime = Date.now() (millisecondes) ⇒ toujours ≥ 128 ⇒ bit de
// continuation (MSB) toujours à 1. En V34, cet octet est le header de
// présence de PublicLobbyFull (3 bits utilisés au max) ⇒ valeur 0x00-0x07,
// MSB toujours à 0. On décode avec la variante détectée ; en cas d'échec on
// retente avec l'autre (ceinture + bretelles). Les messages "counts" sont
// identiques dans les deux variantes.
//
// ── Historique de synchro schéma ────────────────────────────────────────────
//   2026-09-14 : v6.0 — DUAL-STACK. Ajout variante v34 (123 maps + trusted +
//   gitCommit/active) avec auto-détection par frame. Correction d'un bug
//   préexistant : la liste v5.14 (118 maps) contenait « Yangtze River » alors
//   que la prod live n'en a PAS (117 vérifiés dans les bundles blue/green) —
//   les lobbies Yellow Sea / Yenisei étaient décalés d'un cran à l'affichage.
//   2026-09-04 : v5.14 — `trusted` RETIRÉ de GameConfig : le déploiement du
//   soir (numWorkers 5→20) l'avait supprimé du schéma amont. (Re-devenu
//   pertinent en v34 : le champ est RÉINTRODUIT par f02d746 — géré par la
//   variante v34, pas par la variante legacy.)
//   2026-09-03 : v5.13 — GameConfig gagne `trusted` (commit #5127), puis
//   PublicGameModifiers perd `isOvertime` (#5159, overtime par défaut).
(function (global) {
  "use strict";

  // --- Enum tables (declaration order = wire ordinal) -----------------------

  // src/core/game/Maps.gen.ts — GameMapType, variante LEGACY (prod live
  // 2026-09-14, bundles blue 8b45be5 / green 577819b — 117 entrées, SANS
  // Yangtze River : vérifié dans le bundle compilé, enum GameMapType complet).
  const GAME_MAP_LEGACY = [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics",
    "Bering Sea", "Bering Strait", "Between Two Seas", "Black Sea",
    "Bosphorus Straits", "Branching Paths", "Britannia", "Britannia Classic",
    "Caribbean", "Caspian Sea", "Caucasus", "China", "Chopping Block",
    "Clearwater Lakes", "Conakry", "Crimea", "Danish Straits",
    "Deglaciated Antarctica", "Didier", "Didier France", "Dyslexdria",
    "East Asia", "Europe", "Europe Classic", "Falkland Islands",
    "Faroe Islands", "Finger Lakes", "Four Islands", "France",
    "Gateway to the Atlantic", "Germany", "Giant World Map", "Great Lakes",
    "Gulf Of Guinea", "Gulf of St. Lawrence", "Halkidiki", "Hawaii",
    "Hecate Strait", "Hong Kong", "Iceland", "Indian Subcontinent",
    "Irish Sea", "Italia", "Japan", "Juan De Fuca Strait", "Korea",
    "Labyrinth", "Las Vegas Strip", "Lemnos", "Levant", "Lisbon",
    "Los Angeles", "Luna", "Manicouagan", "Mare Nostrum", "Mars", "Mena",
    "Middle East", "MilkyWay", "Mississippi River", "Montreal",
    "More Than Luck", "New York City", "Nile Delta", "North America",
    "Northwest Passage", "Oceania", "Onion", "Pangaea", "Passage", "Pluto",
    "Russia", "San Francisco", "Scandinavia", "Sierpinski", "Sol",
    "South America", "SoutheastAsia", "Strait of Gibraltar",
    "Strait of Hormuz", "Strait Of Malacca", "Surrounded", "Svalmel",
    "Taiwan Strait", "The Box", "Tierra Del Fuego", "Titan",
    "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams",
    "Tourney 8 Teams", "Traders Dream", "Two Lakes", "United States",
    "Venice", "Vietnam", "Warship Warship", "World", "World Inverted",
    "Yellow Sea", "Yenisei",
  ];

  // Variante V34 (repo main @ 1fdd75a, commit f02d746 « clean-room » du
  // 2026-09-12 + Channel Islands #5407) — 123 entrées. Insérations AU MILIEU
  // de l'enum : tout ce qui suit se décale d'autant.
  //   CapeCod après BritanniaClassic ; CentralAmerica + ChannelIslands après
  //   Caucasus ; GulfOfMexico après GulfOfGuinea ; QingChina après Pluto ;
  //   YangtzeRiver après WorldInverted.
  const GAME_MAP_V34 = [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics",
    "Bering Sea", "Bering Strait", "Between Two Seas", "Black Sea",
    "Bosphorus Straits", "Branching Paths", "Britannia", "Britannia Classic",
    "Cape Cod", "Caribbean", "Caspian Sea", "Caucasus", "Central America",
    "Channel Islands", "China", "Chopping Block", "Clearwater Lakes",
    "Conakry", "Crimea", "Danish Straits", "Deglaciated Antarctica",
    "Didier", "Didier France", "Dyslexdria", "East Asia", "Europe",
    "Europe Classic", "Falkland Islands", "Faroe Islands", "Finger Lakes",
    "Four Islands", "France", "Gateway to the Atlantic", "Germany",
    "Giant World Map", "Great Lakes", "Gulf Of Guinea", "Gulf Of Mexico",
    "Gulf of St. Lawrence", "Halkidiki", "Hawaii", "Hecate Strait",
    "Hong Kong", "Iceland", "Indian Subcontinent", "Irish Sea", "Italia",
    "Japan", "Juan De Fuca Strait", "Korea", "Labyrinth", "Las Vegas Strip",
    "Lemnos", "Levant", "Lisbon", "Los Angeles", "Luna", "Manicouagan",
    "Mare Nostrum", "Mars", "Mena", "Middle East", "MilkyWay",
    "Mississippi River", "Montreal", "More Than Luck", "New York City",
    "Nile Delta", "North America", "Northwest Passage", "Oceania", "Onion",
    "Pangaea", "Passage", "Pluto", "Qing China", "Russia", "San Francisco",
    "Scandinavia", "Sierpinski", "Sol", "South America", "SoutheastAsia",
    "Strait of Gibraltar", "Strait of Hormuz", "Strait Of Malacca",
    "Surrounded", "Svalmel", "Taiwan Strait", "The Box", "Tierra Del Fuego",
    "Titan", "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams",
    "Tourney 8 Teams", "Traders Dream", "Two Lakes", "United States",
    "Venice", "Vietnam", "Warship Warship", "World", "World Inverted",
    "Yangtze River", "Yellow Sea", "Yenisei",
  ];

  // src/core/game/Game.ts
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

  // src/core/Schemas.ts
  const PUBLIC_GAME_TYPE = ["ffa", "team", "special", "hosted"];
  const LOBBY_ACCENT = ["gold", "blue", "green", "red"];
  const DOOMSDAY_SPEED = ["slow", "normal", "fast", "veryfast"];
  const NATIONS_PRESET = ["default", "disabled"];

  // --- Byte reader -----------------------------------------------------------

  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;

  class ZbinDecodeError extends Error {
    constructor(message) {
      super(message);
      this.name = "ZbinDecodeError";
    }
  }

  class Reader {
    constructor(buf) {
      this.buf = buf;
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.pos = 0;
    }
    get remaining() {
      return this.buf.length - this.pos;
    }
    need(n) {
      if (this.pos + n > this.buf.length) {
        throw new ZbinDecodeError("unexpected end of input");
      }
    }
    u8() {
      this.need(1);
      return this.buf[this.pos++];
    }
    uint() {
      let result = 0;
      let mult = 1;
      for (;;) {
        const b = this.u8();
        result += (b & 0x7f) * mult;
        if ((b & 0x80) === 0) break;
        mult *= 0x80;
        if (mult > MAX_SAFE) throw new ZbinDecodeError("varint too large");
      }
      if (result > MAX_SAFE) throw new ZbinDecodeError("varint too large");
      return result;
    }
    f64() {
      this.need(8);
      const v = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    }
    str() {
      const len = this.uint();
      this.need(len);
      try {
        return textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
      } finally {
        this.pos += len;
      }
    }
    count(path) {
      const n = this.uint();
      // Every element here costs at least one byte, so a count past the
      // remaining input is corrupt — refuse before allocating.
      if (n > this.remaining) {
        throw new ZbinDecodeError(`${path}: implausible count ${n}`);
      }
      return n;
    }
    expectEnd() {
      if (this.remaining !== 0) {
        throw new ZbinDecodeError(`${this.remaining} trailing byte(s)`);
      }
    }
  }

  // --- Mini schema interpreter (mirrors zbin's derived codecs) ---------------

  // Field: { key, type, opt, nul }. Types:
  //   "uint" | "f64" | "str" | "bool"
  //   { enum: [...] } | { const: value } | { obj: fields }
  //   { arr: type } | { recordEnum: [keys], val: type } | { recordStr: type }
  //   { union: [types] }
  const f = (key, type, mods) => ({
    key,
    type,
    opt: !!(mods && mods.opt),
    nul: !!(mods && mods.nul),
  });

  function decodeEnum(r, values, path) {
    const idx = r.uint();
    // Tolerated (unlike the game client): a newly shipped map or unit only
    // makes this ordinal unknown, and the dashboard can still render the rest.
    return idx < values.length ? values[idx] : `unknown#${idx}`;
  }

  function decodeValue(r, type, path) {
    if (type === "uint") return r.uint();
    if (type === "f64") return r.f64();
    if (type === "str") return r.str();
    if (type === "bool") {
      const b = r.u8();
      if (b > 1) throw new ZbinDecodeError(`${path}: invalid boolean ${b}`);
      return b === 1;
    }
    if (type.enum) return decodeEnum(r, type.enum, path);
    if ("const" in type) return type.const;
    if (type.obj) return decodeObject(r, type.obj, path);
    if (type.arr) {
      const n = r.count(path);
      const out = [];
      for (let i = 0; i < n; i++) out.push(decodeValue(r, type.arr, path + "[]"));
      return out;
    }
    if (type.recordEnum) {
      const n = r.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = decodeEnum(r, type.recordEnum, path + "{key}");
        out[k] = decodeValue(r, type.val, path + "{}");
      }
      return out;
    }
    if (type.recordStr) {
      const n = r.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = r.str();
        if (k === "__proto__") {
          throw new ZbinDecodeError(`${path}: forbidden key __proto__`);
        }
        out[k] = decodeValue(r, type.recordStr, path + "{}");
      }
      return out;
    }
    if (type.union) {
      const idx = r.uint();
      if (idx >= type.union.length) {
        throw new ZbinDecodeError(`${path}: union tag ${idx} out of range`);
      }
      return decodeValue(r, type.union[idx], `${path}|${idx}`);
    }
    throw new ZbinDecodeError(`${path}: bad type descriptor`);
  }

  // Mirrors zbin objectCodec: allocate bits per field in declaration order as
  // (presence, null, bool-value); header is ceil(bits/8) bytes, LSB-first.
  function planObject(fields) {
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

  function decodeObject(r, objSpec, path) {
    const { plans, headerBytes } = objSpec._plan || (objSpec._plan = planObject(objSpec.fields));
    r.need(headerBytes);
    const header = r.buf.subarray(r.pos, r.pos + headerBytes);
    r.pos += headerBytes;
    const bit = (i) => (header[i >> 3] & (1 << (i & 7))) !== 0;

    const out = {};
    for (const p of plans) {
      const field = p.field;
      if (p.presenceBit >= 0 && !bit(p.presenceBit)) continue;
      if (p.nullBit >= 0 && bit(p.nullBit)) {
        out[field.key] = null;
        continue;
      }
      if (p.isBool) {
        out[field.key] = bit(p.valueBit);
      } else if (p.isConst) {
        out[field.key] = field.type.const;
      } else {
        out[field.key] = decodeValue(r, field.type, `${path}.${field.key}`);
      }
    }
    return out;
  }

  const obj = (fields) => ({ obj: { fields } });

  // --- Schemas (field order = Schemas.ts declaration order) ------------------

  const DoomsdayClockConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("speed", { enum: DOOMSDAY_SPEED }, { opt: true }),
  ]);

  const OvertimeConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("startMinutes", "uint", { opt: true }),
  ]);

  const PublicGameModifiers = obj([
    f("isCompact", "bool", { opt: true }),
    f("isRandomSpawn", "bool", { opt: true }),
    f("isCrowded", "bool", { opt: true }),
    f("isHardNations", "bool", { opt: true }),
    f("startingGold", "uint", { opt: true }),
    f("goldMultiplier", "f64", { opt: true }),
    f("isAlliancesDisabled", "bool", { opt: true }),
    f("isPortsDisabled", "bool", { opt: true }),
    f("isNukesDisabled", "bool", { opt: true }),
    f("isSAMsDisabled", "bool", { opt: true }),
    f("isPeaceTime", "bool", { opt: true }),
    f("isWaterNukes", "bool", { opt: true }),
    f("isDoomsdayClock", "bool", { opt: true }),
    // ⚠️ `isOvertime` retiré du schéma amont (v5.13, overtime par défaut) —
    // ne PAS le réajouter : c'était le dernier champ, sans effet de décalage,
    // mais il fausserait la lecture des bits à venir.
  ]);

  const HostCheats = obj([
    f("infiniteGold", "bool", { opt: true }),
    f("infiniteTroops", "bool", { opt: true }),
    f("goldMultiplier", "f64", { opt: true, nul: true }),
    f("startingGold", "uint", { opt: true, nul: true }),
  ]);

  // Champs communs legacy/v34 (tout sauf `trusted`).
  function gameConfigCommonFields() {
    return [
      f("gameMap", { enum: GAME_MAP_LEGACY }), // enum substitué par variante
      f("difficulty", { enum: DIFFICULTY }),
      f("donateGold", "bool"),
      f("donateTroops", "bool"),
      f("gameType", { enum: GAME_TYPE }),
      f("gameMode", { enum: GAME_MODE }),
      f("rankedType", { enum: RANKED_TYPE }, { opt: true }),
      f("gameMapSize", { enum: GAME_MAP_SIZE }),
      f("doomsdayClock", DoomsdayClockConfig, { opt: true }),
      f("overtime", OvertimeConfig, { opt: true }),
      f("publicGameModifiers", PublicGameModifiers, { opt: true }),
      f("nations", { union: ["uint", { enum: NATIONS_PRESET }] }),
      f("bots", "uint"),
      f("infiniteGold", "bool"),
      f("infiniteTroops", "bool"),
      f("instantBuild", "bool"),
      f("disableNavMesh", "bool", { opt: true }),
      f("disableAlliances", "bool", { opt: true, nul: true }),
      f("disableClanTags", "bool", { opt: true }),
      f("liveStatsEnabled", "bool", { opt: true }),
      f("anonymizeNames", "bool", { opt: true }),
      f("nameReveals", { arr: "str" }, { opt: true }),
      f("nameRevealPublicIds", { arr: "str" }, { opt: true }),
      f("waterNukes", "bool", { opt: true, nul: true }),
      f("randomSpawn", "bool"),
      f("maxPlayers", "uint", { opt: true }),
      f("allowedPublicIds", { arr: "str" }, { opt: true }),
    ];
  }

  // Queue de GameConfig après allowedPublicIds : la v34 réinsère `trusted`
  // (commit f02d746) ENTRE allowedPublicIds et maxTimerValue → +2 bits,
  // toutes les fields suivantes sont décalées.
  function gameConfigTailFields(variant) {
    const tail = [];
    if (variant === "v34") {
      tail.push(f("trusted", "bool", { opt: true }));
    }
    tail.push(
      f("maxTimerValue", "uint", { opt: true, nul: true }),
      f("customAllianceDuration", "uint", { opt: true, nul: true }),
      f("startDelay", "uint", { opt: true, nul: true }),
      f("spawnImmunityDuration", "uint", { opt: true, nul: true }),
      f("disabledUnits", { arr: { enum: UNIT_TYPE } }, { opt: true }),
      // TeamCountConfig: uint | "Duos" | "Trios" | "Quads" | "Humans Vs Nations"
      f(
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
      f("goldMultiplier", "f64", { opt: true, nul: true }),
      f("startingGold", "uint", { opt: true, nul: true }),
      f("hostCheats", HostCheats, { opt: true }),
    );
    return tail;
  }

  // Construit les objets-schémas pour UNE variante ("legacy" | "v34").
  // Les enums maps diffèrent → une instance GameConfig/PublicGameInfo par
  // variante (les _plan sont mémoïsés par objet, il faut donc des objets
  // distincts, d'où la factory).
  function buildVariant(variant) {
    const mapTable = variant === "v34" ? GAME_MAP_V34 : GAME_MAP_LEGACY;

    const GameConfig = obj(
      gameConfigCommonFields()
        .map((fld) =>
          fld.key === "gameMap" ? f("gameMap", { enum: mapTable }) : fld,
        )
        .concat(gameConfigTailFields(variant)),
    );

    const PublicGameInfo = obj([
      f("gameID", "str"),
      f("numClients", "uint"),
      f("startsAt", "uint", { opt: true }),
      f("gameConfig", GameConfig, { opt: true }),
      f("publicGameType", { enum: PUBLIC_GAME_TYPE }),
      f("label", "str", { opt: true }),
      f("accent", { enum: LOBBY_ACCENT }, { opt: true }),
      f("featured", "bool", { opt: true }),
    ]);

    const PublicLobbyFull = obj([
      f("type", { const: "full" }),
      f("serverTime", "uint"),
      f("games", { recordEnum: PUBLIC_GAME_TYPE, val: { arr: PublicGameInfo } }),
    ]);

    // V34 : PublicLobbyFull gagne gitCommit + active (f02d746) → le header de
    // présence passe de 0 octet (legacy) à 1 octet (3 bits).
    if (variant === "v34") {
      PublicLobbyFull.obj.fields.push(
        f("gitCommit", "str", { opt: true }),
        f("active", "bool", { opt: true }),
      );
      delete PublicLobbyFull.obj._plan; // re-planifier avec les nouveaux champs
    }

    const PublicLobbyCounts = obj([
      f("type", { const: "counts" }),
      f("serverTime", "uint"),
      f("counts", { recordStr: "uint" }),
    ]);

    return { variant, PublicLobbyFull, PublicLobbyCounts };
  }

  const VARIANTS = { legacy: buildVariant("legacy"), v34: buildVariant("v34") };

  // ── Détection de variante (messages "full") ──────────────────────────────
  // LEGACY : octet après le tag = 1er octet du varint serverTime (Date.now()
  // en ms ⇒ ≥ 128 ⇒ MSB à 1). V34 : octet après le tag = header de présence
  // de PublicLobbyFull (3 bits) ⇒ ≤ 0x07, MSB à 0. Déterministe tant que
  // serverTime est un timestamp ms (i.e. toujours).
  function detectVariant(bytes, startPos) {
    const b = bytes[startPos];
    if (b === undefined) throw new ZbinDecodeError("empty frame body");
    return (b & 0x80) === 0 ? "v34" : "legacy";
  }

  // Sanity-check du message décodé : serverTime doit ressembler à un
  // timestamp ms plausible (≥ 2^30, i.e. après 2004) — protège contre une
  // variante mal détectée qui « réussirait » par hasard.
  function looksValid(msg) {
    return (
      msg &&
      typeof msg === "object" &&
      typeof msg.serverTime === "number" &&
      Number.isFinite(msg.serverTime) &&
      msg.serverTime >= 0x40000000 &&
      msg.games && typeof msg.games === "object"
    );
  }

  function decodeLobbyMessage(bytes) {
    const r = new Reader(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    const tag = r.uint();
    if (tag >= 2) {
      throw new ZbinDecodeError(`lobby message tag ${tag} out of range`);
    }
    if (tag === 1) {
      // "counts" : schéma identique legacy/v34.
      const msg = decodeValue(r, VARIANTS.legacy.PublicLobbyCounts, "$");
      r.expectEnd();
      return msg;
    }
    // tag === 0 → "full" : choisir la variante puis décoder.
    const guessed = detectVariant(r.buf, r.pos);
    const order = guessed === "v34" ? ["v34", "legacy"] : ["legacy", "v34"];
    let lastErr = null;
    for (const name of order) {
      const sub = new Reader(r.buf);
      sub.pos = r.pos; // repart après le tag
      try {
        const msg = decodeValue(sub, VARIANTS[name].PublicLobbyFull, "$");
        sub.expectEnd();
        if (!looksValid(msg)) {
          throw new ZbinDecodeError("decoded message failed sanity check");
        }
        if (name === "v34" && (msg.gitCommit || msg.active === false)) {
          // champs v34 déjà portés par le message (utile au debug)
        }
        msg._schema = name; // métadonnée (ignorée par les consommateurs)
        return msg;
      } catch (e) {
        lastErr = e;
        if (e.name !== "ZbinDecodeError") throw e;
        // sinon : on tente l'autre variante
      }
    }
    throw lastErr || new ZbinDecodeError("undecodable frame");
  }

  const api = {
    decodeLobbyMessage,
    ZbinDecodeError,
    // Exposé pour les tests / diagnostics :
    GAME_MAP_LEGACY,
    GAME_MAP_V34,
    SCHEMA_VARIANTS: ["legacy", "v34"],
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.OpenFrontWire = api;
})(typeof window !== "undefined" ? window : globalThis);
