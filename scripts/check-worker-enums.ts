// Vérifie que la liste gameMap embarquée dans le worker correspond
// EXACTAMENT à l'ordre officiel (scripts/zbin-enums.json).
import * as fs from "node:fs";

const enums = JSON.parse(fs.readFileSync("/home/z/my-project/scripts/zbin-enums.json", "utf8"));
const workerSrc = fs.readFileSync("/home/z/my-project/download/openfront-worker.js", "utf8");

const m = workerSrc.match(/gameMap:\s*\[([\s\S]*?)\]/);
if (!m) throw new Error("liste gameMap introuvable dans le worker");
const workerList = m[1]
  .split(/",?\s*\n?/)
  .flatMap((s) => s.split('", '))
  .map((s) => s.replace(/[^A-Za-z0-9 .'-]/g, "").trim())
  .filter((s) => s.length > 0);

const official = enums.gameMap;
console.log("officielle:", official.length, "worker:", workerList.length);

// Comparaison index par index
let diffs = 0;
const n = Math.max(official.length, workerList.length);
for (let i = 0; i < n; i++) {
  if (official[i] !== workerList[i]) {
    diffs++;
    console.log(`DIFF idx ${i}: officiel="${official[i]}" worker="${workerList[i]}"`);
  }
}
console.log(diffs === 0 ? "✔ IDENTIQUES" : `✘ ${diffs} différences`);

// Vérifie aussi les autres enums embarqués
for (const key of ["difficulty", "gameType", "gameMode", "rankedType", "gameMapSize", "unitType"]) {
  const re = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`);
  const mm = workerSrc.match(re);
  const list = mm ? mm[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)) : [];
  const ok = JSON.stringify(list) === JSON.stringify(enums[key]);
  console.log(ok ? `✔ ${key}` : `✘ ${key}: worker=${JSON.stringify(list)} officiel=${JSON.stringify(enums[key])}`);
}
