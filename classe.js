/**
 * classe.js — Page « Classé » TheFrontHub (v1 — 2026-10-07).
 *
 * Classements officiels OpenFront 1v1 et 2v2 (top 100), données sync-ranked.js
 * (ranked.json.gz — régénéré par le cron, pull-data.sh le dépose au webroot).
 *
 * Demande propriétaire (2026-10-07) : « rajouter une version classique sur la
 * version dev avec les 1v1 et 2v2. Et ceux qui ont des cosmétiques, ça les
 * affiche évidemment. » → la page Classé revient (dev-only), avec l'affichage
 * des cosmétiques TheFrontHub : skins animés sur les pseudos, bannières pixel
 * art pleine ligne et badge « joueur vérifié » pour ceux qui en ont un.
 *
 * Sources de données :
 *  - ranked.json.gz (repli ranked.json)      → ladders 1v1/2v2 + newcomers/dropouts
 *  - /api/skins.php?activeMap=1 (bulk 20 min) → skin ACTIF par publicId/username
 *  - /api/public-aliases.php                  → noms hub + registre « vérifié »
 *  - banners.js (window.TFHBanners.decorate)  → bannière active pleine ligne
 *  - verified.js (window.TFHVerified)         → sceau doré des joueurs vérifiés
 *
 * Deep-links : ?mode=1v1|2v2 (partageable), recherche ?player=.
 */

import { getSkin } from "./skins.js";

/* ── Helpers ──────────────────────────────────────────────────────────── */

function T(key, fallback) {
  try {
    const v = window.t ? window.t(key) : key;
    // Garde-fou i18n : t() renvoie la clé si la traduction manque → fallback.
    return !v || v === key ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function LOCALE() {
  return (window.currentLanguage === "en") ? "en-US" : "fr-FR";
}

function nf(n) {
  return Number(n || 0).toLocaleString(LOCALE());
}

function getWinrateColor(wr) {
  if (wr >= 60) return "#10b981";
  if (wr >= 55) return "#34d399";
  if (wr >= 50) return "#fbbf24";
  if (wr >= 45) return "#fb923c";
  return "#ef4444";
}

function fmtUpdatedAt(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(LOCALE(), { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return "";
  }
}

/* ── État ─────────────────────────────────────────────────────────────── */

const LS_MODE = "classe_mode_v1";

const state = {
  mode: "1v1",              // '1v1' | '2v2'
  query: "",                // recherche joueur
  data: null,               // ranked.json parsé
  loadedAt: 0,
  loading: false,
  skinsByPid: new Map(),    // publicId → skinId
  skinsByName: new Map(),   // pseudo normalisé → skinId (fallback)
  hubNamesByPid: new Map(), // publicId → pseudo hub
  cosmeticsReady: false,
};

/* ── Cosmétiques (skins + vérifiés + noms hub) ────────────────────────── */

async function loadCosmetics() {
  // Skins actifs (bulk, cache serveur 20 min) — « ceux qui ont des
  // cosmétiques, ça les affiche » : on matche par publicId (stable),
  // repli pseudo normalisé.
  try {
    const res = await fetch("/api/skins.php?activeMap=1", { cache: "no-store" });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j?.ok && Array.isArray(j.active)) {
        for (const a of j.active) {
          if (!a) continue;
          if (a.publicId) state.skinsByPid.set(String(a.publicId), a.skinId);
          const n = normName(a.username);
          if (n && !state.skinsByName.has(n)) state.skinsByName.set(n, a.skinId);
        }
      }
    }
  } catch (e) { /* non bloquant : sans skins, pseudos standards */ }

  // Aliases publics → noms hub + registre « vérifié » (sceau doré).
  try {
    const res = await fetch("/api/public-aliases.php", { cache: "no-store" });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j?.ok && Array.isArray(j.aliases)) {
        if (window.TFHVerified && typeof window.TFHVerified.setFromAliases === "function") {
          window.TFHVerified.setFromAliases(j.aliases);
        }
        for (const a of j.aliases) {
          if (a && a.publicId && a.username) {
            state.hubNamesByPid.set(String(a.publicId), a.username);
          }
        }
      }
    }
  } catch (e) { /* non bloquant */ }

  state.cosmeticsReady = true;
  // Les cosmétiques arrivent peut-être APRÈS le 1er rendu → re-rend
  // (no-op si les données ranked ne sont pas encore là).
  if (state.data) renderAll();
}

/** Classe CSS du skin d'un joueur (" skin-lagon") ou "". */
function skinClassFor(pid, username, accountUsername) {
  let skinId = pid ? state.skinsByPid.get(String(pid)) : null;
  if (!skinId) {
    for (const n of [username, accountUsername]) {
      const k = normName(n);
      if (k && state.skinsByName.has(k)) { skinId = state.skinsByName.get(k); break; }
    }
  }
  if (!skinId) return "";
  try { return " " + getSkin(skinId).cssClass; } catch (e) { return ""; }
}

/** Sceau « vérifié » (verified.js) pour un publicId. */
function verifiedBadge(pid) {
  try {
    if (window.TFHVerified && typeof window.TFHVerified.badgeHtml === "function") {
      return window.TFHVerified.badgeHtml(pid, { native: true }) || "";
    }
  } catch (e) { /* jamais critique */ }
  return "";
}

/* ── Chargement du classement ─────────────────────────────────────────── */

async function fetchRankedJson() {
  // .gz d'abord (DécompressionStream natif), repli .json.
  try {
    const gz = await fetch("ranked.json.gz", { cache: "no-cache" });
    if (gz.ok && typeof DecompressionStream === "function") {
      const ds = new DecompressionStream("gzip");
      return await new Response(gz.body.pipeThrough(ds)).json();
    }
  } catch (e) { /* repli */ }
  const plain = await fetch("ranked.json", { cache: "no-cache" });
  if (!plain.ok) throw new Error("ranked.json indisponible");
  return plain.json();
}

async function loadLeaderboard(force = false) {
  const tbody = document.getElementById("ranked-list");
  if (!tbody || state.loading) return;
  if (!force && state.data) return;

  state.loading = true;
  setRefreshing(true);
  tbody.innerHTML = '<tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text3)">' +
    esc(T("classe.loading_row", "Chargement du classement…")) + "</td></tr>";
  try {
    state.data = await fetchRankedJson();
    state.loadedAt = Date.now();
    renderAll();
  } catch (e) {
    console.warn("[classe] chargement classé:", e);
    tbody.innerHTML = '<tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text3)">' +
      esc(T("classe.load_error", "Impossible de charger le classement. Réessaie dans un instant.")) +
      ' <button type="button" class="classe-retry" onclick="window._classeDebug.load(true)">' +
      esc(T("classe.retry", "Réessayer")) + "</button></td></tr>";
  } finally {
    state.loading = false;
    setRefreshing(false);
  }
}

function setRefreshing(on) {
  const btn = document.getElementById("classe-refresh");
  const meta = document.getElementById("classe-updated");
  if (btn) { btn.disabled = on; btn.textContent = on
    ? T("classe.refreshing", "Actualisation…")
    : T("classe.refresh", "Actualiser"); }
  if (meta && !on && state.data) {
    const d = fmtUpdatedAt(state.data.updatedAt);
    if (d) meta.textContent = T("classe.updated_at", "Classement du {date}").replace("{date}", d);
  }
}

/* ── Données du mode courant ──────────────────────────────────────────── */

function modePlayers() {
  const d = state.data;
  if (!d) return [];
  const arr = state.mode === "2v2" ? d["2v2"] : d["1v1"];
  if (Array.isArray(arr) && arr.length) return arr;
  // Ancien format : tableau plat (compat).
  if (!d["1v1"] && !d["2v2"] && Array.isArray(d)) return d;
  return [];
}

function filteredPlayers() {
  const q = normName(state.query);
  const players = modePlayers();
  if (!q) return players;
  return players.filter((p) =>
    normName(p.username).includes(q) ||
    normName(p.accountUsername).includes(q) ||
    normName(state.hubNamesByPid.get(String(p.public_id || ""))).includes(q)
  );
}

/* ── Rendu ────────────────────────────────────────────────────────────── */

function renderAll() {
  renderStats();
  renderTable();
  renderEloDist();
  renderNewcomers();
  renderModeUI();
  setRefreshing(false);
}

function renderStats() {
  const players = modePlayers();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (!players.length) {
    set("classe-stat-players", "—"); set("classe-stat-avgelo", "—");
    set("classe-stat-peakelo", "—"); set("classe-stat-games", "—");
    return;
  }
  const avg = Math.round(players.reduce((a, p) => a + (Number(p.elo) || 0), 0) / players.length);
  const peak = Math.max(...players.map((p) => Number(p.peakElo) || Number(p.elo) || 0));
  const games = players.reduce((a, p) => a + (Number(p.total) || 0), 0);
  set("classe-stat-players", nf(players.length));
  set("classe-stat-avgelo", nf(avg));
  set("classe-stat-peakelo", nf(peak));
  set("classe-stat-games", nf(games));
}

function playerNameHtml(p) {
  const pid = p.public_id ? String(p.public_id) : "";
  const shown = state.hubNamesByPid.get(pid) || p.username || p.accountUsername || "—";
  const skinCls = skinClassFor(pid, p.username, p.accountUsername);
  const badge = verifiedBadge(pid);
  const clan = p.clanTag ? '<span class="classe-clan">[' + esc(p.clanTag) + "]</span>" : "";
  const title = (p.username && p.username !== shown) ? ' title="' + esc(p.username) + '"' : "";
  const href = pid
    ? "profile.html?player=" + encodeURIComponent(shown) + "&publicId=" + encodeURIComponent(pid)
    : "profile.html?player=" + encodeURIComponent(p.username || shown);
  return (
    '<div class="classe-player">' +
      '<a class="classe-player-name' + skinCls + '" href="' + href + '"' + title +
        ' aria-label="' + esc(T("classe.view_profile", "Voir le profil")) + '">' +
        clan + esc(shown) +
      "</a>" + badge +
    "</div>"
  );
}

function renderTable() {
  const tbody = document.getElementById("ranked-list");
  if (!tbody) return;
  const players = filteredPlayers();
  if (!players.length) {
    const msg = state.data
      ? T("classe.no_match", "Aucun joueur ne correspond à la recherche.")
      : T("classe.loading_row", "Chargement du classement…");
    tbody.innerHTML = '<tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text3)">' +
      esc(msg) + "</td></tr>";
    return;
  }

  const rows = players.map((p) => {
    const total = Number(p.total) || 0;
    const wins = Number(p.wins) || 0;
    const losses = Number(p.losses) || 0;
    const elo = Number(p.elo) || 0;
    const wr = total > 0 ? (wins / total) * 100 : 0;
    const rank = Number(p.rank) || 0;

    // MV (flèche mouvement)
    let mv = '<span style="color:var(--muted)">—</span>';
    const m = p.movement;
    if (m != null && Number(m) !== 0) {
      mv = Number(m) > 0
        ? '<span style="color:#10b981;font-weight:700">' + (window.icon ? window.icon("arrowUp", { size: 12 }) : "▲") + Number(m) + "</span>"
        : '<span style="color:#ef4444;font-weight:700">' + (window.icon ? window.icon("arrowDown", { size: 12 }) : "▼") + Math.abs(Number(m)) + "</span>";
    }

    // Peak (avec +diff si > elo courant)
    const peak = Number(p.peakElo) || elo;
    const peakDiff = peak - elo;
    const peakHtml = peakDiff > 0
      ? peak + ' <span style="color:var(--gold);font-size:11px">' + (window.icon ? window.icon("arrowUp", { size: 10 }) : "▲") + peakDiff + "</span>"
      : String(peak);

    // Streak (🔥 / ❄)
    let streak = '<span style="color:var(--muted)">—</span>';
    const s = p.streak;
    if (s != null && Number(s) !== 0) {
      streak = Number(s) > 0
        ? '<span style="color:#f97316;font-weight:700">' + (window.icon ? window.icon("fire", { size: 12 }) : "🔥") + Number(s) + "</span>"
        : '<span style="color:#3b82f6;font-weight:700">' + (window.icon ? window.icon("snowflake", { size: 12 }) : "❄") + Math.abs(Number(s)) + "</span>";
    }

    return (
      '<tr class="classe-row" data-pid="' + esc(p.public_id || "") + '" data-pfb-row>' +
        '<td style="padding:12px 8px;font-weight:700;color:' + (rank <= 3 ? "var(--accent)" : "var(--text)") + '">#' + rank + "</td>" +
        '<td style="padding:12px 8px">' + playerNameHtml(p) + "</td>" +
        '<td style="padding:12px 8px;font-family:JetBrains Mono,monospace;color:var(--accent);font-weight:700">' + elo + "</td>" +
        '<td class="rk-mobile-hide" style="padding:12px 8px;font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)">' + peakHtml + "</td>" +
        '<td style="padding:12px 8px;font-weight:700;color:' + getWinrateColor(wr) + '">' + wr.toFixed(1) + "%</td>" +
        '<td class="rk-narrow-hide" style="padding:12px 8px;font-family:JetBrains Mono,monospace;font-size:12px"><span style="color:#10b981">' + wins + '</span> - <span style="color:#ef4444">' + losses + "</span></td>" +
        '<td class="rk-mobile-hide" style="padding:12px 8px;color:var(--text3);font-family:JetBrains Mono,monospace">' + total + "</td>" +
        '<td class="rk-mobile-hide" style="padding:12px 8px;text-align:center;font-size:12px">' + mv + "</td>" +
        '<td class="rk-mobile-hide" style="padding:12px 8px;text-align:center;font-size:12px">' + streak + "</td>" +
      "</tr>"
    );
  });

  tbody.innerHTML = rows.join("");
  // Bannières pixel art pleine ligne (ceux qui en ont une — cosmétiques hub).
  try {
    if (window.TFHBanners && typeof window.TFHBanners.decorate === "function") {
      window.TFHBanners.decorate(tbody);
    }
  } catch (e) { /* déco non critique */ }
}

function renderEloDist() {
  const el = document.getElementById("classe-elo-dist");
  if (!el) return;
  const players = modePlayers();
  if (!players.length) {
    el.innerHTML = '<div class="empty-state">' + esc(T("classe.no_data", "Aucune donnée")) + "</div>";
    return;
  }
  const buckets = [
    ["2400+", 2400, Infinity], ["2300-2399", 2300, 2399.99], ["2200-2299", 2200, 2299.99],
    ["2100-2199", 2100, 2199.99], ["2000-2099", 2000, 2099.99], ["<2000", -Infinity, 1999.99],
  ];
  const counts = buckets.map(([, lo, hi]) =>
    players.filter((p) => (Number(p.elo) || 0) >= lo && (Number(p.elo) || 0) <= hi).length);
  const max = Math.max(1, ...counts);
  el.innerHTML = buckets.map(([label], i) => {
    const v = counts[i];
    const pct = Math.max(4, (v / max) * 200);
    const countLabel = v === 1 ? T("classe.player_one", "{n} joueur").replace("{n}", v) : T("classe.player_n", "{n} joueurs").replace("{n}", v);
    return (
      '<div class="dist-row">' +
        '<span class="dist-label">' + label + "</span>" +
        '<div class="dist-bar" style="width:' + pct + 'px;height:16px;background:var(--accent);opacity:0.75"></div>' +
        '<span class="dist-count" title="' + esc(countLabel) + '">' + v + "</span>" +
      "</div>"
    );
  }).join("");
}

function renderNewcomers() {
  const d = state.data;
  const newcomers = (state.mode === "2v2" ? d?.newcomers2v2 : d?.newcomers1v1) || [];
  const dropouts = (state.mode === "2v2" ? d?.dropouts2v2 : d?.dropouts1v1) || [];
  const newCard = document.getElementById("newcomers-card");
  const dropCard = document.getElementById("dropouts-card");
  const newEl = document.getElementById("classe-newcomers");
  const dropEl = document.getElementById("classe-dropouts");
  if (newCard) newCard.style.display = newcomers.length ? "" : "none";
  if (dropCard) dropCard.style.display = dropouts.length ? "" : "none";

  const nameHtml = (n) => {
    const pid = n.public_id ? String(n.public_id) : "";
    const shown = state.hubNamesByPid.get(pid) || n.username || "";
    const skinCls = skinClassFor(pid, n.username, n.accountUsername).trim();
    const href = pid
      ? "profile.html?player=" + encodeURIComponent(shown) + "&publicId=" + encodeURIComponent(pid)
      : "profile.html?player=" + encodeURIComponent(n.username || shown);
    return '<a class="' + skinCls + '" href="' + href + '">' + esc(shown) + "</a>";
  };

  if (newEl) {
    newEl.innerHTML = newcomers.length
      ? newcomers.map((n) => nameHtml(n)).join("")
      : "";
  }
  if (dropEl) {
    dropEl.innerHTML = dropouts.length
      ? dropouts.map((n) => esc(state.hubNamesByPid.get(String(n.public_id || "")) || n.username || "")).join(", ")
      : "";
  }
}

/* ── Mode 1v1 / 2v2 + recherche ───────────────────────────────────────── */

function setMode(mode, opts) {
  state.mode = mode === "2v2" ? "2v2" : "1v1";
  try { localStorage.setItem(LS_MODE, state.mode); } catch (e) { /* privé */ }
  const url = new URL(window.location.href);
  if (state.mode === "2v2") url.searchParams.set("mode", "2v2");
  else url.searchParams.delete("mode");
  history.replaceState(null, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : ""));
  renderAll();
  if (!(opts && opts.silent)) {
    const label = document.getElementById("classe-mode-label");
    if (label) label.textContent = state.mode;
  }
}

function renderModeUI() {
  document.querySelectorAll("#classe-mode-toggle .mode-toggle-btn").forEach((b) => {
    const on = b.getAttribute("data-mode") === state.mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  const label = document.getElementById("classe-mode-label");
  if (label) label.textContent = state.mode;
  const title = document.getElementById("classe-table-title");
  if (title) {
    const tpl = T("classe.table_title", "Classement Classé ({mode}) — Top 100 officiel");
    title.textContent = tpl.replace("{mode}", state.mode);
  }
}

/* ── Boot ─────────────────────────────────────────────────────────────── */

function init() {
  // Mode initial : URL > localStorage > 1v1.
  let initial = "1v1";
  try {
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    if (m === "1v1" || m === "2v2") initial = m;
    else {
      const ls = localStorage.getItem(LS_MODE);
      if (ls === "1v1" || ls === "2v2") initial = ls;
    }
    const q = p.get("player");
    if (q) {
      state.query = q;
      const input = document.getElementById("classe-search");
      if (input) input.value = q;
    }
  } catch (e) { /* URL indisponible */ }
  state.mode = initial;

  // Événements.
  document.querySelectorAll("#classe-mode-toggle .mode-toggle-btn").forEach((b) => {
    b.addEventListener("click", () => setMode(b.getAttribute("data-mode")));
  });
  const search = document.getElementById("classe-search");
  if (search) {
    search.addEventListener("input", () => {
      state.query = search.value || "";
      renderTable();
    });
  }
  const refresh = document.getElementById("classe-refresh");
  if (refresh) refresh.addEventListener("click", () => loadLeaderboard(true));

  renderModeUI();
  void loadLeaderboard(false);
  void loadCosmetics();
  // NB : le changement de langue (i18n.js) recharge la page entière —
  // aucun listener « languagechange » nécessaire.
}

init();

/* ── Hook de debug (E2E / support) ────────────────────────────────────── */
window._classeDebug = {
  load: loadLeaderboard,
  setMode,
  state,
};
