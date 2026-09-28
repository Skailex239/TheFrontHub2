/**
 * verified.js — Registre global « joueurs vérifiés » TheFrontHub (v5.13).
 *
 * Un joueur est VÉRIFIÉ quand il a revendiqué son profil : compte TheFrontHub
 * (Discord) + Public ID OpenFront lié + preuve de propriété confirmée CÔTÉ
 * SERVEUR (le code du défi doit apparaître dans une partie récente jouée
 * avec ce compte — voir api/profile.php action=verify).
 *
 * Source de données : la liste publique /api/public-aliases.php (pollée déjà
 * par toutes les pages via auth.js onSnapshot("public-aliases")) — les lignes
 * portent désormais { publicId, verified, bio, favMap, links }.
 *
 * Utilisation dans les rendus (string HTML) :
 *   const b = window.TFHVerified?.badgeHtml(pid) || "";      // pid direct
 *   const b = window.TFHVerified?.badgeForName(name) || "";  // résolution pseudo→pid
 *   const b = window.TFHVerified?.badgeHtml(pid, { native: true }); // title natif
 *
 * Ce script est volontairement autonome (pas d'import) : il fonctionne sur
 * toutes les pages (app.js, dashboard.js, runs.js, game.html, preprofile.js).
 */
(function () {
  "use strict";

  var pids = {};          // pid → true (vérifiés)
  var extras = {};        // pid → { bio, favMap, links, alias }
  var listeners = [];
  var pageLang = null;

  function tip() {
    if (pageLang === null) {
      try { pageLang = (window.currentLanguage === "en") ? "en" : "fr"; }
      catch (e) { pageLang = "fr"; }
    }
    return pageLang === "en"
      ? "Verified player — this person is verified (identity proven in game)"
      : "Joueur vérifié — cette personne est vérifiée (identité prouvée en jeu)";
  }

  function svgBadge() {
    // Badge autonome : même tracé que icons.js badgeCheck (fallback si
    // window.icon absent — game.html ne charge pas toujours icons.min.js).
    if (typeof window !== "undefined" && typeof window.icon === "function") {
      try { return window.icon("badgeCheck", { size: 12, cls: "tfh-vbadge-ic" }); } catch (e) {}
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tfh-vbadge-ic" aria-hidden="true"><path d="M12 2.2l2.3 1.9 3-.3.9 2.9 2.6 1.5-1 2.9 1 2.9-2.6 1.5-.9 2.9-3-.3-2.3 1.9-2.3-1.9-3 .3-.9-2.9L3.2 14l1-2.9-1-2.9 2.6-1.5.9-2.9 3 .3z"/><path d="M8.6 12l2.4 2.4 4.4-4.9"/></svg>';
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }

  /** Injecte les lignes de /api/public-aliases.php (appelé par app.js). */
  function setFromAliases(list) {
    if (!Array.isArray(list)) return;
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.publicId) continue;
      var pid = String(a.publicId);
      if (a.verified && !pids[pid]) { pids[pid] = true; changed = true; }
      var ex = {
        bio: a.bio || "",
        favMap: a.favMap || "",
        links: a.links || {},
        alias: a.username || "",
      };
      var cur = extras[pid];
      if (!cur || JSON.stringify(cur) !== JSON.stringify(ex)) {
        extras[pid] = ex;
        changed = true;
      }
    }
    if (changed) notify();
  }

  /** Injection directe (route=game / route=profile / route=weekly). */
  function markVerified(pid) {
    if (pid && !pids[String(pid)]) { pids[String(pid)] = true; notify(); }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* le rendu ne doit jamais casser */ }
    }
  }

  function isVerifiedPid(pid) {
    return !!pid && !!pids[String(pid)];
  }

  function extrasFor(pid) {
    return pid ? (extras[String(pid)] || null) : null;
  }

  /**
   * Badge HTML d'un publicId.
   * @param {string|null} pid
   * @param {{native?:boolean, size?:number}} [opts] native = infobulle native
   *        (title) au lieu de la bulle CSS — pour les listes scrollables où
   *        la bulle serait rognée (même logique que les flèches ↑/↓ du dashboard).
   */
  function badgeHtml(pid, opts) {
    if (!isVerifiedPid(pid)) return "";
    var o = opts || {};
    var t = tip();
    var cls = "tfh-vbadge" + (o.native ? " tfh-vbadge--native" : "");
    return '<span class="' + cls + '" data-tip="' + esc(t) + '" title="' + esc(t) +
      '" tabindex="0" role="img" aria-label="' + esc(t) + '">' + svgBadge() + "</span>";
  }

  /**
   * Badge d'un pseudo (résolution via le bridge app.js username → publicId).
   * Retourne "" tant que le bridge n'est pas prêt — les re-rendus déclenchés
   * par onChange() l'ajouteront dès l'arrivée des aliases.
   */
  function badgeForName(name, opts) {
    var pid = null;
    try {
      if (typeof window.__tfhResolvePid === "function") pid = window.__tfhResolvePid(name);
    } catch (e) { /* bridge absent */ }
    return pid ? badgeHtml(pid, opts) : "";
  }

  window.TFHVerified = {
    setFromAliases: setFromAliases,
    markVerified: markVerified,
    isVerifiedPid: isVerifiedPid,
    extrasFor: extrasFor,
    badgeHtml: badgeHtml,
    badgeForName: badgeForName,
    tip: tip,
    onChange: function (cb) { if (typeof cb === "function") listeners.push(cb); },
  };
})();
