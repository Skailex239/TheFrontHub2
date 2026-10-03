// Remplace la liste gameMap du worker par la liste officielle EXACTE
// (générée depuis le dépôt OpenFrontIO) et revérifie.
import * as fs from "node:fs";

const enums = JSON.parse(fs.readFileSync("/home/z/my-project/scripts/zbin-enums.json", "utf8"));
const workerPath = "/home/z/my-project/download/openfront-worker.js";
let src = fs.readFileSync(workerPath, "utf8");

// Liste formatée sur plusieurs lignes (8 par ligne), guillemets doubles.
const items = enums.gameMap;
const lines = [];
for (let i = 0; i < items.length; i += 6) {
  lines.push("    " + items.slice(i, i + 6).map((v) => JSON.stringify(v)).join(", "));
}
const replacement = `gameMap: [\n${lines.join(",\n")},\n  ],`;

const m = src.match(/gameMap:\s*\[([\s\S]*?)\],\n  difficulty/);
if (!m) throw new Error("bloc gameMap introuvable");
src = src.replace(/gameMap:\s*\[[\s\S]*?\],\n  difficulty/, `${replacement}\n  difficulty`);
fs.writeFileSync(workerPath, src);
console.log("gameMap remplacée :", items.length, "valeurs");
