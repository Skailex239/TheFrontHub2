// i18n-dict-support.js — Traductions de la page support.html (FR / EN)
// Chargé AVANT i18n.min.js ; fusionné par i18n.js via window.__TFH_I18N_PARTIALS__.
// Convention : une clé par chaîne traduisible ; {param} pour les variables.
// Contient AUSSI les clés des widgets globaux (chargés sur toutes les pages) :
//   cw.*     → chat-widget.js (chat flottant)
//   banner.* → update-banner.js (bandeau d'annonce)
//   tut.*    → tutorial.js (tutoriel d'onboarding)
window.__TFH_I18N_PARTIALS__ = window.__TFH_I18N_PARTIALS__ || {};
window.__TFH_I18N_PARTIALS__.fr = Object.assign(window.__TFH_I18N_PARTIALS__.fr || {}, {

  /* ── Éléments partagés (sidebar / footer communs aux pages) ── */
  "sup.skip_link": "Aller au contenu principal",
  "sup.logo_aria": "Aller au tableau de bord",
  "sup.nav_aria": "Navigation principale",
  "theme.title": "Changer de thème",
  "theme.aria": "Basculer thème clair/sombre",
  "auth.login": "Connexion",
  "footer.not_affiliated": "TheFrontHub. Non affilié à OpenFront.io.",
  "footer.made_with_pre": "Fait avec",
  "footer.made_with_suf": "par la communauté",

  /* ── Topbar / états de chargement ── */
  "sup.topbar_title": "Support",
  "sup.topbar_subtitle": "Contacte l'équipe — réponses ici et par email",
  "sup.loading": "Chargement du support…",
  "sup.loading_short": "Chargement…",

  /* ── Catégories de ticket ── */
  "sup.cat_question": "Question",
  "sup.cat_bug": "Bug / Problème",
  "sup.cat_signalement": "Signalement",
  "sup.cat_idee": "Idée / Suggestion",
  "sup.cat_autre": "Autre",

  /* ── Statuts de ticket ── */
  "sup.status_open": "Ouvert",
  "sup.status_answered": "Répondu",
  "sup.status_closed": "Fermé",

  /* ── Écran d'accueil (non connecté) ── */
  "sup.gate_title": "Besoin d'aide ? Contacte l'équipe",
  "sup.gate_text": "Connecte-toi avec Discord pour ouvrir un ticket de support, suivre tes conversations et recevoir les réponses de l'équipe ici et par email.",
  "sup.gate_login": "Connexion avec Discord",

  /* ── Canaux de contact ── */
  "sup.canals_aria": "Canaux de contact",
  "sup.canal_discord_title": "Rejoindre le Discord TheFrontHub",
  "sup.canal_discord_desc": "La communauté et l'équipe en direct : entraide, annonces et tournois.",
  "sup.canal_discord_cta": "Rejoindre le Discord",
  "sup.canal_discord_aria": "Rejoindre le Discord TheFrontHub (nouvel onglet)",
  "sup.canal_email_title": "Email support@thefronthub.com",
  "sup.canal_email_desc": "Pour toute demande officielle — réponse sous 48 h.",
  "sup.canal_email_cta": "Écrire un email",
  "sup.canal_email_aria": "Envoyer un email à support@thefronthub.com",
  "sup.canal_chat_title": "Chat en direct",
  "sup.canal_chat_desc": "Discute en direct avec l'équipe.",
  "sup.canal_chat_cta": "Ouvrir le chat",
  "sup.canal_chat_aria": "Ouvrir le chat en direct avec l'équipe",

  /* ── FAQ ── */
  "sup.faq_title": "Questions fréquentes",
  "sup.faq1_q": "Comment se connecter à TheFrontHub ?",
  "sup.faq1_a": "Un seul clic : clique sur « Connexion » puis « Continuer avec Discord ». Aucun mot de passe, aucun email — ta session Discord fait tout.",
  "sup.faq2_q": "Comment sont calculés les points classés ?",
  "sup.faq2_a": "Les points se gagnent sur tes victoires en classé 1v1 et 2v2, selon ta place finale dans la partie. Plus tu finis haut, plus tu gagnes.",
  "sup.faq3_q": "À quelle fréquence les classements sont-ils mis à jour ?",
  "sup.faq3_a": "Automatiquement et régulièrement, à partir des données officielles d'OpenFront.io. Si ton rang ne bouge pas, c'est que ta dernière partie n'a pas encore été synchronisée.",
  "sup.faq4_q": "Comment participer aux tournois ?",
  "sup.faq4_a": "Rends-toi sur la <a href=\"tournois.html\">page Tournois</a> : les inscriptions sont ouvertes jusqu'à la date de lancement indiquée. Les annonces passent aussi sur le <a href=\"https://discord.gg/AZhmqRvbNh\" target=\"_blank\" rel=\"noreferrer\" aria-label=\"Discord TheFrontHub (nouvel onglet)\">Discord</a>.",
  "sup.faq5_q": "Comment signaler un bug ou un joueur ?",
  "sup.faq5_a": "Ouvre un ticket avec le formulaire ci-dessous, catégorie « Bug / Problème » ou « Signalement ». Décris précisément (pseudos, dates, ce qui s'est passé) — l'équipe te répond ici et par email.",
  "sup.faq6_q": "Comment proposer une idée ?",
  "sup.faq6_a": "Ouvre un ticket catégorie « Idée / Suggestion », ou viens en discuter sur le <a href=\"https://discord.gg/AZhmqRvbNh\" target=\"_blank\" rel=\"noreferrer\" aria-label=\"Discord TheFrontHub (nouvel onglet)\">Discord</a>. Les idées de la communauté façonnent les prochaines mises à jour.",
  "sup.faq7_q": "Comment supprimer mon compte ou mes données ?",
  "sup.faq7_a": "Envoie ta demande par email à <a href=\"mailto:support@thefronthub.com\">support@thefronthub.com</a> : ton compte et tes données personnelles seront supprimés.",
  "sup.faq8_q": "Le site est-il officiel d'OpenFront.io ?",
  "sup.faq8_a": "Non — TheFrontHub est un projet communautaire réalisé par des fans, sans aucune affiliation avec OpenFront.io.",

  /* ── Formulaire « Contacter l'équipe » ── */
  "sup.form_title": "Contacter l'équipe",
  "sup.form_sub": "Une question, un bug, une idée ? Écris-nous — on te répond ici et par email.",
  "sup.label_category": "Catégorie",
  "sup.label_subject": "Sujet",
  "sup.placeholder_subject": "Ex. : récompense tournoi non reçue",
  "sup.label_message": "Message",
  "sup.placeholder_message": "Décris ta demande le plus précisément possible (pseudos, dates, screenshots via le Discord…)…",
  "sup.hint_session": "Session :",
  "sup.send": "Envoyer",
  "sup.sending": "Envoi…",

  /* ── Liste des conversations ── */
  "sup.list_all": "Toutes les conversations",
  "sup.list_mine": "Mes conversations",
  "sup.scope_aria": "Portée de la liste",
  "sup.scope_mine": "Mes tickets",
  "sup.scope_team": "Équipe",
  "sup.empty_all": "Aucun ticket pour le moment.",
  "sup.empty_all_sub": "Les demandes des joueurs apparaîtront ici.",
  "sup.empty_mine": "Aucune conversation pour l'instant.",
  "sup.empty_mine_sub": "Écris à l'équipe avec le formulaire ci-dessus — les réponses arrivent ici et par email.",

  /* ── Fil de discussion ── */
  "sup.thread_empty": "Sélectionne une conversation",
  "sup.thread_empty_sub": "ou écris-nous avec le formulaire.",
  "sup.thread_loading": "Chargement de la conversation…",
  "sup.back": "Retour",
  "sup.back_aria": "Retour à la liste",
  "sup.thread_dates": "ouvert {created} · dernière activité {updated}",
  "sup.msg_team": "🛠️ L'équipe TheFrontHub",
  "sup.msg_you": "Toi",
  "sup.reply_placeholder": "Écrire une réponse…",
  "sup.reply_placeholder_closed": "Ticket fermé — réponse d'équipe possible",
  "sup.mark_resolved": "Marquer résolu",
  "sup.close_ticket": "Fermer le ticket",
  "sup.reply": "Répondre",
  "sup.closed_note": "Conversation fermée — ouvre un nouveau ticket si besoin.",

  /* ── Toasts / erreurs ── */
  "sup.chat_soon": "Chat en direct bientôt disponible — écris-nous via le formulaire ou sur le Discord en attendant.",
  "sup.err_load": "Impossible de charger tes conversations, réessaie",
  "sup.err_thread": "Impossible d'ouvrir cette conversation",
  "sup.err_send": "Envoi impossible — vérifie ton message et réessaie",
  "sup.ok_sent": "Message envoyé à l'équipe ✅ Tu recevras une réponse ici (et par email si renseigné).",
  "sup.err_network": "Erreur réseau — réessaie",
  "sup.err_reply": "Envoi impossible, réessaie",
  "sup.ok_reply": "Réponse envoyée",
  "sup.ok_closed": "Conversation fermée",
  "sup.err_close": "Impossible de fermer la conversation",
  "sup.err_subject": "Le sujet doit contenir au moins 4 caractères",
  "sup.err_message": "Le message doit contenir au moins 10 caractères",
  "sup.err_reply_empty": "Écris une réponse avant d'envoyer",

  /* ── chat-widget.js (widget global) ── */
});
window.__TFH_I18N_PARTIALS__.en = Object.assign(window.__TFH_I18N_PARTIALS__.en || {}, {

  /* ── Shared elements (sidebar / footer) ── */
  "sup.skip_link": "Skip to main content",
  "sup.logo_aria": "Go to the dashboard",
  "sup.nav_aria": "Main navigation",
  "theme.title": "Switch theme",
  "theme.aria": "Toggle light/dark theme",
  "auth.login": "Sign in",
  "footer.not_affiliated": "TheFrontHub. Not affiliated with OpenFront.io.",
  "footer.made_with_pre": "Made with",
  "footer.made_with_suf": "by the community",

  /* ── Topbar / loading states ── */
  "sup.topbar_title": "Support",
  "sup.topbar_subtitle": "Contact the team — answers here and by email",
  "sup.loading": "Loading support…",
  "sup.loading_short": "Loading…",

  /* ── Ticket categories ── */
  "sup.cat_question": "Question",
  "sup.cat_bug": "Bug / Issue",
  "sup.cat_signalement": "Report",
  "sup.cat_idee": "Idea / Suggestion",
  "sup.cat_autre": "Other",

  /* ── Ticket statuses ── */
  "sup.status_open": "Open",
  "sup.status_answered": "Answered",
  "sup.status_closed": "Closed",

  /* ── Signed-out gate ── */
  "sup.gate_title": "Need help? Contact the team",
  "sup.gate_text": "Sign in with Discord to open a support ticket, follow your conversations and receive the team's replies here and by email.",
  "sup.gate_login": "Sign in with Discord",

  /* ── Contact channels ── */
  "sup.canals_aria": "Contact channels",
  "sup.canal_discord_title": "Join the TheFrontHub Discord",
  "sup.canal_discord_desc": "Community and team live: mutual aid, announcements and tournaments.",
  "sup.canal_discord_cta": "Join the Discord",
  "sup.canal_discord_aria": "Join the TheFrontHub Discord (new tab)",
  "sup.canal_email_title": "Email support@thefronthub.com",
  "sup.canal_email_desc": "For any official request — reply within 48 h.",
  "sup.canal_email_cta": "Write an email",
  "sup.canal_email_aria": "Send an email to support@thefronthub.com",
  "sup.canal_chat_title": "Live chat",
  "sup.canal_chat_desc": "Chat with the team in real time.",
  "sup.canal_chat_cta": "Open chat",
  "sup.canal_chat_aria": "Open the live chat with the team",

  /* ── FAQ ── */
  "sup.faq_title": "Frequently asked questions",
  "sup.faq1_q": "How do I sign in to TheFrontHub?",
  "sup.faq1_a": "One click: click \"Sign in\" then \"Continue with Discord\". No password, no email — your Discord session does everything.",
  "sup.faq2_q": "How are ranked points calculated?",
  "sup.faq2_a": "Points are earned from your wins in 1v1 and 2v2 ranked, based on your final placement in the game. The higher you finish, the more you earn.",
  "sup.faq3_q": "How often are the leaderboards updated?",
  "sup.faq3_a": "Automatically and regularly, from official OpenFront.io data. If your rank doesn't move, it means your latest game hasn't been synced yet.",
  "sup.faq4_q": "How do I take part in tournaments?",
  "sup.faq4_a": "Head over to the <a href=\"tournois.html\">Tournaments page</a>: registrations are open until the announced launch date. Announcements are also posted on the <a href=\"https://discord.gg/AZhmqRvbNh\" target=\"_blank\" rel=\"noreferrer\" aria-label=\"TheFrontHub Discord (new tab)\">Discord</a>.",
  "sup.faq5_q": "How do I report a bug or a player?",
  "sup.faq5_a": "Open a ticket with the form below, category \"Bug / Issue\" or \"Report\". Describe it precisely (usernames, dates, what happened) — the team will reply here and by email.",
  "sup.faq6_q": "How do I suggest an idea?",
  "sup.faq6_a": "Open a ticket with category \"Idea / Suggestion\", or come discuss it on the <a href=\"https://discord.gg/AZhmqRvbNh\" target=\"_blank\" rel=\"noreferrer\" aria-label=\"TheFrontHub Discord (new tab)\">Discord</a>. Community ideas shape the upcoming updates.",
  "sup.faq7_q": "How do I delete my account or my data?",
  "sup.faq7_a": "Send your request by email to <a href=\"mailto:support@thefronthub.com\">support@thefronthub.com</a>: your account and personal data will be deleted.",
  "sup.faq8_q": "Is the site official OpenFront.io?",
  "sup.faq8_a": "No — TheFrontHub is a community project made by fans, with no affiliation with OpenFront.io.",

  /* ── "Contact the team" form ── */
  "sup.form_title": "Contact the team",
  "sup.form_sub": "A question, a bug, an idea? Write to us — we answer here and by email.",
  "sup.label_category": "Category",
  "sup.label_subject": "Subject",
  "sup.placeholder_subject": "E.g.: tournament reward not received",
  "sup.label_message": "Message",
  "sup.placeholder_message": "Describe your request as precisely as possible (usernames, dates, screenshots via Discord…)…",
  "sup.hint_session": "Signed in as:",
  "sup.send": "Send",
  "sup.sending": "Sending…",

  /* ── Conversation list ── */
  "sup.list_all": "All conversations",
  "sup.list_mine": "My conversations",
  "sup.scope_aria": "List scope",
  "sup.scope_mine": "My tickets",
  "sup.scope_team": "Team",
  "sup.empty_all": "No tickets yet.",
  "sup.empty_all_sub": "Player requests will appear here.",
  "sup.empty_mine": "No conversations yet.",
  "sup.empty_mine_sub": "Write to the team with the form above — answers arrive here and by email.",

  /* ── Thread ── */
  "sup.thread_empty": "Select a conversation",
  "sup.thread_empty_sub": "or write to us with the form.",
  "sup.thread_loading": "Loading conversation…",
  "sup.back": "Back",
  "sup.back_aria": "Back to the list",
  "sup.thread_dates": "opened {created} · last activity {updated}",
  "sup.msg_team": "🛠️ The TheFrontHub team",
  "sup.msg_you": "You",
  "sup.reply_placeholder": "Write a reply…",
  "sup.reply_placeholder_closed": "Ticket closed — team replies still possible",
  "sup.mark_resolved": "Mark as resolved",
  "sup.close_ticket": "Close ticket",
  "sup.reply": "Reply",
  "sup.closed_note": "Conversation closed — open a new ticket if needed.",

  /* ── Toasts / errors ── */
  "sup.chat_soon": "Live chat coming soon — write to us via the form or on Discord in the meantime.",
  "sup.err_load": "Could not load your conversations, please try again",
  "sup.err_thread": "Could not open this conversation",
  "sup.err_send": "Could not send — check your message and try again",
  "sup.ok_sent": "Message sent to the team ✅ You'll get a reply here (and by email if set).",
  "sup.err_network": "Network error — please try again",
  "sup.err_reply": "Could not send, please try again",
  "sup.ok_reply": "Reply sent",
  "sup.ok_closed": "Conversation closed",
  "sup.err_close": "Could not close the conversation",
  "sup.err_subject": "The subject must be at least 4 characters",
  "sup.err_message": "The message must be at least 10 characters",
  "sup.err_reply_empty": "Write a reply before sending",

  /* ── chat-widget.js (global widget) ── */
});
