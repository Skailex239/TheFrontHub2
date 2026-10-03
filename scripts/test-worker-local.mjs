// Test du worker Cloudflare en local (bun) : on appelle handle() avec de vraies
// Request. Les routes HTTP (leaderboard, cosmetics, cluster, player, all)
// utilisent fetch normal → testables ici. La route /lobbies passe par le
// fetch « Upgrade: websocket » propre au runtime Cloudflare (non supporté par
// bun) → on vérifie juste qu'elle échoue proprement avec un JSON d'erreur.
const worker = await import("/home/z/my-project/download/openfront-worker.js");

async function call(path) {
  const req = new Request(`https://test.example${path}`);
  const res = await worker.default.fetch(req);
  const cors = res.headers.get("access-control-allow-origin");
  const type = res.headers.get("content-type") ?? "";
  let body = null;
  if (type.includes("json")) {
    body = await res.json();
  }
  return { status: res.status, cors, body };
}

console.log("=== / (santé) ===");
const health = await call("/");
console.log("status:", health.status, "· CORS:", health.cors);
console.log(JSON.stringify(health.body).slice(0, 300));

console.log("\n=== /leaderboard ===");
const lb = await call("/leaderboard");
console.log("status:", lb.status, "· 1v1:", lb.body?.data?.["1v1"]?.length, "joueurs · 2v2:", lb.body?.data?.["2v2"]?.length, "joueurs");
console.log("top 1v1:", lb.body?.data?.["1v1"]?.[0]?.username, lb.body?.data?.["1v1"]?.[0]?.elo);

console.log("\n=== /cosmetics ===");
const cos = await call("/cosmetics");
console.log("status:", cos.status, "· motifs:", cos.body?.data?.patterns?.length, "· drapeaux:", cos.body?.data?.flags?.length, "· palettes:", cos.body?.data?.palettes?.length);

console.log("\n=== /cluster ===");
const cl = await call("/cluster");
console.log("status:", cl.status, "· serveurs:", Object.keys(cl.body?.data?.servers ?? {}).join(", "));

console.log("\n=== /player/hWNuSrnS ===");
const pl = await call("/player/hWNuSrnS");
console.log("status:", pl.status, "· pseudo:", pl.body?.data?.username, "· créé:", pl.body?.data?.createdAt);

console.log("\n=== /all (agrégat atomique) ===");
const all = await call("/all");
console.log("status:", all.status, "· apiOk:", all.body?.apiOk, "· leaderboard 1v1:", all.body?.leaderboard?.data?.["1v1"]?.length, "· motifs:", all.body?.cosmetics?.data?.patterns?.length);

console.log("\n=== /lobbies (WS Cloudflare — attendu: échec propre en bun) ===");
const lob = await call("/lobbies");
console.log("status:", lob.status, "· connected:", lob.body?.connected, "· lastError:", (lob.body?.lastError ?? "").slice(0, 120));

console.log("\n=== /route-inconnue ===");
const nf = await call("/xyz");
console.log("status:", nf.status, "·", JSON.stringify(nf.body));
