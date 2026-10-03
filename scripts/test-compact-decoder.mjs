// Test de validation : décode les trames lobbies RÉELLES avec le décodeur
// compact du worker ET avec le décodeur officiel (lobby-decoder.mjs),
// puis compare les résultats. Doit être identique à 100 %.
import WebSocket from "ws";

const OFFICIAL = await import("/home/z/my-project/mini-services/openfront-service/lobby-decoder.mjs");
const COMPACT = await import("/home/z/my-project/download/openfront-worker.js");

const host = process.argv[2] ?? "blue.openfront.io";
const url = `wss://${host}/w0/lobbies?platform=web`;

function deepEqual(a, b, path = "") {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    console.log(`≠ TYPE/VALEUR ${path}: officiel=${JSON.stringify(a)} compact=${JSON.stringify(b)}`);
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let ok = true;
  for (const k of keys) {
    if (k === "__proto__") continue;
    if (!deepEqual(a[k], b[k], `${path}.${k}`)) ok = false;
  }
  return ok;
}

const ws = new WebSocket(url, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Origin: "https://openfront.io",
  },
  handshakeTimeout: 15000,
});

let frames = 0;
let fulls = 0;
let mismatches = 0;
const LIMIT_SECONDS = 12;

const timer = setTimeout(() => {
  console.log(`\n=== BILAN: ${frames} trames (${fulls} full) · ${mismatches} écart(s) ===`);
  process.exit(mismatches === 0 && fulls > 0 ? 0 : 1);
}, LIMIT_SECONDS * 1000);

ws.on("message", (data) => {
  frames++;
  const bytes = new Uint8Array(data);
  let official, compact;
  try {
    official = OFFICIAL.decodeLobbyFrame(bytes);
  } catch (e) {
    console.log(`frame #${frames}: échec DÉCODEUR OFFICIEL: ${e.message}`);
    return;
  }
  try {
    compact = COMPACT.decodeLobbyFrame(bytes);
  } catch (e) {
    console.log(`frame #${frames}: échec DÉCODEUR COMPACT: ${e.message}`);
    mismatches++;
    return;
  }
  if (official.type === "full") fulls++;
  if (!deepEqual(official, compact, `frame#${frames}`)) {
    mismatches++;
    console.log(`frame #${frames} (${official.type}): ÉCART`);
    if (official.type === "full") {
      console.log("  officiel sample:", JSON.stringify(official.games?.ffa?.[0] ?? null).slice(0, 400));
      console.log("  compact  sample:", JSON.stringify(compact.games?.ffa?.[0] ?? null).slice(0, 400));
    }
  }
});

ws.on("open", () => console.log(`connecté à ${url}`));
ws.on("error", (e) => console.log("erreur WS:", e.message));
ws.on("close", (c) => console.log("fermé:", c));
