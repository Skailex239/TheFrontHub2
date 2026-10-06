// Test du worker Cloudflare FUSIONNÉ v2 (leur proxy + nos routes).
// En local (bun) : les routes HTTP passent ; le WS Upgrade propre à
// Cloudflare échoue proprement (attendu). Origine autorisée requise.
const worker = await import("/home/z/my-project/cloudflare-worker/openfront-proxy.js");

const ORIGIN_OK = "http://localhost:3000";
const ORIGIN_KO = "https://site-inconnu.example";

async function call(path, origin) {
  const req = new Request(`https://worker.test${path}`, {
    headers: { Origin: origin || ORIGIN_OK },
  });
  const res = await worker.default.fetch(req);
  const cors = res.headers.get("access-control-allow-origin");
  const type = res.headers.get("content-type") || "";
  let body = null;
  if (type.includes("json")) body = await res.json();
  return { status: res.status, cors, body };
}

console.log("=== /health ===");
const h = await call("/health");
console.log("status:", h.status, "· CORS:", h.cors, "· v:", h.body?.version, "· endpoints:", h.body?.endpoints?.length);

console.log("\n=== 403 origine refusée ===");
const ko = await call("/leaderboard", ORIGIN_KO);
console.log("status:", ko.status, "(attendu 403) ·", JSON.stringify(ko.body));

console.log("\n=== 403 sans origine (curl) ===");
const no = await worker.default.fetch(new Request("https://worker.test/leaderboard"));
console.log("status:", no.status, "(attendu 403)");

console.log("\n=== /lobbies (WS Cloudflare — échec propre attendu en bun) ===");
const lob = await call("/lobbies");
console.log("status:", lob.status, "· connected:", lob.body?.connected, "· lastError:", (lob.body?.lastError || "").slice(0, 90));

console.log("\n=== /leaderboard ===");
const lb = await call("/leaderboard");
console.log("status:", lb.status, "· 1v1:", lb.body?.data?.["1v1"]?.length, "· 2v2:", lb.body?.data?.["2v2"]?.length, "· top:", lb.body?.data?.["1v1"]?.[0]?.username);

console.log("\n=== /leaderboard/ranked (passthrough — route du site actuel) ===");
const pt = await call("/leaderboard/ranked");
console.log("status:", pt.status, "· 1v1:", pt.body?.data?.["1v1"]?.length, "· 2v2:", pt.body?.data?.["2v2"]?.length);

console.log("\n=== /cluster ===");
const cl = await call("/cluster");
const servers = cl.body?.data?.servers || {};
for (const [k, v] of Object.entries(servers)) {
  console.log(" ", k, v.host, "· state:", v.state, "· workers:", v.numWorkers);
}

console.log("\n=== /cosmetics (compacté) ===");
const cos = await call("/cosmetics");
console.log("status:", cos.status, "· motifs:", cos.body?.data?.patterns?.length, "· drapeaux:", cos.body?.data?.flags?.length, "· palettes:", cos.body?.data?.palettes?.length);

console.log("\n=== /player/hWNuSrnS ===");
const pl = await call("/player/hWNuSrnS");
console.log("status:", pl.status, "· pseudo:", pl.body?.data?.username);

console.log("\n=== /player/hWNuSrnS/games ===");
const pg = await call("/player/hWNuSrnS/games");
const games = pg.body?.data?.games || pg.body?.data || [];
console.log("status:", pg.status, "· type données:", Array.isArray(games) ? `array(${games.length})` : typeof games);

console.log("\n=== /all (agrégat) ===");
const all = await call("/all");
console.log("status:", all.status, "· apiOk:", all.body?.apiOk, "· 1v1:", all.body?.leaderboard?.data?.["1v1"]?.length, "· motifs:", all.body?.cosmetics?.data?.patterns?.length);

console.log("\n=== /lobby-ws sans Upgrade (attendu 426) ===");
const ws = await call("/lobby-ws");
console.log("status:", ws.status, "(attendu 426)");

console.log("\n=== OPTIONS preflight ===");
const opt = await worker.default.fetch(new Request("https://worker.test/leaderboard", {
  method: "OPTIONS",
  headers: { Origin: ORIGIN_OK },
}));
console.log("status:", opt.status, "· CORS:", opt.headers.get("access-control-allow-origin"));

console.log("\n=== décodeur zbin exporté ===");
console.log("typeof decodeLobbyFrame:", typeof worker.decodeLobbyFrame);
