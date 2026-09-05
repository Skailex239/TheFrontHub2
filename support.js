// support.js — Support & messagerie TheFrontHub (v1)
//
// Nouvelle catégorie « Support » : contacte l'équipe, suis tes conversations,
// reçois les réponses ici (et par email). L'équipe répond depuis cette même
// page (bascule « Vue équipe » visible uniquement par les admins).
//
// Backend : api/support.php (tickets + messages en MySQL, session Discord
// obligatoire). Notifications mail best-effort côté serveur.

const SUP_CATEGORIES = [
  { key: "question",     label: "Question" },
  { key: "bug",          label: "Bug / Problème" },
  { key: "signalement",  label: "Signalement" },
  { key: "idee",         label: "Idée / Suggestion" },
  { key: "autre",        label: "Autre" },
];

const SUP_STATUS = {
  open:     { label: "Ouvert",   cls: "open" },
  answered: { label: "Répondu",  cls: "answered" },
  closed:   { label: "Fermé",    cls: "closed" },
};

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
  // "YYYY-MM-DD HH:MM:SS" (heure serveur) → affichage local
  const d = new Date(String(mysqlDate).replace(" ", "T") + (String(mysqlDate).includes("+") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(mysqlDate);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function toast(msg, type = "info", duration = 4000, icon = undefined) {
  window.showToast?.(msg, type, duration, icon);
}

function categoryLabel(key) {
  return SUP_CATEGORIES.find((c) => c.key === key)?.label || key || "Autre";
}

function statusMeta(status) {
  return SUP_STATUS[status] || SUP_STATUS.open;
}

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
    toast("Impossible de charger tes conversations, réessaie", "error");
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
    toast("Impossible d'ouvrir cette conversation", "error");
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
      toast(data.message || "Envoi impossible — vérifie ton message et réessaie", "error", 5000);
      return;
    }
    toast("Message envoyé à l'équipe ✅ Tu recevras une réponse ici (et par email si renseigné).", "success", 6000, "checkCircle");
    document.getElementById("sup-subject").value = "";
    document.getElementById("sup-message").value = "";
    document.getElementById("sup-category").value = "question";
    await loadTickets();
    if (data.ticket_id) await loadThread(data.ticket_id);
  } catch {
    toast("Erreur réseau — réessaie", "error");
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
      toast(data.message || "Envoi impossible, réessaie", "error", 5000);
      return;
    }
    toast("Réponse envoyée", "success", 3000, "checkCircle");
    await Promise.all([loadThread(id), loadTickets()]);
  } catch {
    toast("Erreur réseau — réessaie", "error");
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
    toast("Conversation fermée", "info", 3000);
    await Promise.all([loadThread(id), loadTickets()]);
  } catch {
    toast("Impossible de fermer la conversation", "error");
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
        <h2>Besoin d'aide ? Contacte l'équipe</h2>
        <p>Connecte-toi avec Discord pour ouvrir un ticket de support,
        suivre tes conversations et recevoir les réponses de l'équipe
        ici et par email.</p>
        <button type="button" class="sup-btn sup-btn-primary" onclick="toggleAuthModal()">Connexion avec Discord</button>
      </div>`;
    return;
  }
  v.innerHTML = `
    <div class="sup-grid">
      <div class="sup-left">
        <section class="sup-card sup-new" aria-labelledby="sup-new-title">
          <h2 id="sup-new-title" class="sup-title"><i data-icon="mail" data-icon-size="16"></i> Contacter l'équipe</h2>
          <p class="sup-new-sub">Une question, un bug, une idée ? Écris-nous — on te répond ici et par email.</p>
          <form id="sup-form" novalidate>
            <label class="sup-label" for="sup-category">Catégorie</label>
            <select id="sup-category" class="sup-input" required>
              ${SUP_CATEGORIES.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join("")}
            </select>
            <label class="sup-label" for="sup-subject">Sujet</label>
            <input id="sup-subject" class="sup-input" type="text" maxlength="140" minlength="4"
                   placeholder="Ex. : récompense tournoi non reçue" required autocomplete="off">
            <label class="sup-label" for="sup-message">Message</label>
            <textarea id="sup-message" class="sup-input" rows="6" maxlength="5000" minlength="10"
                      placeholder="Décris ta demande le plus précisément possible (pseudos, dates, screenshots via le Discord…)…" required></textarea>
            <div class="sup-form-foot">
              <span class="sup-hint">Session : <strong>${esc(state.user.displayName || state.user.globalName || state.user.username || "—")}</strong></span>
              <button type="submit" class="sup-btn sup-btn-primary" id="sup-send">
                <i data-icon="mail" data-icon-size="14"></i> Envoyer
              </button>
            </div>
          </form>
        </section>

        <section class="sup-card" aria-labelledby="sup-list-title">
          <div class="sup-list-head">
            <h2 id="sup-list-title" class="sup-title"><i data-icon="ladder" data-icon-size="16"></i> ${state.scope === "all" ? "Toutes les conversations" : "Mes conversations"}</h2>
            ${state.isAdmin ? `
            <div class="sup-scope-toggle" role="group" aria-label="Portée de la liste">
              <button type="button" class="sup-scope-btn ${state.scope === "mine" ? "on" : ""}" data-scope="mine">Mes tickets</button>
              <button type="button" class="sup-scope-btn ${state.scope === "all" ? "on" : ""}" data-scope="all">Équipe</button>
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
    if (subject.length < 4) { toast("Le sujet doit contenir au moins 4 caractères", "warning"); return; }
    if (message.length < 10) { toast("Le message doit contenir au moins 10 caractères", "warning"); return; }
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
    list.innerHTML = `<div class="sup-loading"><div class="spinner"></div><p>Chargement…</p></div>`;
    return;
  }
  if (state.tickets.length === 0) {
    list.innerHTML = `
      <div class="sup-empty">
        <div class="sup-empty-icon"><i data-icon="mail" data-icon-size="26"></i></div>
        <p>${state.scope === "all" ? "Aucun ticket pour le moment." : "Aucune conversation pour l'instant."}<br>
        <span class="sup-empty-sub">${state.scope === "all" ? "Les demandes des joueurs apparaîtront ici." : "Écris à l'équipe avec le formulaire ci-dessus — les réponses arrivent ici et par email."}</span></p>
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
          <span class="sup-ticket-status sup-st-${st.cls}">${st.label}</span>
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
        <p>Sélectionne une conversation<br><span class="sup-empty-sub">ou écris-nous avec le formulaire.</span></p>
      </div>`;
    return;
  }

  if (!state.thread) {
    el.innerHTML = `<div class="sup-loading"><div class="spinner"></div><p>Chargement de la conversation…</p></div>`;
    return;
  }

  const t = state.thread.ticket;
  const st = statusMeta(t.status);
  const canReply = t.status !== "closed" || state.isAdmin;

  el.innerHTML = `
    <div class="sup-thread-head">
      <button type="button" class="sup-back" id="sup-back" aria-label="Retour à la liste">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        <span>Retour</span>
      </button>
      <div class="sup-thread-meta">
        <span class="sup-ticket-cat sup-cat-${esc(t.category)}">${esc(categoryLabel(t.category))}</span>
        <span class="sup-ticket-status sup-st-${st.cls}">${st.label}</span>
        ${state.isAdmin && !t.mine ? `<span class="sup-ticket-user">${esc(state.tickets.find((x) => x.id === t.id)?.user_name || "")}</span>` : ""}
      </div>
      <h3 class="sup-thread-subject">${esc(t.subject)}</h3>
      <span class="sup-thread-date">ouvert ${esc(fmtDate(t.created_at))} · dernière activité ${esc(fmtDate(t.updated_at))}</span>
    </div>

    <div class="sup-msgs" id="sup-msgs">
      ${state.thread.messages.map((m) => {
        const isTeam = m.author_role === "team";
        return `
        <div class="sup-msg ${isTeam ? "sup-msg-team" : "sup-msg-user"}">
          <div class="sup-msg-head">
            <span class="sup-msg-author">${isTeam ? "🛠️ L'équipe TheFrontHub" : esc(m.author_name || "Toi")}</span>
            <span class="sup-msg-date">${esc(fmtDate(m.created_at))}</span>
          </div>
          <div class="sup-msg-body">${esc(m.body).replace(/\n/g, "<br>")}</div>
        </div>`;
      }).join("")}
    </div>

    <div class="sup-reply">
      ${canReply ? `
      <textarea id="sup-reply-input" class="sup-input" rows="3" maxlength="5000"
                placeholder="${t.status === "closed" ? "Ticket fermé — réponse d'équipe possible" : "Écrire une réponse…"}"></textarea>
      <div class="sup-reply-foot">
        ${t.mine && t.status !== "closed" ? `<button type="button" class="sup-btn sup-btn-ghost" id="sup-close">Marquer résolu</button>` : ""}
        ${state.isAdmin && t.status !== "closed" ? `<button type="button" class="sup-btn sup-btn-ghost" id="sup-close-admin">Fermer le ticket</button>` : ""}
        <button type="button" class="sup-btn sup-btn-primary" id="sup-reply-send">
          <i data-icon="mail" data-icon-size="14"></i> Répondre
        </button>
      </div>` : `
      <div class="sup-closed-note"><i data-icon="checkCircle" data-icon-size="14"></i> Conversation fermée — ouvre un nouveau ticket si besoin.</div>`}
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
    if (msg.length < 2) { toast("Écris une réponse avant d'envoyer", "warning"); return; }
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
    ? `<span class="sup-btn-spinner" aria-hidden="true"></span> Envoi…`
    : `<i data-icon="mail" data-icon-size="14"></i> Envoyer`;
}

/* ═══ Boot ═══ */

function boot() {
  if (!view()) {
    console.warn("[support] #support-view introuvable");
    return;
  }
  render();
  initAccount();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
