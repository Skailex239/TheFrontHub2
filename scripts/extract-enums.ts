// Extrait les valeurs des enums (ordre de déclaration = ordre ordinal zbin)
// via regex — sans importer le module (dépendances du dépôt non installées).
import * as fs from "node:fs";

const game = fs.readFileSync("/home/z/openfront-src/src/core/game/Game.ts", "utf8");
const maps = fs.readFileSync("/home/z/openfront-src/src/core/game/Maps.gen.ts", "utf8");

function extractEnum(src, name) {
  const m = src.match(new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`enum ${name} introuvable`);
  const values = [];
  for (const line of m[1].split("\n")) {
    const vm = line.match(/^\s*(\w+)\s*=\s*"([^"]+)"/);
    if (vm) values.push(vm[2]);
  }
  return values;
}

const data = {
  gameMap: extractEnum(maps, "GameMapType"),
  difficulty: extractEnum(game, "Difficulty"),
  gameType: extractEnum(game, "GameType"),
  gameMode: extractEnum(game, "GameMode"),
  rankedType: extractEnum(game, "RankedType"),
  gameMapSize: extractEnum(game, "GameMapSize"),
  unitType: extractEnum(game, "UnitType"),
};

fs.writeFileSync(
  "/home/z/my-project/scripts/zbin-enums.json",
  JSON.stringify(data, null, 1),
);
for (const [k, v] of Object.entries(data)) console.log(k, v.length);
console.log("gameMap[0..5]:", data.gameMap.slice(0, 5).join(" | "));
console.log("unitType:", data.unitType.join(", "));
