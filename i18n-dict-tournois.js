// i18n-dict-tournois.js — Traductions de la page tournois.html (FR / EN)
// Chargé AVANT i18n.min.js ; fusionné par i18n.js via window.__TFH_I18N_PARTIALS__.
// Convention : une clé par chaîne traduisible ; {param} pour les variables.
window.__TFH_I18N_PARTIALS__ = window.__TFH_I18N_PARTIALS__ || {};
window.__TFH_I18N_PARTIALS__.fr = Object.assign(window.__TFH_I18N_PARTIALS__.fr || {}, {
  // ── Chrome commun de la page (skip-link, sidebar, thème, topnav, drawer) ──
  "trn.a11y.skip": "Aller au contenu principal",
  "trn.a11y.logo_dashboard": "Aller au tableau de bord",
  "trn.theme.title": "Changer de thème",
  "trn.theme.aria": "Basculer thème clair/sombre",
  "trn.auth.login": "Connexion",
  "trn.nav.home": "Accueil",
  "trn.nav.ranking": "Classement PR",
  "trn.nav.calendar": "Calendrier",
  "trn.nav.play": "Jouer",
  "trn.a11y.open_menu": "Ouvrir le menu",
  "trn.a11y.close_menu": "Fermer le menu",
  "trn.a11y.drawer": "Navigation Tournois",
  "trn.drawer.title": "Tournois & PR",
  "trn.back": "Retour",
  "trn.loading": "Chargement des données tournoi…",

  // ── En-tête de page + routeur (erreurs, fil d'ariane) ──
  "trn.page.title": "Tournois",
  "trn.page.subtitle": "Power Ranking · Circuit compétitif OpenFront",
  "trn.error.load": "Impossible de charger les données",
  "trn.error.render": "Erreur de rendu",
  "trn.bc.tournaments": "<strong>Tournois</strong>",
  "trn.bc.ranking": "<strong>Classement</strong>",

  // ── Chips compteurs (partagées entre les vues) ──
  "trn.chip.tournaments": "{n} tournois",
  "trn.chip.players": "{n} joueurs",

  // ── Vue : Tableau de bord ──
  "trn.dash.title": "Tableau de bord",
  "trn.dash.subtitle": "Classement par points · FFA +10 / Team +5 par victoire",
  "trn.dash.mode.overall": "Global",
  "trn.dash.mode.weekly": "Cette semaine",
  "trn.dash.champion.overall": "Champion Global",
  "trn.dash.champion.weekly": "Champion de la semaine",
  "trn.stat.wins": "Victoires",
  "trn.dash.ranked_players": "Joueurs classés",
  "trn.dash.points_distributed": "Points distribués",
  "trn.dash.ffa_wins": "Victoires FFA",
  "trn.dash.ffa_sub": "+10 pts chacune",
  "trn.dash.team_wins": "Victoires Team",
  "trn.dash.team_sub": "+5 pts chacune",
  "trn.dash.table_title": "Classement — {mode}",
  "trn.dash.period_aria": "Période du classement",
  "trn.th.player": "Joueur",
  "trn.empty.week": "Aucun tournoi cette semaine.",
  "trn.empty.now": "Aucun tournoi pour le moment.",
  "trn.dash.scoring": "Barème : FFA — 1er <strong>+10</strong>, 2e +7, 3e +5, 4e +3, 5e +1 · Team — 1er <strong>+5</strong>, 2e +3, 3e +2",

  // ── Vue : Accueil (hero + cartes highlight) ──
  "trn.hero.eyebrow": "CIRCUIT COMPÉTITIF OPENFRONT",
  "trn.hero.title": "Tournois & Power Ranking",
  "trn.hero.subtitle": "Suivez les performances des meilleurs joueurs du circuit compétitif.",
  "trn.hero.search_placeholder": "Rechercher un joueur, un clan, un tournoi…",
  "trn.hero.search_aria": "Rechercher",
  "trn.hero.ranked_players": "{n} joueurs classés",
  "trn.hl.champion": "CHAMPION ACTUEL",
  "trn.hl.most_wins": "PLUS DE VICTOIRES",
  "trn.hl.latest": "DERNIER TOURNOI",
  "trn.hl.more": "Voir plus",
  "trn.hl.wins_events": "{wins} victoires · {events} tournois",

  // ── Vue : Classement PR ──
  "trn.rank.title": "Classement Power Ranking",
  "trn.rank.subtitle": "Points cumulés sur tous les tournois",
  "trn.rank.card_title": "Classement général",
  "trn.filter.all": "Tous",
  "trn.filter.recurring": "Réguliers (≥2)",
  "trn.filter.clan": "Avec clan",
  "trn.rank.search_placeholder": "Rechercher un joueur…",
  "trn.th.tournaments": "Tournois",
  "trn.th.avg_place": "Place moy.",
  "trn.badge.new": "Nouveau",
  "trn.empty.results": "Aucun résultat.",

  // ── Vue : Liste des tournois ──
  "trn.tournaments.subtitle": "Circuit compétitif OpenFront",
  "trn.tournaments.winner": "Vainqueur :",
  "trn.empty.tournaments": "Aucun tournoi.",

  // ── Vue : Détail tournoi ──
  "trn.td.notfound": "Tournoi introuvable",
  "trn.td.slug": "Slug :",
  "trn.badge.final": "Finale",
  "trn.td.no_ranking": "{n} participants (pas de classement détaillé)",
  "trn.th.pr_points": "Points PR",
  "trn.th.reward": "Récompense",
  "trn.stage.qualifier": "Qualif",
  "trn.stage.semifinal": "Demi",
  "trn.stage.final": "Finale",
  "trn.td.stats_title": "Stats du tournoi (par joueur)",
  "trn.th.games": "Parties",
  "trn.th.survived": "Survécues",
  "trn.th.best_place": "Meilleure place",
  "trn.th.max_stage": "Stage max",
  "trn.th.playtime": "Temps (min)",
  "trn.th.pts_per_game": "Pts/partie",
  "trn.empty.phases": "Aucune phase.",

  // ── Courbe d'évolution du Power Ranking ──
  "trn.chart.title": "Évolution du Power Ranking",
  "trn.chart.empty": "Aucune donnée",
  "trn.chart.sub": "Points cumulés après chaque tournoi",
  "trn.chart.aria": "Évolution des points PR cumulés — survolez la courbe pour le détail",
  "trn.chart.gained": "Gagnés",
  "trn.chart.hint": "Survolez la courbe (ou utilisez les flèches) pour voir le détail",

  // ── Vue : Profil joueur ──
  "trn.player.notfound": "Joueur introuvable",
  "trn.td.id_prefix": "ID :",
  "trn.player.subtitle": "Profil tournoi · {clan}Rank #{rank}",
  "trn.player.no_tournaments": "Aucun tournoi joué.",
  "trn.player.clan": "Clan :",
  "trn.player.rank": "Rank Power Ranking :",
  "trn.player.breakdown": "Décomposition des points",

  // ── Vue : Calendrier ──
  "trn.cal.title": "Calendrier",
  "trn.cal.subtitle": "Prochains tournois du circuit",
  "trn.cal.chip_events": "{n} événement(s)",
  "trn.cal.empty": "Aucun événement à venir.",
  "trn.cal.registered": "{n} inscrits",
  "trn.cal.register": "S'inscrire",

  // ── Footer (segments avec variables DOM, hors clés communes footer.*) ──
  "trn.footer.rights": "TheFrontHub. Non affilié à OpenFront.io.",
  "trn.footer.made1": "Fait avec",
  "trn.footer.made2": "par la communauté",
});
window.__TFH_I18N_PARTIALS__.en = Object.assign(window.__TFH_I18N_PARTIALS__.en || {}, {
  // ── Page chrome ──
  "trn.a11y.skip": "Skip to main content",
  "trn.a11y.logo_dashboard": "Go to dashboard",
  "trn.theme.title": "Change theme",
  "trn.theme.aria": "Toggle light/dark theme",
  "trn.auth.login": "Sign in",
  "trn.nav.home": "Home",
  "trn.nav.ranking": "PR Ranking",
  "trn.nav.calendar": "Calendar",
  "trn.nav.play": "Play",
  "trn.a11y.open_menu": "Open menu",
  "trn.a11y.close_menu": "Close menu",
  "trn.a11y.drawer": "Tournaments navigation",
  "trn.drawer.title": "Tournaments & PR",
  "trn.back": "Back",
  "trn.loading": "Loading tournament data…",

  // ── Page header + router (errors, breadcrumb) ──
  "trn.page.title": "Tournaments",
  "trn.page.subtitle": "Power Ranking · OpenFront competitive circuit",
  "trn.error.load": "Failed to load data",
  "trn.error.render": "Render error",
  "trn.bc.tournaments": "<strong>Tournaments</strong>",
  "trn.bc.ranking": "<strong>Ranking</strong>",

  // ── Counter chips ──
  "trn.chip.tournaments": "{n} tournaments",
  "trn.chip.players": "{n} players",

  // ── View: Dashboard ──
  "trn.dash.title": "Dashboard",
  "trn.dash.subtitle": "Points ranking · FFA +10 / Team +5 per win",
  "trn.dash.mode.overall": "Overall",
  "trn.dash.mode.weekly": "This week",
  "trn.dash.champion.overall": "Global Champion",
  "trn.dash.champion.weekly": "Weekly Champion",
  "trn.stat.wins": "Wins",
  "trn.dash.ranked_players": "Ranked players",
  "trn.dash.points_distributed": "Points awarded",
  "trn.dash.ffa_wins": "FFA wins",
  "trn.dash.ffa_sub": "+10 pts each",
  "trn.dash.team_wins": "Team wins",
  "trn.dash.team_sub": "+5 pts each",
  "trn.dash.table_title": "Ranking — {mode}",
  "trn.dash.period_aria": "Ranking period",
  "trn.th.player": "Player",
  "trn.empty.week": "No tournaments this week.",
  "trn.empty.now": "No tournaments yet.",
  "trn.dash.scoring": "Scoring: FFA — 1st <strong>+10</strong>, 2nd +7, 3rd +5, 4th +3, 5th +1 · Team — 1st <strong>+5</strong>, 2nd +3, 3rd +2",

  // ── View: Home (hero + highlight cards) ──
  "trn.hero.eyebrow": "OPENFRONT COMPETITIVE CIRCUIT",
  "trn.hero.title": "Tournaments & Power Ranking",
  "trn.hero.subtitle": "Follow the performances of the best players on the competitive circuit.",
  "trn.hero.search_placeholder": "Search for a player, a clan or a tournament…",
  "trn.hero.search_aria": "Search",
  "trn.hero.ranked_players": "{n} ranked players",
  "trn.hl.champion": "CURRENT CHAMPION",
  "trn.hl.most_wins": "MOST WINS",
  "trn.hl.latest": "LATEST TOURNAMENT",
  "trn.hl.more": "View more",
  "trn.hl.wins_events": "{wins} wins · {events} tournaments",

  // ── View: PR Ranking ──
  "trn.rank.title": "Power Ranking Leaderboard",
  "trn.rank.subtitle": "Points accumulated across all tournaments",
  "trn.rank.card_title": "Overall ranking",
  "trn.filter.all": "All",
  "trn.filter.recurring": "Regulars (≥2)",
  "trn.filter.clan": "With clan",
  "trn.rank.search_placeholder": "Search for a player…",
  "trn.th.tournaments": "Tournaments",
  "trn.th.avg_place": "Avg place",
  "trn.badge.new": "New",
  "trn.empty.results": "No results.",

  // ── View: Tournaments list ──
  "trn.tournaments.subtitle": "OpenFront competitive circuit",
  "trn.tournaments.winner": "Winner:",
  "trn.empty.tournaments": "No tournaments.",

  // ── View: Tournament detail ──
  "trn.td.notfound": "Tournament not found",
  "trn.td.slug": "Slug:",
  "trn.badge.final": "Final",
  "trn.td.no_ranking": "{n} participants (no detailed ranking)",
  "trn.th.pr_points": "PR points",
  "trn.th.reward": "Prize",
  "trn.stage.qualifier": "Qualifier",
  "trn.stage.semifinal": "Semifinal",
  "trn.stage.final": "Final",
  "trn.td.stats_title": "Tournament stats (per player)",
  "trn.th.games": "Games",
  "trn.th.survived": "Survived",
  "trn.th.best_place": "Best place",
  "trn.th.max_stage": "Max stage",
  "trn.th.playtime": "Time (min)",
  "trn.th.pts_per_game": "Pts/game",
  "trn.empty.phases": "No phases.",

  // ── Power Ranking progression chart ──
  "trn.chart.title": "Power Ranking progression",
  "trn.chart.empty": "No data",
  "trn.chart.sub": "Cumulated points after each tournament",
  "trn.chart.aria": "Cumulated PR points progression — hover the curve for details",
  "trn.chart.gained": "Gained",
  "trn.chart.hint": "Hover the curve (or use the arrow keys) for details",

  // ── View: Player profile ──
  "trn.player.notfound": "Player not found",
  "trn.td.id_prefix": "ID:",
  "trn.player.subtitle": "Tournament profile · {clan}Rank #{rank}",
  "trn.player.no_tournaments": "No tournaments played.",
  "trn.player.clan": "Clan:",
  "trn.player.rank": "Power Ranking rank:",
  "trn.player.breakdown": "Points breakdown",

  // ── View: Calendar ──
  "trn.cal.title": "Calendar",
  "trn.cal.subtitle": "Upcoming circuit tournaments",
  "trn.cal.chip_events": "{n} event(s)",
  "trn.cal.empty": "No upcoming events.",
  "trn.cal.registered": "{n} registered",
  "trn.cal.register": "Register",

  // ── Footer (segments with DOM variables, outside common footer.* keys) ──
  "trn.footer.rights": "TheFrontHub. Not affiliated with OpenFront.io.",
  "trn.footer.made1": "Made with",
  "trn.footer.made2": "by the community",
});
