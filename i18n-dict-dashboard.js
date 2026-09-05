// i18n-dict-dashboard.js — Traductions de la page dashboard.html (FR / EN)
// Chargé AVANT i18n.min.js ; fusionné par i18n.js via window.__TFH_I18N_PARTIALS__.
// Convention : une clé par chaîne traduisible ; {param} pour les variables.
// Zones : chrome de page (skip-link, sidebar, topbar, footer, modales),
// rendu dashboard.js (intro, barème, toolbar, panneaux, lignes, toasts),
// éléments communs réutilisés (nav.*, footer.*, auth.*, modal.close → i18n.js).
window.__TFH_I18N_PARTIALS__ = window.__TFH_I18N_PARTIALS__ || {};
window.__TFH_I18N_PARTIALS__.fr = Object.assign(window.__TFH_I18N_PARTIALS__.fr || {}, {
  // ── Chrome de page (dashboard.html) ─────────────────────────────────
  "dash.skip": "Aller au contenu principal",
  "dash.logo_aria": "Aller au tableau de bord",
  "dash.nav_aria": "Navigation principale",
  "dash.theme_title": "Changer de thème",
  "dash.theme_aria": "Basculer thème clair/sombre",
  "dash.login": "Connexion",
  "dash.subtitle": "Classement par points — FFA, Team, classé et casual",
  "dash.loading_ranking": "Chargement du classement…",
  "dash.footer_line": "TheFrontHub · Classement par points OpenFront",
  "dash.rights_rest": "TheFrontHub. Non affilié à OpenFront.io.",
  "dash.made_with_a": "Fait avec",
  "dash.made_with_b": "par la communauté",

  // ── Modale profil (setup OpenFront, dashboard.html) ─────────────────
  "dash.setup_title": "Finaliser votre profil",
  "dash.setup_subtitle": "Liez votre compte OpenFront pour fusionner vos stats.",
  "dash.setup_username_label": "Nom d'utilisateur OpenFront",
  "dash.setup_username_ph": "Ex: Skailex",
  "dash.setup_pid_label": "Public ID OpenFront (8 caractères)",
  "dash.setup_pid_ph": "Ex: HabCsQYR",
  "dash.setup_verify_btn": "Vérifier mon compte",
  "dash.setup_code_label": "Code de vérification :",
  "dash.setup_proof": "Pour prouver que vous êtes bien ce joueur :",
  "dash.setup_step1": "Modifiez votre pseudo OpenFront dans les paramètres du jeu",
  "dash.setup_step2": "Ajoutez le code ci-dessus à votre pseudo (ex: <strong id=\"ownership-example\"></strong>)",
  "dash.setup_step3": "Jouez au moins une partie (ou utilisez un pseudo déjà utilisé récemment)",
  "dash.setup_step4": "Cliquez sur \"Confirmer\" ci-dessous",
  "dash.btn_confirm": "Confirmer",
  "dash.btn_back": "Retour",

  // ── Rendu dashboard.js : états + intro + barème ─────────────────────
  "dash.loading_title": "Chargement…",
  "dash.loading_sub": "Récupération du classement…",
  "dash.no_data_title": "Aucune donnée disponible",
  "dash.error_title": "Erreur",
  "dash.error_generic": "Chargement impossible.",
  "dash.updated_on": "Mis à jour le",
  "dash.intro_sub": "TheFrontHub synchronise automatiquement votre historique de parties et vos statistiques OpenFront, visualise vos conquêtes et classe vos performances à l'échelle mondiale.",
  "dash.help_aria": "Voir le barème des points",
  "dash.help_title": "Barème des points",
  "dash.help_ranked_1v1": "classé (1v1)",
  "dash.help_ranked_2v2": "classé (2v2)",
  "dash.help_note": "Le classé rapporte juste 1 pt, pas en plus du casual.",

  // ── Toolbar (recherche + filtres) ───────────────────────────────────
  "dash.search_placeholder": "Rechercher un joueur…",
  "dash.search_aria": "Rechercher un joueur dans le classement",
  "dash.search_clear": "Effacer la recherche",
  "dash.filters_aria": "Filtrer par mode de jeu",
  "dash.filter_all": "Tous",

  // ── Panneaux + sous-titres ──────────────────────────────────────────
  "dash.panel_global": "Top joueurs — Toutes saisons",
  "dash.panel_weekly": "Top joueurs — Cette semaine",
  "dash.sub_global": "Classement cumulé · {n} joueurs",
  "dash.sub_weekly": "Depuis le {date} · {n} joueurs actifs",

  // ── Lignes du classement ────────────────────────────────────────────
  "dash.pu_tip": "Récompense en preview : {n} Plutonium pour le 1er de la semaine. Mise en place officielle dans peu de temps.",
  "dash.me_chip": "TOI",
  "dash.me_chip_title": "Votre position dans le classement",
  "dash.ingame": "En jeu : {n}",
  "dash.me_pinned_aria": "Votre position : {rank} avec {pts} points",
  "dash.search_none": "Aucun joueur ne correspond à « {q} ».",
  "dash.empty_list": "Aucun joueur classé pour le moment.",
  "dash.results_for": "{n} résultat{s} pour « {q} »",
  "dash.results_truncated": "· 20 premiers affichés",

  // ── Tendance hebdo (flèches ↑/↓) ────────────────────────────────────
  "dash.trend_new_title": "N'était pas classé la semaine dernière",
  "dash.trend_new_aria": "Nouveau dans le classement de la semaine",
  "dash.trend_same_title": "{rank} la semaine dernière — position inchangée",
  "dash.trend_same_aria": "Position inchangée",
  "dash.trend_up_title": "↑ {n} place{s} vs semaine dernière ({rank})",
  "dash.trend_up_aria": "Monté de {n} place{s}",
  "dash.trend_down_title": "↓ {n} place{s} vs semaine dernière ({rank})",
  "dash.trend_down_aria": "Descendu de {n} place{s}",

  // ── Auth UI + toasts (dashboard.js) ─────────────────────────────────
  "dash.default_player": "Joueur",
  "dash.toast_welcome_setup": "Bienvenue ! Finalisez votre profil pour accéder à vos stats.",
  "dash.redirecting_discord": "Redirection vers Discord…",
  "dash.toast_login_first": "Veuillez vous connecter d'abord.",
  "dash.toast_fill_all": "Veuillez remplir tous les champs.",
  "dash.toast_username_len": "Le pseudo doit faire entre 2 et 30 caractères.",
  "dash.toast_pid_len": "Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).",
  "dash.toast_username_chars": "Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.",
  "dash.toast_verifying": "Vérification du Public ID…",
  "dash.toast_pid_not_found": "Public ID introuvable sur OpenFront. Vérifiez votre saisie.",
  "dash.toast_pid_api_error": "Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.",
  "dash.toast_code_generated": "Code généré. Suivez les instructions ci-dessous.",
  "dash.btn_verifying": "Vérification…",
  "dash.toast_code_not_found": "Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.",
  "dash.toast_verify_error": "Erreur lors de la vérification. Réessayez.",
  "dash.toast_profile_saved": "Profil vérifié et enregistré avec succès ! Redirection…",
  "dash.toast_save_error": "Erreur lors de la sauvegarde du profil."
});
window.__TFH_I18N_PARTIALS__.en = Object.assign(window.__TFH_I18N_PARTIALS__.en || {}, {
  // ── Page chrome (dashboard.html) ────────────────────────────────────
  "dash.skip": "Skip to main content",
  "dash.logo_aria": "Go to the dashboard",
  "dash.nav_aria": "Main navigation",
  "dash.theme_title": "Switch theme",
  "dash.theme_aria": "Toggle light/dark theme",
  "dash.login": "Log in",
  "dash.subtitle": "Points ranking — FFA, Team, ranked and casual",
  "dash.loading_ranking": "Loading the leaderboard…",
  "dash.footer_line": "TheFrontHub · OpenFront points ranking",
  "dash.rights_rest": "TheFrontHub. Not affiliated with OpenFront.io.",
  "dash.made_with_a": "Made with",
  "dash.made_with_b": "by the community",

  // ── Profile modal (OpenFront setup, dashboard.html) ─────────────────
  "dash.setup_title": "Complete your profile",
  "dash.setup_subtitle": "Link your OpenFront account to merge your stats.",
  "dash.setup_username_label": "OpenFront username",
  "dash.setup_username_ph": "e.g. Skailex",
  "dash.setup_pid_label": "OpenFront Public ID (8 characters)",
  "dash.setup_pid_ph": "e.g. HabCsQYR",
  "dash.setup_verify_btn": "Verify my account",
  "dash.setup_code_label": "Verification code:",
  "dash.setup_proof": "To prove you are this player:",
  "dash.setup_step1": "Change your OpenFront username in the game settings",
  "dash.setup_step2": "Add the code above to your username (e.g. <strong id=\"ownership-example\"></strong>)",
  "dash.setup_step3": "Play at least one game (or use a username you played with recently)",
  "dash.setup_step4": "Click \"Confirm\" below",
  "dash.btn_confirm": "Confirm",
  "dash.btn_back": "Back",

  // ── dashboard.js rendering: states + intro + points system ──────────
  "dash.loading_title": "Loading…",
  "dash.loading_sub": "Fetching the leaderboard…",
  "dash.no_data_title": "No data available",
  "dash.error_title": "Error",
  "dash.error_generic": "Unable to load data.",
  "dash.updated_on": "Updated on",
  "dash.intro_sub": "TheFrontHub automatically syncs your game history and OpenFront stats, lets you visualise your conquests and ranks your performances worldwide.",
  "dash.help_aria": "View the points system",
  "dash.help_title": "Points system",
  "dash.help_ranked_1v1": "Ranked (1v1)",
  "dash.help_ranked_2v2": "Ranked (2v2)",
  "dash.help_note": "Ranked only grants 1 pt — it is not added on top of casual.",

  // ── Toolbar (search + filters) ──────────────────────────────────────
  "dash.search_placeholder": "Search for a player…",
  "dash.search_aria": "Search for a player in the leaderboard",
  "dash.search_clear": "Clear search",
  "dash.filters_aria": "Filter by game mode",
  "dash.filter_all": "All",

  // ── Panels + subtitles ──────────────────────────────────────────────
  "dash.panel_global": "Top players — All time",
  "dash.panel_weekly": "Top players — This week",
  "dash.sub_global": "All-time ranking · {n} players",
  "dash.sub_weekly": "Since {date} · {n} active players",

  // ── Leaderboard rows ────────────────────────────────────────────────
  "dash.pu_tip": "Preview reward: {n} Plutonium for the weekly #1. Official rollout coming soon.",
  "dash.me_chip": "YOU",
  "dash.me_chip_title": "Your position in the leaderboard",
  "dash.ingame": "In game as {n}",
  "dash.me_pinned_aria": "Your position: {rank} with {pts} points",
  "dash.search_none": "No player matches “{q}”.",
  "dash.empty_list": "No players ranked yet.",
  "dash.results_for": "{n} result{s} for “{q}”",
  "dash.results_truncated": "· showing first 20",

  // ── Weekly trend (↑/↓ arrows) ───────────────────────────────────────
  "dash.trend_new_title": "Was not ranked last week",
  "dash.trend_new_aria": "New in this week's ranking",
  "dash.trend_same_title": "{rank} last week — position unchanged",
  "dash.trend_same_aria": "Position unchanged",
  "dash.trend_up_title": "↑ {n} spot{s} vs last week ({rank})",
  "dash.trend_up_aria": "Climbed {n} spot{s}",
  "dash.trend_down_title": "↓ {n} spot{s} vs last week ({rank})",
  "dash.trend_down_aria": "Dropped {n} spot{s}",

  // ── Auth UI + toasts (dashboard.js) ─────────────────────────────────
  "dash.default_player": "Player",
  "dash.toast_welcome_setup": "Welcome! Finish setting up your profile to access your stats.",
  "dash.redirecting_discord": "Redirecting to Discord…",
  "dash.toast_login_first": "Please sign in first.",
  "dash.toast_fill_all": "Please fill in all fields.",
  "dash.toast_username_len": "The username must be between 2 and 30 characters.",
  "dash.toast_pid_len": "The Public ID must be exactly 8 alphanumeric characters (e.g. HabCsQYR).",
  "dash.toast_username_chars": "The username can only contain letters, numbers, spaces, _ and -.",
  "dash.toast_verifying": "Verifying the Public ID…",
  "dash.toast_pid_not_found": "Public ID not found on OpenFront. Please check your input.",
  "dash.toast_pid_api_error": "Could not verify the Public ID (API unavailable). Please try again later.",
  "dash.toast_code_generated": "Code generated. Follow the instructions below.",
  "dash.btn_verifying": "Verifying…",
  "dash.toast_code_not_found": "Code not found in your recent games. Play a game with the code in your username, then confirm.",
  "dash.toast_verify_error": "Verification failed. Please try again.",
  "dash.toast_profile_saved": "Profile verified and saved successfully! Redirecting…",
  "dash.toast_save_error": "Failed to save your profile."
});
