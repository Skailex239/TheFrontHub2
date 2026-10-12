/**
 * pf-prefetch.js — Pré-charge des profils AVANT le clic (v5.36).
 *
 * « Quand on clique, le profil doit être presque déjà affiché » :
 *  1. au survol / au doigt (pointerenter, ~100-300 ms avant le clic) et à
 *     l'appui (pointerdown), tout lien vers profile.html?...publicId=… déclenche
 *     le téléchargement silencieux du payload du joueur ;
 *  2. les liens visibles à l'écran sont pré-chargés au repos (IntersectionObserver,
 *     8 max, requestIdleCallback) ;
 *  3. chaque payload est posé en sessionStorage (clé tfh_pp:<pid>, TTL 10 min,
 *     6 entrées max / 300 Ko max) — profile.html lit cette clé AU RENDU et
 *     affiche le profil instantanément, puis rafraîchit en arrière-plan.
 *
 * La route /api/games-api.php?route=profile est servie depuis un cache fichier
 * côté serveur (profile-warm.php) : un pré-charge coûte quelques ms et reste
 * dans le cache HTTP 60 s (les 3 consommateurs — prefetch, profile.js,
 * preprofile.js — partagent la MÊME URL, le navigateur dédoublonne).
 *
 * Autonome (IIFE, aucune dépendance). Déclaré standalone dans scripts/build.js,
 * inclus sur les pages qui listent des joueurs (index/dashboard/classe/runs/
 * lobby/profile).
 */
(function () {
  'use strict';

  var API_URL = '/api/games-api.php?route=profile&publicId=';
  var URL_SUFFIX = '&limit=100'; // URL IDENTIQUE à profile.js/preprofile.js → cache HTTP partagé
  var SS_PREFIX = 'tfh_pp:';
  var SS_TTL = 10 * 60 * 1000;   // 10 min
  var SS_MAX_ENTRIES = 6;        // LRU — budget sessionStorage
  var SS_MAX_BYTES = 300 * 1024; // 300 Ko par payload
  var inflight = {};

  function pidFromHref(href) {
    try {
      var m = String(href || '').match(/[?&](?:publicId|pid)=([A-Za-z0-9]{6,16})/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  /* ── sessionStorage : stockage LRU partagé avec profile.js/preprofile.js ── */
  function store(pid, payload) {
    try {
      var json = JSON.stringify({ t: Date.now(), p: payload });
      if (json.length > SS_MAX_BYTES) return; // payload trop gros — tant pis
      sessionStorage.setItem(SS_PREFIX + pid, json);
      // LRU : purge au-delà de SS_MAX_ENTRIES
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(SS_PREFIX) === 0) keys.push(k);
      }
      if (keys.length > SS_MAX_ENTRIES) {
        keys.sort(function (a, b) {
          var ta = 0, tb = 0;
          try { ta = (JSON.parse(sessionStorage.getItem(a)) || {}).t || 0; } catch (e) {}
          try { tb = (JSON.parse(sessionStorage.getItem(b)) || {}).t || 0; } catch (e) {}
          return ta - tb;
        });
        while (keys.length > SS_MAX_ENTRIES) {
          sessionStorage.removeItem(keys.shift());
        }
      }
    } catch (e) { /* quota/privé — silencieux */ }
  }

  function read(pid) {
    try {
      var raw = sessionStorage.getItem(SS_PREFIX + pid);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.p || Date.now() - (p.t || 0) > SS_TTL) return null;
      return p.p;
    } catch (e) { return null; }
  }

  /* ── Pré-charge (idempotent, silencieux) ─────────────────────────────────── */
  function profile(pid) {
    if (!pid || !/^[A-Za-z0-9]{6,16}$/.test(pid)) return;
    if (read(pid)) return;                 // déjà en main
    if (inflight[pid]) return;             // déjà en vol
    inflight[pid] = true;
    fetch(API_URL + encodeURIComponent(pid) + URL_SUFFIX, { cache: 'default', priority: 'low' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) store(pid, j); })
      .catch(function () { /* silencieux */ })
      .finally(function () { delete inflight[pid]; });
  }

  /* ── Détection des liens profile.html (délégation globale) ──────────────── */
  function nearestProfileLink(el) {
    while (el && el !== document.documentElement) {
      if (el.tagName === 'A' && /profile\.html/.test(el.getAttribute('href') || '')) return el;
      el = el.parentElement;
    }
    return null;
  }

  var lastHover = { href: '', at: 0 };
  document.addEventListener('pointerover', function (ev) {
    var a = nearestProfileLink(ev.target);
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var now = Date.now();
    if (href === lastHover.href && now - lastHover.at < 800) return; // anti-spam
    lastHover = { href: href, at: now };
    var pid = pidFromHref(href);
    if (pid) profile(pid);
  }, { passive: true });

  document.addEventListener('pointerdown', function (ev) {
    var a = nearestProfileLink(ev.target);
    if (!a) return;
    var pid = pidFromHref(a.getAttribute('href') || '');
    if (pid) profile(pid); // appui = dernier bus avant navigation
  }, { passive: true, capture: true });

  /* ── Liens visibles : pré-charge au repos (8 max par page) ──────────────── */
  function prefetchVisible() {
    var links = document.querySelectorAll('a[href*="profile.html"]');
    var seen = {};
    var count = 0;
    for (var i = 0; i < links.length && count < 8; i++) {
      var pid = pidFromHref(links[i].getAttribute('href') || '');
      if (!pid || seen[pid]) continue;
      seen[pid] = true;
      count++;
      profile(pid);
    }
  }

  var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
  var kicked = false;
  function kick() {
    if (kicked) return;
    kicked = true;
    idle(function () { prefetchVisible(); }, { timeout: 3000 });
  }
  if (document.readyState === 'complete') kick();
  else window.addEventListener('load', kick, { once: true });

  /* API publique (scripts page : pré-charger un pid connu au rendu d'une ligne) */
  window.TFHPrefetch = {
    profile: profile,
    read: read
  };
})();
