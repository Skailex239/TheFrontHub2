// support.js — Support & messagerie TheFrontHub (v2)
//
// Nouvelle catégorie « Support » : contacte l'équipe, suis tes conversations,
// reçois les réponses ici (et par email). L'équipe répond depuis cette même
// page (bascule « Vue équipe » visible uniquement par les admins).
//
// Backend : api/support.php (tickets + messages en MySQL, session Discord
// obligatoire). Notifications mail best-effort côté serveur.

/* ═══ i18n (moteur global i18n.js — dictionnaire : i18n-dict-support.js) ═══
   T(clé, fallback) : traduit via window.t, retombe sur le texte FR sinon.
   TP(clé, params, fallback) : idem avec substitution {param}. */
const T = (k, fb) => (typeof window.t === "function" ? window.t(k) : fb);
const TP = (k, params, fb) => {
  if (typeof window.t !== "function") return fb;
  const v = window.t(k, params);
  return v && v !== k ? v : fb;
};

const SUP_CATEGORIES = [
  { key: "question",     tkey: "sup.cat_question",     label: "Question" },
  { key: "bug",          tkey: "sup.cat_bug",          label: "Bug / Problème" },
  { key: "signalement",  tkey: "sup.cat_signalement",  label: "Signalement" },
  { key: "idee",         tkey: "sup.cat_idee",         label: "Idée / Suggestion" },
  { key: "autre",        tkey: "sup.cat_autre",        label: "Autre" },
];

const SUP_STATUS = {
  open:     { tkey: "sup.status_open",     label: "Ouvert",   cls: "open" },
  answered: { tkey: "sup.status_answered", label: "Répondu",  cls: "answered" },
  closed:   { tkey: "sup.status_closed",   label: "Fermé",    cls: "closed" },
};

// Logo Discord — même path que le footer (support.html)
const SUP_DISCORD_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;

// Icône « chat » style lucide (absente du jeu icons.js) — inline SVG stroke 24×24
const SUP_CHAT_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;

const SUP_ARROW_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

// FAQ — réponses courtes, formulations maison (HTML interne maîtrisé, pas de
// contenu utilisateur → pas d'échappement nécessaire ici).
const SUP_FAQ = [
  {
    qk: "sup.faq1_q",
    q: "Comment se connecter à TheFrontHub ?",
    ak: "sup.faq1_a",
    a: `Un seul clic : clique sur « Connexion » puis « Continuer avec Discord ». Aucun mot de passe, aucun email — ta session Discord fait tout.`,
  },
  {
    qk: "sup.faq2_q",
    q: "Comment sont calculés les points classés ?",
    ak: "sup.faq2_a",
    a: `Les points se gagnent sur tes victoires en classé 1v1 et 2v2, selon ta place finale dans la partie. Plus tu finis haut, plus tu gagnes.`,
  },
  {
    qk: "sup.faq3_q",
    q: "À quelle fréquence les classements sont-ils mis à jour ?",
    ak: "sup.faq3_a",
    a: `Automatiquement et régulièrement, à partir des données officielles d'OpenFront.io. Si ton rang ne bouge pas, c'est que ta dernière partie n'a pas encore été synchronisée.`,
  },
  {
    qk: "sup.faq4_q",
    q: "Comment participer aux tournois ?",
    ak: "sup.faq4_a",
    a: `Rends-toi sur la <a href="tournois.html">page Tournois</a> : les inscriptions sont ouvertes jusqu'à la date de lancement indiquée. Les annonces passent aussi sur le <a href="https://discord.gg/AZhmqRvbNh" target="_blank" rel="noreferrer" aria-label="Discord TheFrontHub (nouvel onglet)">Discord</a>.`,
  },
  {
    qk: "sup.faq5_q",
    q: "Comment signaler un bug ou un joueur ?",
    ak: "sup.faq5_a",
    a: `Ouvre un ticket avec le formulaire ci-dessous, catégorie « Bug / Problème » ou « Signalement ». Décris précisément (pseudos, dates, ce qui s'est passé) — l'équipe te répond ici et par email.`,
  },
  {
    qk: "sup.faq6_q",
    q: "Comment proposer une idée ?",
    ak: "sup.faq6_a",
    a: `Ouvre un ticket catégorie « Idée / Suggestion », ou viens en discuter sur le <a href="https://discord.gg/AZhmqRvbNh" target="_blank" rel="noreferrer" aria-label="Discord TheFrontHub (nouvel onglet)">Discord</a>. Les idées de la communauté façonnent les prochaines mises à jour.`,
  },
  {
    qk: "sup.faq7_q",
    q: "Comment supprimer mon compte ou mes données ?",
    ak: "sup.faq7_a",
    a: `Envoie ta demande par email à <a href="mailto:support@thefronthub.com">support@thefronthub.com</a> : ton compte et tes données personnelles seront supprimés.`,
  },
  {
    qk: "sup.faq8_q",
    q: "Le site est-il officiel d'OpenFront.io ?",
    ak: "sup.faq8_a",
    a: `Non — TheFrontHub est un projet communautaire réalisé par des fans, sans aucune affiliation avec OpenFront.io.`,
  },
];

const state = {
  user: null,        // compte connecté (api/me.php) ou null
  isAdmin: false,    // membre de l'équipe (renvoyé par l'API)
  scope: "mine",     // mine | all (bascule équipe)
  tickets: [],
  activeId: null,    // ticket ouvert dans le panneau de droite
  thread: null,      // { ticket, messages }
  loading: false,
  sending: false,
};

/* ═══ Utilitaires ═══ */

const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtDate(mysqlDate) {
  if (!mysqlDate) return "—";
  // "YYYY-MM-DD HH:MM:SS" (heure serveur) → affichage local (langue courante)
  const d = new Date(String(mysqlDate).replace(" ", "T") + (String(mysqlDate).includes("+") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(mysqlDate);
  const locale = (typeof window !== "undefined" && window.currentLanguage === "en") ? "en-GB" : "fr-FR";
  return d.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function toast(msg, type = "info", duration = 4000, icon = undefined) {
  window.showToast?.(msg, type, duration, icon);
}

function categoryLabel(key) {
  const c = SUP_CATEGORIES.find((cat) => cat.key === key);
  if (c) return T(c.tkey, c.label);
  return key || T("sup.cat_autre", "Autre");
}

function statusMeta(status) {
  return SUP_STATUS[status] || SUP_STATUS.open;
}

function statusLabel(st) {
  return T(st.tkey, st.label);
}

/* Chat en direct : widget global posé par dist/chat-widget.min.js (agent 4-c).
   Fallback gracieux si le widget n'est pas (encore) chargé. */
function openLiveChat() {
  const widget = window.TfhChatWidget;
  if (widget && typeof widget.open === "function") {
    try {
      widget.open();
      return;
    } catch (err) {
      console.warn("[support] TfhChatWidget.open() a échoué :", err);
    }
  }
  const msg = T("sup.chat_soon", "Chat en direct bientôt disponible — écris-nous via le formulaire ou sur le Discord en attendant.");
  if (typeof window.showToast === "function") {
    toast(msg, "info", 6000, "info");
  } else {
    alert(msg);
  }
}

// Exposé pour la délégation d'événements et le debug console
if (typeof window !== "undefined") window.TfhSupportOpenChat = openLiveChat;

/* ═══ Boot : qui suis-je ? ═══ */

async function initAccount() {
  try {
    const res = await fetch("api/me.php", { credentials: "same-origin", cache: "no-store" });
    state.user = res.ok ? ((await res.json()).user || null) : null;
  } catch {
    state.user = null;
  }
  render();
  if (state.user) await loadTickets();
}

/* ═══ API ═══ */

async function loadTickets() {
  state.loading = true;
  renderList();
  try {
    const q = state.scope === "all" ? "?scope=all" : "";
    const res = await fetch(`api/support.php${q}`, { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) { state.user = null; render(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.isAdmin = !!data.is_admin;
    if (state.scope === "all" && !state.isAdmin) state.scope = "mine";
    state.tickets = Array.isArray(data.tickets) ? data.tickets : [];
  } catch {
    toast(T("sup.err_load", "Impossible de charger tes conversations, réessaie"), "error");
    state.tickets = [];
  }
  state.loading = false;
  renderList();
}

async function loadThread(id) {
  state.activeId = id;
  state.thread = null;
  renderThread();
  try {
    const res = await fetch(`api/support.php?action=thread&id=${encodeURIComponent(id)}`, {
      credentials: "same-origin", cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.isAdmin = !!data.is_admin;
    state.thread = { ticket: data.ticket, messages: data.messages || [] };
  } catch {
    toast(T("sup.err_thread", "Impossible d'ouvrir cette conversation"), "error");
    state.activeId = null;
  }
  renderThread();
}

async function createTicket(payload) {
  if (state.sending) return;
  state.sending = true;
  renderForm();
  try {
    const res = await fetch("api/support.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.user = null;
      render();
      return;
    }
    if (!res.ok) {
      toast(data.message || T("sup.err_send", "Envoi impossible — vérifie ton message et réessaie"), "error", 5000);
      return;
    }
    toast(T("sup.ok_sent", "Message envoyé à l'équipe ✅ Tu recevras une réponse ici (et par email si renseigné)."), "success", 6000, "checkCircle");
    document.getElementById("sup-subject").value = "";
    document.getElementById("sup-message").value = "";
    document.getElementById("sup-category").value = "question";
    await loadTickets();
    if (data.ticket_id) await loadThread(data.ticket_id);
  } catch {
    toast(T("sup.err_network", "Erreur réseau — réessaie"), "error");
  } finally {
    state.sending = false;
    renderForm();
  }
}

async function replyTicket(id, message) {
  if (state.sending) return;
  state.sending = true;
  renderThread();
  try {
    const res = await fetch("api/support.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reply", ticket_id: id, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.message || T("sup.err_reply", "Envoi impossible, réessaie"), "error", 5000);
      return;
    }
    toast(T("sup.ok_reply", "Réponse envoyée"), "success", 3000, "checkCircle");
    await Promise.all([loadThread(id), loadTickets()]);
  } catch {
    toast(T("sup.err_network", "Erreur réseau — réessaie"), "error");
  } finally {
    state.sending = false;
    renderThread();
  }
}

async function closeTicket(id) {
  try {
    const res = await fetch("api/support.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close", ticket_id: id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast(T("sup.ok_closed", "Conversation fermée"), "info", 3000);
    await Promise.all([loadThread(id), loadTickets()]);
  } catch {
    toast(T("sup.err_close", "Impossible de fermer la conversation"), "error");
  }
}

/* ═══ Rendu ═══ */

const view = () => document.getElementById("support-view");

function render() {
  const v = view();
  if (!v) return;
  if (!state.user) {
    v.innerHTML = `
      <div class="sup-gate">
        <div class="sup-gate-icon"><i data-icon="lifebuoy" data-icon-size="34"></i></div>
        <h2>${T("sup.gate_title", "Besoin d'aide ? Contacte l'équipe")}</h2>
        <p>${T("sup.gate_text", "Connecte-toi avec Discord pour ouvrir un ticket de support, suivre tes conversations et recevoir les réponses de l'équipe ici et par email.")}</p>
        <button type="button" class="sup-btn sup-btn-primary" onclick="toggleAuthModal()">${T("sup.gate_login", "Connexion avec Discord")}</button>
      </div>`;
    return;
  }
  v.innerHTML = `
    <div class="sup-canals" aria-label="${T("sup.canals_aria", "Canaux de contact")}">
      <article class="sup-canal">
        <span class="sup-canal-icon" aria-hidden="true">${SUP_DISCORD_SVG}</span>
        <h3 class="sup-canal-title">${T("sup.canal_discord_title", "Rejoindre le Discord TheFrontHub")}</h3>
        <p class="sup-canal-desc">${T("sup.canal_discord_desc", "La communauté et l'équipe en direct : entraide, annonces et tournois.")}</p>
        <a class="sup-canal-cta sup-canal-cta-primary" href="https://discord.gg/AZhmqRvbNh" target="_blank" rel="noreferrer" aria-label="${T("sup.canal_discord_aria", "Rejoindre le Discord TheFrontHub (nouvel onglet)")}">
          ${T("sup.canal_discord_cta", "Rejoindre le Discord")} ${SUP_ARROW_SVG}
        </a>
      </article>

      <article class="sup-canal">
        <span class="sup-canal-icon" aria-hidden="true"><i data-icon="mail" data-icon-size="20"></i></span>
        <h3 class="sup-canal-title">${T("sup.canal_email_title", "Email support@thefronthub.com")}</h3>
        <p class="sup-canal-desc">${T("sup.canal_email_desc", "Pour toute demande officielle — réponse sous 48 h.")}</p>
        <a class="sup-canal-cta" href="mailto:support@thefronthub.com" aria-label="${T("sup.canal_email_aria", "Envoyer un email à support@thefronthub.com")}">
          ${T("sup.canal_email_cta", "Écrire un email")} ${SUP_ARROW_SVG}
        </a>
      </article>

      <article class="sup-canal">
        <span class="sup-canal-icon" aria-hidden="true">${SUP_CHAT_SVG}</span>
        <h3 class="sup-canal-title">${T("sup.canal_chat_title", "Chat en direct")}</h3>
        <p class="sup-canal-desc">${T("sup.canal_chat_desc", "Discute en direct avec l'équipe.")}</p>
        <button type="button" class="sup-canal-cta sup-chat-open" aria-label="${T("sup.canal_chat_aria", "Ouvrir le chat en direct avec l'équipe")}">
          ${T("sup.canal_chat_cta", "Ouvrir le chat")} ${SUP_ARROW_SVG}
        </button>
      </article>
    </div>

    <section class="sup-faq" aria-labelledby="sup-faq-title">
      <h2 id="sup-faq-title" class="sup-title"><i data-icon="info" data-icon-size="16"></i> ${T("sup.faq_title", "Questions fréquentes")}</h2>
      <div class="sup-faq-list">
        ${SUP_FAQ.map((f) => `
        <details class="sup-faq-item">
          <summary>
            <span class="sup-faq-q">${T(f.qk, f.q)}</span>
            <svg class="sup-faq-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>
          </summary>
          <div class="sup-faq-body"><p>${T(f.ak, f.a)}</p></div>
        </details>`).join("")}
      </div>
    </section>

    <div class="sup-grid">
      <div class="sup-left">
        <section class="sup-card sup-new" aria-labelledby="sup-new-title">
          <h2 id="sup-new-title" class="sup-title"><i data-icon="mail" data-icon-size="16"></i> ${T("sup.form_title", "Contacter l'équipe")}</h2>
          <p class="sup-new-sub">${T("sup.form_sub", "Une question, un bug, une idée ? Écris-nous — on te répond ici et par email.")}</p>
          <form id="sup-form" novalidate>
            <label class="sup-label" for="sup-category">${T("sup.label_category", "Catégorie")}</label>
            <select id="sup-category" class="sup-input" required>
              ${SUP_CATEGORIES.map((c) => `<option value="${c.key}">${esc(T(c.tkey, c.label))}</option>`).join("")}
            </select>
            <label class="sup-label" for="sup-subject">${T("sup.label_subject", "Sujet")}</label>
            <input id="sup-subject" class="sup-input" type="text" maxlength="140" minlength="4"
                   placeholder="${T("sup.placeholder_subject", "Ex. : récompense tournoi non reçue")}" required autocomplete="off">
            <label class="sup-label" for="sup-message">${T("sup.label_message", "Message")}</label>
            <textarea id="sup-message" class="sup-input" rows="6" maxlength="5000" minlength="10"
                      placeholder="${T("sup.placeholder_message", "Décris ta demande le plus précisément possible (pseudos, dates, screenshots via le Discord…)…")}" required></textarea>
            <div class="sup-form-foot">
              <span class="sup-hint">${T("sup.hint_session", "Session :")} <strong>${esc(state.user.displayName || state.user.globalName || state.user.username || "—")}</strong></span>
              <button type="submit" class="sup-btn sup-btn-primary" id="sup-send">
                <i data-icon="mail" data-icon-size="14"></i> ${T("sup.send", "Envoyer")}
              </button>
            </div>
          </form>
        </section>

        <section class="sup-card" aria-labelledby="sup-list-title">
          <div class="sup-list-head">
            <h2 id="sup-list-title" class="sup-title"><i data-icon="ladder" data-icon-size="16"></i> ${state.scope === "all" ? T("sup.list_all", "Toutes les conversations") : T("sup.list_mine", "Mes conversations")}</h2>
            ${state.isAdmin ? `
            <div class="sup-scope-toggle" role="group" aria-label="${T("sup.scope_aria", "Portée de la liste")}">
              <button type="button" class="sup-scope-btn ${state.scope === "mine" ? "on" : ""}" data-scope="mine">${T("sup.scope_mine", "Mes tickets")}</button>
              <button type="button" class="sup-scope-btn ${state.scope === "all" ? "on" : ""}" data-scope="all">${T("sup.scope_team", "Équipe")}</button>
            </div>` : ""}
          </div>
          <div id="sup-list" class="sup-list"></div>
        </section>
      </div>

      <div class="sup-thread-wrap ${state.activeId ? "active" : ""}" id="sup-thread-wrap">
        <div id="sup-thread" class="sup-card sup-thread"></div>
      </div>
    </div>`;

  // Brancher les events une fois (le rendu fin des listes passe par renderList/renderThread)
  const form = document.getElementById("sup-form");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const subject = document.getElementById("sup-subject").value.trim();
    const message = document.getElementById("sup-message").value.trim();
    const category = document.getElementById("sup-category").value;
    if (subject.length < 4) { toast(T("sup.err_subject", "Le sujet doit contenir au moins 4 caractères"), "warning"); return; }
    if (message.length < 10) { toast(T("sup.err_message", "Le message doit contenir au moins 10 caractères"), "warning"); return; }
    createTicket({ category, subject, message });
  });

  $$(".sup-scope-btn", v).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.scope = btn.dataset.scope === "all" ? "all" : "mine";
      render();
      loadTickets();
    });
  });

  renderList();
  renderThread();
}

function renderList() {
  const list = document.getElementById("sup-list");
  if (!list) return;

  if (state.loading) {
    list.innerHTML = `<div class="sup-loading"><div class="spinner"></div><p>${T("sup.loading_short", "Chargement…")}</p></div>`;
    return;
  }
  if (state.tickets.length === 0) {
    list.innerHTML = `
      <div class="sup-empty">
        <div class="sup-empty-icon"><i data-icon="mail" data-icon-size="26"></i></div>
        <p>${state.scope === "all" ? T("sup.empty_all", "Aucun ticket pour le moment.") : T("sup.empty_mine", "Aucune conversation pour l'instant.")}<br>
        <span class="sup-empty-sub">${state.scope === "all" ? T("sup.empty_all_sub", "Les demandes des joueurs apparaîtront ici.") : T("sup.empty_mine_sub", "Écris à l'équipe avec le formulaire ci-dessus — les réponses arrivent ici et par email.")}</span></p>
      </div>`;
    return;
  }

  list.innerHTML = state.tickets.map((t) => {
    const st = statusMeta(t.status);
    const who = state.scope === "all" && t.user_name ? `<span class="sup-ticket-user">${esc(t.user_name)}</span>` : "";
    return `
      <button type="button" class="sup-ticket ${state.activeId === t.id ? "is-active" : ""}" data-id="${t.id}">
        <div class="sup-ticket-top">
          <span class="sup-ticket-cat sup-cat-${esc(t.category)}">${esc(categoryLabel(t.category))}</span>
          <span class="sup-ticket-status sup-st-${st.cls}">${esc(statusLabel(st))}</span>
        </div>
        <div class="sup-ticket-subject">${esc(t.subject)}</div>
        <div class="sup-ticket-foot">
          ${who}
          <span class="sup-ticket-preview">${esc(t.preview || "")}</span>
          <span class="sup-ticket-date">${esc(fmtDate(t.updated_at))}</span>
        </div>
      </button>`;
  }).join("");

  $$(".sup-ticket", list).forEach((el) => {
    el.addEventListener("click", () => {
      loadThread(Number(el.dataset.id));
      // Mobile : le fil s'ouvre par-dessus la liste
      document.getElementById("sup-thread-wrap")?.classList.add("active");
    });
  });
}

function renderThread() {
  const el = document.getElementById("sup-thread");
  if (!el) return;

  if (!state.activeId) {
    el.innerHTML = `
      <div class="sup-thread-empty">
        <div class="sup-empty-icon"><i data-icon="lifebuoy" data-icon-size="30"></i></div>
        <p>${T("sup.thread_empty", "Sélectionne une conversation")}<br><span class="sup-empty-sub">${T("sup.thread_empty_sub", "ou écris-nous avec le formulaire.")}</span></p>
      </div>`;
    return;
  }

  if (!state.thread) {
    el.innerHTML = `<div class="sup-loading"><div class="spinner"></div><p>${T("sup.thread_loading", "Chargement de la conversation…")}</p></div>`;
    return;
  }

  const t = state.thread.ticket;
  const st = statusMeta(t.status);
  const canReply = t.status !== "closed" || state.isAdmin;

  el.innerHTML = `
    <div class="sup-thread-head">
      <button type="button" class="sup-back" id="sup-back" aria-label="${T("sup.back_aria", "Retour à la liste")}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        <span>${T("sup.back", "Retour")}</span>
      </button>
      <div class="sup-thread-meta">
        <span class="sup-ticket-cat sup-cat-${esc(t.category)}">${esc(categoryLabel(t.category))}</span>
        <span class="sup-ticket-status sup-st-${st.cls}">${esc(statusLabel(st))}</span>
        ${state.isAdmin && !t.mine ? `<span class="sup-ticket-user">${esc(state.tickets.find((x) => x.id === t.id)?.user_name || "")}</span>` : ""}
      </div>
      <h3 class="sup-thread-subject">${esc(t.subject)}</h3>
      <span class="sup-thread-date">${esc(TP("sup.thread_dates", { created: fmtDate(t.created_at), updated: fmtDate(t.updated_at) }, `ouvert ${fmtDate(t.created_at)} · dernière activité ${fmtDate(t.updated_at)}`))}</span>
    </div>

    <div class="sup-msgs" id="sup-msgs">
      ${state.thread.messages.map((m) => {
        const isTeam = m.author_role === "team";
        return `
        <div class="sup-msg ${isTeam ? "sup-msg-team" : "sup-msg-user"}">
          <div class="sup-msg-head">
            <span class="sup-msg-author">${isTeam ? esc(T("sup.msg_team", "🛠️ L'équipe TheFrontHub")) : esc(m.author_name || T("sup.msg_you", "Toi"))}</span>
            <span class="sup-msg-date">${esc(fmtDate(m.created_at))}</span>
          </div>
          <div class="sup-msg-body">${esc(m.body).replace(/\n/g, "<br>")}</div>
        </div>`;
      }).join("")}
    </div>

    <div class="sup-reply">
      ${canReply ? `
      <textarea id="sup-reply-input" class="sup-input" rows="3" maxlength="5000"
                placeholder="${esc(t.status === "closed" ? T("sup.reply_placeholder_closed", "Ticket fermé — réponse d'équipe possible") : T("sup.reply_placeholder", "Écrire une réponse…"))}"></textarea>
      <div class="sup-reply-foot">
        ${t.mine && t.status !== "closed" ? `<button type="button" class="sup-btn sup-btn-ghost" id="sup-close">${T("sup.mark_resolved", "Marquer résolu")}</button>` : ""}
        ${state.isAdmin && t.status !== "closed" ? `<button type="button" class="sup-btn sup-btn-ghost" id="sup-close-admin">${T("sup.close_ticket", "Fermer le ticket")}</button>` : ""}
        <button type="button" class="sup-btn sup-btn-primary" id="sup-reply-send">
          <i data-icon="mail" data-icon-size="14"></i> ${T("sup.reply", "Répondre")}
        </button>
      </div>` : `
      <div class="sup-closed-note"><i data-icon="checkCircle" data-icon-size="14"></i> ${T("sup.closed_note", "Conversation fermée — ouvre un nouveau ticket si besoin.")}</div>`}
    </div>`;

  const back = document.getElementById("sup-back");
  back?.addEventListener("click", () => {
    state.activeId = null;
    state.thread = null;
    renderThread();
    renderList();
    document.getElementById("sup-thread-wrap")?.classList.remove("active");
  });

  const send = document.getElementById("sup-reply-send");
  const input = document.getElementById("sup-reply-input");
  send?.addEventListener("click", () => {
    const msg = input.value.trim();
    if (msg.length < 2) { toast(T("sup.err_reply_empty", "Écris une réponse avant d'envoyer"), "warning"); return; }
    input.value = "";
    replyTicket(t.id, msg);
  });

  const doClose = () => closeTicket(t.id);
  document.getElementById("sup-close")?.addEventListener("click", doClose);
  document.getElementById("sup-close-admin")?.addEventListener("click", doClose);

  // Scroll en bas du fil
  const msgs = document.getElementById("sup-msgs");
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  renderList(); // rafraîchit l'état actif de la liste
}

function renderForm() {
  const btn = document.getElementById("sup-send");
  if (!btn) return;
  btn.disabled = state.sending;
  btn.innerHTML = state.sending
    ? `<span class="sup-btn-spinner" aria-hidden="true"></span> ${T("sup.sending", "Envoi…")}`
    : `<i data-icon="mail" data-icon-size="14"></i> ${T("sup.send", "Envoyer")}`;
}

/* ═══ Boot ═══ */

function boot() {
  const v = view();
  if (!v) {
    console.warn("[support] #support-view introuvable");
    return;
  }
  // Délégation : les boutons « Ouvrir le chat » survivent aux re-rendus de render()
  v.addEventListener("click", (e) => {
    if (e.target.closest(".sup-chat-open")) openLiveChat();
  });
  render();
  initAccount();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
