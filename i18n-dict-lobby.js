// i18n-dict-lobby.js — Traductions de la page lobby.html (FR / EN)
// Chargé AVANT i18n.min.js ; fusionné par i18n.js via window.__TFH_I18N_PARTIALS__.
// Convention : une clé par chaîne traduisible ; {param} pour les variables.
window.__TFH_I18N_PARTIALS__ = window.__TFH_I18N_PARTIALS__ || {};
window.__TFH_I18N_PARTIALS__.fr = Object.assign(window.__TFH_I18N_PARTIALS__.fr || {}, {
  // ── Page / topbar ──────────────────────────────────────────────────
  "lobby.title": "Lobby",
  "lobby.subtitle": "Parties OpenFront en direct — cliquez sur une carte pour rejoindre",
  "lobby.skip_link": "Aller au contenu principal",
  "lobby.logo_aria": "Aller au tableau de bord",
  "lobby.nav_aria": "Navigation principale",
  "lobby.theme_title": "Changer de thème",
  "lobby.theme_aria": "Basculer thème clair/sombre",
  "lobby.login": "Connexion",

  // ── Footer lobby + footer commun (compléments locaux) ─────────────
  "lobby.footer_not_affiliated": "TheFrontHub. Non affilié à OpenFront.io.",
  "lobby.made_with_prefix": "Fait avec",
  "lobby.made_with_suffix": "par la communauté",
  "lobby.credit_inspired": "Lobby inspiré du projet",
  "lobby.credit_link_title": "OpenFront Lobbies — par minhkarl",
  "lobby.credit_gh_title": "GitHub de minhkarl",

  // ── Barre de filtres ───────────────────────────────────────────────
  "lobby.filter_aria": "Filtrer les parties",
  "lobby.filter_show": "Afficher",
  "lobby.filter_all": "Toutes",
  "lobby.filter_ffa": "FFA",
  "lobby.filter_team": "Team",
  "lobby.filter_special": "Spécial",
  "lobby.filter_fav": "Favoris",

  // ── Sections / carrousels ─────────────────────────────────────────
  "lobby.sec_ffa": "Free For All",
  "lobby.sec_team": "Team",
  "lobby.sec_special": "Spécial",
  "lobby.track_aria": "Parties {mode}",
  "lobby.track_empty": "Aucune partie {mode} en attente",
  "lobby.scroll_left": "Défiler vers la gauche",
  "lobby.scroll_right": "Défiler vers la droite",

  // ── Cartes ────────────────────────────────────────────────────────
  "lobby.almost_full": "Presque pleine",
  "lobby.join": "Rejoindre",
  "lobby.fav_add_title": "Ajouter aux cartes favorites",
  "lobby.fav_add_aria": "Ajouter la carte aux favoris",
  "lobby.fav_remove_title": "Retirer des cartes favorites",
  "lobby.fav_remove_aria": "Retirer la carte des favoris",

  // ── Comptes à rebours ─────────────────────────────────────────────
  "lobby.cd_pending": "En attente",
  "lobby.cd_ongoing": "En cours",
  "lobby.cd_imminent": "Imminent",

  // ── Modes / équipes ───────────────────────────────────────────────
  "lobby.ranked_1v1": "Classé 1v1",
  "lobby.ranked_2v2": "Classé 2v2",
  "lobby.humans_vs_nations": "Humains vs Nations",
  "lobby.teams_of": "{n} équipes de {m}",
  "lobby.teams": "{n} équipes",
  "lobby.players_n": "{n} joueurs",

  // ── Pills de modificateurs ────────────────────────────────────────
  "lobby.pill_compact": "Compact",
  "lobby.pill_crowded": "Chargée",
  "lobby.pill_hardNations": "Nations diff.",
  "lobby.pill_waterNukes": "Nukes marines",
  "lobby.pill_noNations": "Sans nations",
  "lobby.pill_infiniteGold": "Or infini",
  "lobby.pill_infiniteTroops": "Troupes inf.",
  "lobby.pill_instantBuild": "Build instant",
  "lobby.pill_randomSpawn": "Spawn aléa.",
  "lobby.pill_alliancesOff": "Sans alliances",
  "lobby.pill_portsOff": "Sans ports",
  "lobby.pill_nukesOff": "Sans nukes",
  "lobby.pill_samsOff": "Sans SAM",
  "lobby.pill_peaceTime": "Peace time",
  "lobby.pill_doomsdayClock": "Horloge",
  "lobby.pill_overtime": "Overtime",
  "lobby.pill_disabledUnits": "Unités désact.",
  "lobby.pill_gold_x": "Or ×{n}",
  "lobby.pill_gold_m": "Or {n}M",

  // ── États vides / connexion ───────────────────────────────────────
  "lobby.connecting": "Connexion aux serveurs OpenFront…",
  "lobby.fav_empty_title": "Aucune partie sur tes cartes favorites",
  "lobby.fav_empty_text": "Clique l'étoile d'une carte pour l'ajouter à tes favoris —<br>tu seras prévenu dès qu'une partie s'ouvre dessus.",
  "lobby.stream_down_title": "Flux temps réel indisponible",
  "lobby.stream_down_text": "Impossible de joindre les serveurs OpenFront en direct depuis ce réseau.<br>Les parties réapparaîtront dès la reconnexion.",
  "lobby.retry": "Réessayer",
  "lobby.empty_title": "Aucune partie en attente",
  "lobby.empty_text": "Les nouvelles parties OpenFront apparaîtront ici automatiquement.",

  // ── Bandeau « Prochaine partie » ──────────────────────────────────
  "lobby.next_game": "Prochaine partie",
  "lobby.hero_aria": "Rejoindre la prochaine partie : {map}",

  // ── Barre d'état (topbar) ─────────────────────────────────────────
  "lobby.status_live": "Temps réel",
  "lobby.status_live_title": "WebSocket OpenFront (direct)",
  "lobby.status_proxy_title": "WebSocket OpenFront (proxy Cloudflare)",
  "lobby.status_cache": "Cache 5 min",
  "lobby.status_cache_title": "Flux temps réel indisponible — données rafraîches toutes les 5 min",
  "lobby.status_offline": "Hors ligne",
  "lobby.status_offline_title": "Impossible de joindre OpenFront",
  "lobby.status_connecting": "Connexion…",
  "lobby.status_connecting_title": "Connexion en cours",
  "lobby.stats": "{total} partie{gs} en attente · {players} joueur{ps}",
  "lobby.updated_now": "Actualisé à l'instant",
  "lobby.updated_s": "Actualisé il y a {n} s",
  "lobby.updated_min": "Actualisé il y a {n} min",

  // ── Toasts ────────────────────────────────────────────────────────
  "lobby.toast_new_fav": "Nouvelle partie sur ta carte favorite : {map}",
  "lobby.toast_login_favorites": "Connecte-toi avec Discord pour enregistrer tes cartes favorites",
  "lobby.toast_fav_error": "Impossible de mettre à jour tes favoris, réessaie",
  "lobby.toast_fav_added": "{map} ajoutée à tes cartes favorites",
  "lobby.toast_fav_removed": "{map} retirée de tes cartes favorites",
});
window.__TFH_I18N_PARTIALS__.en = Object.assign(window.__TFH_I18N_PARTIALS__.en || {}, {
  // ── Page / topbar ──────────────────────────────────────────────────
  "lobby.title": "Lobby",
  "lobby.subtitle": "Live OpenFront games — click a map to join",
  "lobby.skip_link": "Skip to main content",
  "lobby.logo_aria": "Go to dashboard",
  "lobby.nav_aria": "Main navigation",
  "lobby.theme_title": "Change theme",
  "lobby.theme_aria": "Toggle light/dark theme",
  "lobby.login": "Log in",

  // ── Lobby footer + shared footer (local additions) ────────────────
  "lobby.footer_not_affiliated": "TheFrontHub. Not affiliated with OpenFront.io.",
  "lobby.made_with_prefix": "Made with",
  "lobby.made_with_suffix": "by the community",
  "lobby.credit_inspired": "Lobby inspired by",
  "lobby.credit_link_title": "OpenFront Lobbies — by minhkarl",
  "lobby.credit_gh_title": "minhkarl's GitHub",

  // ── Filter bar ─────────────────────────────────────────────────────
  "lobby.filter_aria": "Filter games",
  "lobby.filter_show": "Show",
  "lobby.filter_all": "All",
  "lobby.filter_ffa": "FFA",
  "lobby.filter_team": "Team",
  "lobby.filter_special": "Special",
  "lobby.filter_fav": "Favorites",

  // ── Sections / carousels ──────────────────────────────────────────
  "lobby.sec_ffa": "Free For All",
  "lobby.sec_team": "Team",
  "lobby.sec_special": "Special",
  "lobby.track_aria": "{mode} games",
  "lobby.track_empty": "No {mode} games waiting",
  "lobby.scroll_left": "Scroll left",
  "lobby.scroll_right": "Scroll right",

  // ── Cards ─────────────────────────────────────────────────────────
  "lobby.almost_full": "Almost full",
  "lobby.join": "Join",
  "lobby.fav_add_title": "Add to favorite maps",
  "lobby.fav_add_aria": "Add map to favorites",
  "lobby.fav_remove_title": "Remove from favorite maps",
  "lobby.fav_remove_aria": "Remove map from favorites",

  // ── Countdowns ────────────────────────────────────────────────────
  "lobby.cd_pending": "Waiting",
  "lobby.cd_ongoing": "In progress",
  "lobby.cd_imminent": "Imminent",

  // ── Modes / teams ─────────────────────────────────────────────────
  "lobby.ranked_1v1": "Ranked 1v1",
  "lobby.ranked_2v2": "Ranked 2v2",
  "lobby.humans_vs_nations": "Humans vs Nations",
  "lobby.teams_of": "{n} teams of {m}",
  "lobby.teams": "{n} teams",
  "lobby.players_n": "{n} players",

  // ── Modifier pills ────────────────────────────────────────────────
  "lobby.pill_compact": "Compact",
  "lobby.pill_crowded": "Crowded",
  "lobby.pill_hardNations": "Hard nations",
  "lobby.pill_waterNukes": "Water nukes",
  "lobby.pill_noNations": "No nations",
  "lobby.pill_infiniteGold": "Infinite gold",
  "lobby.pill_infiniteTroops": "Infinite troops",
  "lobby.pill_instantBuild": "Instant build",
  "lobby.pill_randomSpawn": "Random spawn",
  "lobby.pill_alliancesOff": "No alliances",
  "lobby.pill_portsOff": "No ports",
  "lobby.pill_nukesOff": "No nukes",
  "lobby.pill_samsOff": "No SAMs",
  "lobby.pill_peaceTime": "Peace time",
  "lobby.pill_doomsdayClock": "Clock",
  "lobby.pill_overtime": "Overtime",
  "lobby.pill_disabledUnits": "Disabled units",
  "lobby.pill_gold_x": "Gold ×{n}",
  "lobby.pill_gold_m": "Gold {n}M",

  // ── Empty / connection states ─────────────────────────────────────
  "lobby.connecting": "Connecting to OpenFront servers…",
  "lobby.fav_empty_title": "No games on your favorite maps",
  "lobby.fav_empty_text": "Click the star on a map to add it to your favorites —<br>you'll be notified as soon as a game opens on it.",
  "lobby.stream_down_title": "Live feed unavailable",
  "lobby.stream_down_text": "Unable to reach the OpenFront servers live from this network.<br>Games will reappear once you're back online.",
  "lobby.retry": "Retry",
  "lobby.empty_title": "No games waiting",
  "lobby.empty_text": "New OpenFront games will appear here automatically.",

  // ── "Next game" banner ────────────────────────────────────────────
  "lobby.next_game": "Next game",
  "lobby.hero_aria": "Join the next game: {map}",

  // ── Status bar (topbar) ───────────────────────────────────────────
  "lobby.status_live": "Live",
  "lobby.status_live_title": "OpenFront WebSocket (direct)",
  "lobby.status_proxy_title": "OpenFront WebSocket (Cloudflare proxy)",
  "lobby.status_cache": "5 min cache",
  "lobby.status_cache_title": "Live feed unavailable — data refreshed every 5 min",
  "lobby.status_offline": "Offline",
  "lobby.status_offline_title": "Cannot reach OpenFront",
  "lobby.status_connecting": "Connecting…",
  "lobby.status_connecting_title": "Connecting",
  "lobby.stats": "{total} game{gs} waiting · {players} player{ps}",
  "lobby.updated_now": "Updated just now",
  "lobby.updated_s": "Updated {n} s ago",
  "lobby.updated_min": "Updated {n} min ago",

  // ── Toasts ────────────────────────────────────────────────────────
  "lobby.toast_new_fav": "New game on your favorite map: {map}",
  "lobby.toast_login_favorites": "Sign in with Discord to save your favorite maps",
  "lobby.toast_fav_error": "Couldn't update your favorites, please try again",
  "lobby.toast_fav_added": "{map} added to your favorite maps",
  "lobby.toast_fav_removed": "{map} removed from your favorite maps",
});
