/**
 * auth.js v2 — Couche de compatibilité API MySQL pour TheFrontHub.
 * ─────────────────────────────────────────────────────────────────────
 * REMPLACE Firebase Auth + Firestore par l'API PHP /api/ (MySQL o2switch).
 *
 * Stratégie zéro-régression : ce module exporte les MÊMES symboles que
 * l'ancienne version Firebase (auth, db, doc, getDoc, setDoc, collection,
 * onSnapshot, onAuthStateChanged, signOut, increment, deleteField...).
 * → app.js, profile.js, auth-ui.js et dashboard.min.js continuent de
 *   fonctionner sans aucune modification.
 *
 * Correspondances :
 *   Firebase Auth popup/redirect  → /api/auth/discord/login.php (OAuth2 direct)
 *   Firestore users/{uid}         → /api/me.php + /api/profile.php
 *   Firestore public-aliases      → /api/public-aliases.php + /api/profile.php
 *   Firestore public-rewards      → /api/public-rewards.php + /api/rewards.php
 *   Firestore likes/{runId}       → /api/likes.php
 *   (user-skins / reward-codes    → /api/skins.php, géré par reward-codes.js v2)
 */

/* ══════════════════════════════════════════════════════════════════
   Tokens opaques (l'API réelle est /api/, ces objets ne servent qu'à
   garder la même signature que Firebase)
   ══════════════════════════════════════════════════════════════════ */

const auth = { __tfhCompat: "auth" };
const db = { __tfhCompat: "db" };
const googleProvider = { __tfhCompat: "googleProvider" };
const discordProvider = { __tfhCompat: "discordProvider" };

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

function safeShowToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") {
    window.showToast(msg, type, duration);
    return;
  }
  console.log(`[auth/toast:${type}]`, msg);
  setTimeout(() => {
    if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  }, 600);
}

async function apiGet(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.code = body.error || `http_${res.status}`;
    throw err;
  }
  return res.json();
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.code = body.error || `http_${res.status}`;
    throw err;
  }
  return body;
}

/* ══════════════════════════════════════════════════════════════════
   État d'authentification (remplace Firebase Auth)
   ══════════════════════════════════════════════════════════════════ */

let _currentUser = null;        // objet "user" façon Firebase ou null
let _meRaw = null;              // réponse brute /api/me.php (profil complet)
let _stateReady = false;
const _authListeners = [];

/** Construit l'objet user façon Firebase depuis la réponse /api/me.php. */
function mapFirebaseUser(me) {
  return {
    uid: String(me.id),
    displayName: me.displayName || me.username || "Joueur",
    email: me.email || null,
    photoURL: me.avatarUrl || null,
    isAdmin: !!me.isAdmin,
  };
}

/** Document "users/{uid}" façon Firestore (consommé par app.js / profile.js). */
function mapUserDoc(me) {
  return {
    username: me.username,
    publicId: me.publicId,
    email: me.email || null,
    verified: !!me.publicId,
    createdAt: me.createdAt,
    updatedAt: me.lastLoginAt || me.createdAt,
    openFrontSessions: me.openFrontSessions || null,
  };
}

async function fetchMe() {
  try {
    const data = await apiGet("/api/me.php");
    _meRaw = data.ok ? data.user : null;
  } catch {
    _meRaw = null;
  }
  _currentUser = _meRaw ? mapFirebaseUser(_meRaw) : null;
  _stateReady = true;
  // Langue du compte : si le compte a une préférence enregistrée (choix fait
  // à l'inscription ou via les drapeaux) et que cet appareil n'a AUCUN choix
  // local, on applique la langue du compte (sans reload — DOM déjà prêt).
  if (_meRaw && typeof window.applyAccountLanguage === "function") {
    try { window.applyAccountLanguage(_meRaw.language || null); } catch {}
  }
  notifyAuthListeners();
  return _currentUser;
}

function notifyAuthListeners() {
  window._authUser = _currentUser;
  for (const cb of _authListeners) {
    try { cb(_currentUser); } catch (e) { console.warn("[auth] listener error:", e); }
  }
}

/**
 * onAuthStateChanged(auth, callback) — même contrat que Firebase.
 * Le callback reçoit l'utilisateur (ou null) dès que l'état est connu,
 * puis à chaque changement (login/logout).
 * @returns fonction de désabonnement
 */
function onAuthStateChanged(_auth, callback) {
  if (typeof callback !== "function") return () => {};
  _authListeners.push(callback);
  if (_stateReady) {
    // État déjà connu → notification immédiate (asynchrone comme Firebase)
    Promise.resolve().then(() => callback(_currentUser));
  }
  return () => {
    const i = _authListeners.indexOf(callback);
    if (i !== -1) _authListeners.splice(i, 1);
  };
}

/* ── Connexion / déconnexion ── */

const NEVER = new Promise(() => {}); // la page navigue : promesse jamais résolue

async function signInWithPopup(_auth, provider) {
  if (provider === discordProvider) {
    // Redirection OAuth2 vers Discord (le cookie de session sera posé au retour)
    window.location.href = "/api/auth/discord/login.php";
    return NEVER;
  }
  const err = new Error("La connexion Google arrive bientôt. Utilise Discord pour l'instant !");
  err.code = "auth/operation-not-allowed";
  throw err;
}

async function signOut(_auth) {
  try {
    await apiPost("/api/logout.php", {});
  } catch (e) {
    console.warn("[auth] logout API error:", e.message);
  }
  _meRaw = null;
  _currentUser = null;
  _stateReady = true;
  notifyAuthListeners();
}

/* ══════════════════════════════════════════════════════════════════
   Marqueurs façon Firestore
   ══════════════════════════════════════════════════════════════════ */

function doc(_db, coll, id) {
  return { __tfhDoc: true, coll, id, path: `${coll}/${id}` };
}

function collection(_db, coll) {
  return { __tfhColl: true, coll };
}

function where(field, op, value) {
  return { __tfhWhere: true, field, op, value };
}

function query(collRef, ...wheres) {
  return { __tfhQuery: true, coll: collRef.coll, wheres };
}

/** increment()/deleteField() : marqueurs détectés par setDoc/updateDoc. */
function increment(n) { return { __tfhIncrement: n }; }
function deleteField() { return { __tfhDeleteField: true }; }

/* ── Snapshots façon Firestore ── */

function makeDocSnapshot(id, data) {
  const exists = data !== null && data !== undefined;
  return {
    id,
    exists: () => exists,
    data: () => (exists ? data : undefined),
  };
}

function makeQuerySnapshot(docs) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
    forEach: (cb) => docs.forEach((d) => cb(d)),
  };
}

/* ══════════════════════════════════════════════════════════════════
   getDoc — lectures ponctuelles
   ══════════════════════════════════════════════════════════════════ */

async function getDoc(ref) {
  if (!ref || !ref.__tfhDoc) {
    throw new Error("[auth] getDoc : référence invalide");
  }

  /* users/{uid} → profil du compte connecté (seul cas utilisé par le site) */
  if (ref.coll === "users") {
    if (!_stateReady) await fetchMe();
    if (_meRaw && String(_meRaw.id) === String(ref.id)) {
      return makeDocSnapshot(ref.id, mapUserDoc(_meRaw));
    }
    return makeDocSnapshot(ref.id, null);
  }

  /* likes/{runId} → état d'un run */
  if (ref.coll === "likes") {
    try {
      const data = await apiGet(`/api/likes.php?run=${encodeURIComponent(ref.id)}`);
      return makeDocSnapshot(ref.id, {
        count: data.count || 0,
        users: data.liked ? { [String(_meRaw?.id ?? "")]: true } : {},
      });
    } catch (e) {
      console.warn("[auth] getDoc likes failed:", e.message);
      return makeDocSnapshot(ref.id, { count: 0, users: {} });
    }
  }

  /* Autres collections : gérées par leur module dédié (reward-codes.js v2) */
  console.warn(`[auth] getDoc : collection non supportée "${ref.coll}"`);
  return makeDocSnapshot(ref.id, null);
}

async function getDocs(q) {
  // Utilisé uniquement par l'ancien reward-codes.js (remplacé par /api/skins.php)
  console.warn("[auth] getDocs : non supporté par la couche de compatibilité");
  return makeQuerySnapshot([]);
}

/* ══════════════════════════════════════════════════════════════════
   setDoc / updateDoc — écritures
   ══════════════════════════════════════════════════════════════════ */

async function setDoc(ref, data, _opts) {
  if (!ref || !ref.__tfhDoc) {
    throw new Error("[auth] setDoc : référence invalide");
  }

  /* users/{uid} → sauvegarde du profil (username + publicId [+ sessions]) */
  if (ref.coll === "users") {
    const payload = {};
    if (data && data.username !== undefined) payload.username = data.username;
    if (data && data.publicId !== undefined && data.publicId !== null) payload.publicId = data.publicId;
    if (data && Array.isArray(data.openFrontSessions)) payload.openFrontSessions = data.openFrontSessions;
    await apiPost("/api/profile.php", payload);
    // Rafraîchit l'état local (le profil vient de changer)
    fetchMe().catch(() => {});
    return;
  }

  /* public-aliases/{uid} → pont alias (l'API met à jour la table dédiée) */
  if (ref.coll === "public-aliases") {
    const payload = {};
    if (data && data.username !== undefined) payload.username = data.username;
    if (data && data.publicId !== undefined && data.publicId !== null) payload.publicId = data.publicId;
    try {
      await apiPost("/api/profile.php", payload);
    } catch (e) {
      console.warn("[auth] bridge public-aliases (non-critique):", e.message);
    }
    return;
  }

  /* public-rewards/{uid} → pont VIP (upsert SANS toucher aux champs VIP) */
  if (ref.coll === "public-rewards") {
    try {
      await apiPost("/api/rewards.php", {
        publicId: data?.publicId,
        username: data?.username,
      });
    } catch (e) {
      console.warn("[auth] bridge public-rewards (non-critique):", e.message);
    }
    return;
  }

  /* likes/{runId} → like (merge increment + users map = "j'aime") */
  if (ref.coll === "likes") {
    const isUnlike =
      (data?.count && data.count.__tfhIncrement !== undefined && data.count.__tfhIncrement < 0) ||
      Object.values(data?.users || {}).some((v) => v && v.__tfhDeleteField);
    await apiPost("/api/likes.php", {
      runId: ref.id,
      action: isUnlike ? "unlike" : "like",
    });
    return;
  }

  throw new Error(`[auth] setDoc : collection non supportée "${ref.coll}"`);
}

async function updateDoc(ref, data) {
  if (!ref || !ref.__tfhDoc) {
    throw new Error("[auth] updateDoc : référence invalide");
  }
  /* Seul cas utilisé par le site : unlike atomique sur likes/{runId} */
  if (ref.coll === "likes") {
    const dec = data?.count && data.count.__tfhIncrement !== undefined && data.count.__tfhIncrement < 0;
    const del = Object.values(data || {}).some((v) => v && v.__tfhDeleteField);
    await apiPost("/api/likes.php", {
      runId: ref.id,
      action: dec || del ? "unlike" : "like",
    });
    return;
  }
  return setDoc(ref, data, {});
}

async function runTransaction(_db, _fn) {
  throw new Error("[auth] runTransaction : remplacé par l'API /api/skins.php (redeem atomique côté serveur)");
}

/* ══════════════════════════════════════════════════════════════════
   onSnapshot — écoutes "temps réel" (polling de l'API)
   ══════════════════════════════════════════════════════════════════ */

const POLL_INTERVALS = {
  likes: 20 * 1000,          // activité "GG" : plutôt frais
  "public-aliases": 60 * 1000,
  "public-rewards": 60 * 1000,
};

function onSnapshot(ref, callback, errCallback) {
  if (typeof callback !== "function") return () => {};

  const coll = ref && ref.coll; // doc() et collection() exposent tous deux .coll
  if (!coll || !POLL_INTERVALS[coll]) {
    console.warn(`[auth] onSnapshot : collection non supportée "${coll}"`);
    if (typeof errCallback === "function") {
      errCallback(new Error(`Collection non supportée: ${coll}`));
    }
    return () => {};
  }

  let stopped = false;
  let timer = null;

  const endpoints = {
    likes: "/api/likes.php",
    "public-aliases": "/api/public-aliases.php",
    "public-rewards": "/api/public-rewards.php",
  };

  async function poll() {
    if (stopped) return;
    try {
      const data = await apiGet(endpoints[coll]);

      if (coll === "likes") {
        const docs = Object.entries(data.likes || {}).map(([runId, v]) =>
          makeDocSnapshot(runId, { count: v.count || 0, users: v.users || {} })
        );
        callback(makeQuerySnapshot(docs));
      } else if (coll === "public-aliases") {
        const docs = (data.aliases || []).map((a) =>
          makeDocSnapshot(a.uid, {
            username: a.username,
            publicId: a.publicId,
            aliases: a.aliases && a.aliases.length ? a.aliases : (a.username ? [a.username] : []),
          })
        );
        callback(makeQuerySnapshot(docs));
      } else if (coll === "public-rewards") {
        const docs = (data.rewards || []).map((r) =>
          makeDocSnapshot(r.publicId, {
            publicId: r.publicId,
            username: r.username,
            activeType: r.activeType,
            type: r.type,
            activated: r.activated,
          })
        );
        callback(makeQuerySnapshot(docs));
      }
    } catch (e) {
      console.warn(`[auth] onSnapshot ${coll} poll error:`, e.message);
    }
    if (!stopped) {
      timer = setTimeout(poll, POLL_INTERVALS[coll]);
    }
  }

  poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/* ══════════════════════════════════════════════════════════════════
   Exports (identiques à l'ancienne version Firebase)
   ══════════════════════════════════════════════════════════════════ */

export {
  auth, db,
  doc, getDoc, getDocs, setDoc, updateDoc,
  collection, query, where, onSnapshot,
  increment, deleteField, runTransaction,
  googleProvider, discordProvider,
  signInWithPopup, signOut, onAuthStateChanged,
};

/* ══════════════════════════════════════════════════════════════════
   Globals (handlers onclick du HTML + scripts non-module)
   ══════════════════════════════════════════════════════════════════ */

window.loginWithDiscord = () => signInWithPopup(auth, discordProvider);
window.loginWithGoogle = () =>
  signInWithPopup(auth, googleProvider).catch((e) => {
    safeShowToast(e.message, "warning", 3500);
    throw e;
  });
window.logout = () => signOut(auth);

window._authUser = null;
window._onAuthUserChanged = [];
window._firestoreDb = db;      // stubs de compat (lobby.js et outils debug)
window._firestoreAuth = auth;
window._firestore = {
  doc, getDoc, getDocs, setDoc, updateDoc,
  collection, query, where, onSnapshot,
  increment, deleteField, runTransaction,
};

/** Rafraîchit manuellement l'état (utile après les redirections OAuth). */
window._tfhAuthRefresh = fetchMe;

/* ══════════════════════════════════════════════════════════════════
   Démarrage : détection du retour OAuth + premier état
   ══════════════════════════════════════════════════════════════════ */

(function handleLoginRedirectParams() {
  // Le login Google est reporté : on masque ses boutons partout
  try {
    const style = document.createElement("style");
    style.textContent = ".auth-btn.google{display:none!important}";
    document.head.appendChild(style);
  } catch {}

  try {
    const url = new URL(window.location.href);
    const login = url.searchParams.get("login");

    if (login === "discord-ok") {
      // Le callback OAuth vient de nous ramener : le flag de login frais est
      // déjà posé par handleLogin() avant la redirection vers Discord.
      safeShowToast("Connexion réussie !", "success", 3000);
    } else if (login === "error") {
      const reason = url.searchParams.get("reason") || "unknown";
      console.warn("[auth] Échec du login Discord:", reason);
      const messages = {
        bad_state: "Session de connexion expirée. Réessaie.",
        bad_params: "Réponse Discord invalide. Réessaie.",
        token_exchange_http_400: "Le code Discord a été refusé. Réessaie.",
        db_error: "Erreur serveur pendant la connexion. Réessaie dans un instant.",
        access_denied: "Connexion annulée.",
      };
      safeShowToast(messages[reason] || "Échec de la connexion. Réessaie.", "error", 5000);
      try { sessionStorage.removeItem("tfs_just_logged_in"); } catch {}
    }

    if (login) {
      // Nettoie l'URL sans recharger la page
      url.searchParams.delete("login");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : ""));
    }
  } catch { /* URL invalide : on ignore */ }
})();

fetchMe();
