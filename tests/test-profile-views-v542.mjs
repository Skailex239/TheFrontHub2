/**
 * Test comportemental v5.42 — compteur « vues » profil, 1 par visite.
 *
 * Port 1:1 de tfh_profile_count_visit (api/profile-cache.php) avec SQLite
 * (bun:sqlite) : INSERT OR IGNORE ≡ INSERT IGNORE MySQL (même sémantique de
 * dédoublonnage par PK), upsert traduit en ON CONFLICT DO UPDATE.
 * Usage : bun tests/test-profile-views-v542.mjs
 */
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE tfh_g_profile_visit_seen (
    public_id  VARCHAR(16) NOT NULL,
    visit_hash CHAR(32)    NOT NULL,
    ip_hash    CHAR(32)    NOT NULL DEFAULT '',
    seen_at    DATETIME    NOT NULL,
    PRIMARY KEY (public_id, visit_hash)
  );
  CREATE TABLE tfh_g_profile_views (
    public_id    VARCHAR(16)     NOT NULL PRIMARY KEY,
    views        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    public_views BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_view    DATETIME        NOT NULL
  );
`);
const MAX_DAY = 10; // TFH_PROFILE_VISIT_MAX_PER_DAY

/** Miroir 1:1 de tfh_profile_count_visit(). */
function countVisit(pid, visitHash, ipHash, todayOverride = null) {
  const ins = db
    .prepare("INSERT OR IGNORE INTO tfh_g_profile_visit_seen (public_id, visit_hash, ip_hash, seen_at) VALUES (?, ?, ?, datetime('now'))")
    .run(pid, visitHash, ipHash);
  if (ins.changes > 0) {
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM tfh_g_profile_visit_seen WHERE public_id = ? AND ip_hash = ? AND (seen_at >= ?)")
      .get(pid, ipHash, todayOverride ?? new Date().toISOString().slice(0, 10)).n ?? 0;
    if (Number(n) <= MAX_DAY) {
      db.prepare(`INSERT INTO tfh_g_profile_views (public_id, views, public_views, last_view)
        VALUES (?, 0, 1, datetime('now'))
        ON CONFLICT(public_id) DO UPDATE SET public_views = public_views + 1, last_view = datetime('now')`)
        .run(pid);
    }
  }
  return getViews(pid);
}

function getViews(pid) {
  const r = db.prepare("SELECT public_views FROM tfh_g_profile_views WHERE public_id = ?").get(pid);
  return r ? Number(r.public_views) : 0;
}

const H = (s) => s; // hash simulé (le vrai PHP sha256-tronque : sans effet ici)
let failed = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✔" : "✘"} ${label}${extra ? " — " + extra : ""}`);
  if (!cond) failed++;
};

/* 1. Première visite → 1 vue */
let v = countVisit("chwwRwsAtV", H("visit-A"), H("ip-1"));
check("1re visite d'un profil = 1 vue", v === 1, `views=${v}`);

/* 2. Rechargement / re-rendu dans la MÊME visite → toujours 1 */
for (let i = 0; i < 5; i++) v = countVisit("chwwRwsAtV", H("visit-A"), H("ip-1"));
check("rechargements (même visite) NE comptent PAS → reste 1", v === 1, `views=${v}`);

/* 3. Nouvelle visite (nouvel onglet / nouveau jour) → +1 */
v = countVisit("chwwRwsAtV", H("visit-B"), H("ip-1"));
check("nouvelle visite = +1 → 2", v === 2, `views=${v}`);
v = countVisit("chwwRwsAtV", H("visit-B"), H("ip-2"));
check("même visitId depuis une autre IP = déjà compté → reste 2", v === 2, `views=${v}`);

/* 4. Anti-spam : cap 10 vues / jour / IP / profil */
let last = v;
for (let i = 0; i < 12; i++) last = countVisit("spamgame01", H("spam-visit-" + i), H("ip-spam"));
check("12 visites fantômes d'une même IP le même jour → plafonné à 10", last === 10, `views=${last}`);

/* 5. Le dédoublonnage par visite est indépendant du plafond : visite
 *    déjà vue d'une IP plafonnée ne ré-rien incrémente non plus */
v = countVisit("spamgame01", H("spam-visit-0"), H("ip-spam"));
check("re-visite d'un couple déjà compté → reste plafonné", v === 10, `views=${v}`);

/* 6. Compteurs indépendants par profil (une même visite voit 2 profils) */
countVisit("AAAAplayer1", H("visit-A"), H("ip-1"));
const v1 = getViews("chwwRwsAtV"), v2 = getViews("AAAAplayer1");
check("visite d'un 2e profil : compteurs indépendants (2 et 1)", v1 === 2 && v2 === 1, `A=${v1} B=${v2}`);

/* 7. Profil jamais visité → 0 (badge affiche 0, pas d'erreur) */
check("profil sans visite → getViews = 0", getViews("inconnuXYZ") === 0);

/* 8. Simulateur du flux route=profile : le payload en cache ne fige pas la
 *    valeur — « réinjection fraîche » = getViews à chaque lecture */
countVisit("chwwRwsAtV", H("visit-C"), H("ip-3")); // visite fraîche → 3
check("réinjection fraîche (cache + getViews) reflète la nouvelle visite", getViews("chwwRwsAtV") === 3);

console.log(failed ? `\n❌ ${failed} échec(s)` : "\n✅ 8/8 scénarios PASS");
process.exit(failed ? 1 : 0);
