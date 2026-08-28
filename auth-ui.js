/**
 * auth-ui.js — Auth UI glue pour la page Lobby.
 * ──────────────────────────────────────────────────────────────────────
 * Extrait de app.js (logique dashboard/index) pour que la page Lobby ait
 * un bouton "Connexion" fonctionnel SANS charger app.min.js (2762 lignes
 * qui s'attendent au DOM du tableau de bord).
 *
 * Fournit les globals utilisés par les onclick de lobby.html :
 *   toggleAuthModal, handleLogin, handleLogout,
 *   toggleUserDropdown, goToProfilePage
 *
 * Dépendances : auth.js (chargé avant, exporte l'API Firebase).
 * Tous les éléments DOM sont optionnels → utilisable sur n'importe quelle
 * page qui inclut le markup auth (modal + sidebar).
 */

import { auth, db, doc, getDoc, onAuthStateChanged } from "./auth.js";

/* ════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════ */

function esc(v) {
  return v == null ? "" : String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") {
    window.showToast(msg, type, duration);
  } else {
    console.log(`[auth-ui:${type}]`, msg);
  }
}

/* ════════════════════════════════════════════════════════════════════
   Globals pour les onclick du HTML
   ════════════════════════════════════════════════════════════════════ */

// Enregistrés immédiatement : disponibles même si le reste du module échoue
window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  window.location.href = "profile.html";
};

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

function closeUserDropdown() {
  const userContainer = document.getElementById("user-container");
  if (userContainer) userContainer.classList.remove("open");
}

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const userContainer = document.getElementById("user-container");
  if (userContainer) userContainer.classList.toggle("open");
};

/* ════════════════════════════════════════════════════════════════════
   Connexion — Discord uniquement (redirection OAuth /api/auth/discord/)
   ════════════════════════════════════════════════════════════════════ */

let _loginInProgress = false; // L11 : anti double-clic

// État visuel du bouton Discord pendant la redirection OAuth
function setDiscordRedirecting(redirecting) {
  const btn = document.getElementById("auth-btn-discord") || document.querySelector(".auth-btn.discord");
  if (!btn) return;
  const label = btn.querySelector(".auth-btn-label");
  if (redirecting) {
    btn.disabled = true;
    btn.classList.add("is-redirecting");
    if (label) label.textContent = "Redirection vers Discord…";
  } else {
    btn.disabled = false;
    btn.classList.remove("is-redirecting");
    if (label) label.textContent = "Continuer avec Discord";
  }
}

window.handleLogin = async function (provider) {
  if (_loginInProgress) return;
  _loginInProgress = true;
  console.log("[auth-ui] Connexion Discord…");

  setDiscordRedirecting(true);

  // Le flag doit être posé AVANT la redirection (le retour OAuth recharge
  // la page : onAuthStateChanged lit ce flag pour le comportement post-login)
  try { sessionStorage.setItem("tfs_just_logged_in", "1"); } catch {}

  try {
    // loginWithDiscord() redirige vers l'OAuth Discord ; la page est quittée.
    await window.loginWithDiscord();
  } catch (error) {
    try { sessionStorage.removeItem("tfs_just_logged_in"); } catch {}
    console.error("[auth-ui] Erreur d'authentification:", error);
    _loginInProgress = false;
    setDiscordRedirecting(false);
  }
};

/* ════════════════════════════════════════════════════════════════════
   Déconnexion
   ════════════════════════════════════════════════════════════════════ */

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  closeUserDropdown();
  if (confirm("Voulez-vous vous déconnecter ?")) {
    await window.logout();
    updateAuthUI(null);
  }
};

/* ════════════════════════════════════════════════════════════════════
   UI : bouton Connexion ↔ badge utilisateur
   ════════════════════════════════════════════════════════════════════ */

function initials(name) {
  return (name || "U").substring(0, 2).toUpperCase();
}

function updateAuthUI(user) {
  const loginBtnMain = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");

  if (user) {
    if (loginBtnMain) loginBtnMain.style.display = "none";
    if (userContainer) {
      userContainer.style.display = "block";

      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText("user-display-name", user.name || "User");
      setText("dropdown-username-display", user.name || "User");
      setText("dropdown-publicid-display", user.publicId || "Non lié");

      const renderAvatar = (el) => {
        if (!el) return;
        if (user.avatar) {
          el.innerHTML = `<img src="${esc(user.avatar)}" alt="${esc(user.name || "User")}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
        } else {
          el.innerHTML = "";
          el.textContent = initials(user.name);
          el.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
          el.style.color = "#fff";
        }
      };
      renderAvatar(document.getElementById("dropdown-avatar"));
      renderAvatar(document.getElementById("sidebar-avatar"));
    }
  } else {
    if (loginBtnMain) loginBtnMain.style.display = "flex";
    if (userContainer) {
      userContainer.style.display = "none";
      userContainer.classList.remove("open");
    }
  }
}

/* ════════════════════════════════════════════════════════════════════
   État d'authentification (profil Firestore users/{uid})
   ════════════════════════════════════════════════════════════════════ */

let currentUser = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    updateAuthUI(null);
    console.log("[auth-ui] Utilisateur déconnecté");
    return;
  }

  // Lecture du profil Firestore (best-effort — l'UI reste utilisable si HS)
  let userDoc;
  try {
    userDoc = await getDoc(doc(db, "users", user.uid));
  } catch (e) {
    console.warn("[auth-ui] Firestore read failed:", e.message);
    userDoc = { exists: () => false, data: () => null };
  }

  // Login tout juste effectué sur CETTE page → même comportement que app.js :
  // profil complet → profile.html ; sinon → index.html (modal de configuration)
  let justLoggedIn = false;
  try { justLoggedIn = sessionStorage.getItem("tfs_just_logged_in") === "1"; } catch {}
  if (justLoggedIn) {
    try { sessionStorage.removeItem("tfs_just_logged_in"); } catch {}
    const data = userDoc.exists() ? userDoc.data() : null;
    if (data && data.publicId) {
      toast("Bienvenue " + (data.username || "") + " ! Redirection...", "success", 1500);
      setTimeout(() => { window.location.href = "profile.html"; }, 800);
      return;
    }
    // Pas encore de profil → index.html déclenche le modal de configuration
    window.location.href = "index.html";
    return;
  }

  if (userDoc.exists()) {
    const userData = userDoc.data();
    currentUser = {
      name: userData.username,
      publicId: userData.publicId,
      avatar: user.photoURL,
      uid: user.uid,
    };
  } else {
    // Compte sans profil (login effectué sur une autre page) — badge simple
    currentUser = {
      name: user.displayName || "Joueur",
      publicId: null,
      avatar: user.photoURL,
      uid: user.uid,
    };
  }
  updateAuthUI(currentUser);
  console.log("[auth-ui] Profil chargé:", currentUser.name);
});

/* ════════════════════════════════════════════════════════════════════
   Fermetures (clic extérieur + Échap)
   ════════════════════════════════════════════════════════════════════ */

document.addEventListener("click", (e) => {
  const userContainer = document.getElementById("user-container");
  if (userContainer && userContainer.classList.contains("open")) {
    if (!userContainer.contains(e.target)) closeUserDropdown();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeUserDropdown();
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  }
});

/* Exposition debug */
window._authUiDebug = { get currentUser() { return currentUser; } };
