// i18n-dict-atlas.js — Traductions de la page atlas.html (FR / EN)
// Chargé AVANT i18n.min.js ; fusionné par i18n.js via window.__TFH_I18N_PARTIALS__.
// Convention : une clé par chaîne traduisible ; {param} pour les variables.
// Zones : chrome de page (skip-link, topbar, chargement, footer Atlas),
// filtres/stats/légende/tooltip/modale détail/boutons pan-zoom (atlas.js),
// éléments communs réutilisés (nav.*, footer.*, auth.*, modal.close → i18n.js).
window.__TFH_I18N_PARTIALS__ = window.__TFH_I18N_PARTIALS__ || {};
window.__TFH_I18N_PARTIALS__.fr = Object.assign(window.__TFH_I18N_PARTIALS__.fr || {}, {
  // ── Chrome de page (atlas.html) ─────────────────────────────────────
  "atlas.skip": "Aller au contenu principal",
  "atlas.logo_aria": "Aller au tableau de bord",
  "atlas.nav_aria": "Navigation principale",
  "atlas.theme_title": "Changer de thème",
  "atlas.theme_aria": "Basculer thème clair/sombre",
  "atlas.login": "Connexion",
  "atlas.title": "Atlas",
  "atlas.subtitle": "Cartes interactives OpenFront — géographie, stats et stratégies",
  "atlas.loading": "Chargement des cartes…",
  "atlas.footer_credit": "TheFrontHub · Atlas · Données fournies par <a href=\"https://github.com/hfichter/openfront-atlas\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--orange)\">OpenFront Atlas</a> (Public Domain)",
  "atlas.rights_rest": "TheFrontHub. Non affilié à OpenFront.io.",
  "atlas.made_with_a": "Fait avec",
  "atlas.made_with_b": "par la communauté",

  // ── États (atlas.js) ────────────────────────────────────────────────
  "atlas.error.title": "Erreur",
  "atlas.intro": "Explorez les {n} cartes d'OpenFront — géographie réelle, mondes fantastiques et arcade. Cliquez sur une carte pour les détails, nations et stratégies.",

  // ── Statistiques ────────────────────────────────────────────────────
  "atlas.stats.total": "Cartes totales",
  "atlas.stats.earth": "Terre",
  "atlas.stats.fantasy": "Autres mondes",
  "atlas.stats.arcade": "Arcade/Tournoi",

  // ── Filtres de catégories (= catLabel des cartes) ───────────────────
  "atlas.cat.all": "Toutes",
  "atlas.cat.continental": "Continentales",
  "atlas.cat.regional": "Régionales",
  "atlas.cat.fantasy": "Autres mondes",
  "atlas.cat.arcade": "Arcade",
  "atlas.cat.tournament": "Tournoi",

  // ── Légende de la carte du monde ────────────────────────────────────
  "atlas.legend.continental": "Continental",
  "atlas.legend.regional": "Régional",
  "atlas.legend.fantasy": "Fantasy",
  "atlas.legend.arcade": "Arcade",
  "atlas.legend.tournament": "Tournoi",

  // ── Tooltip des pins ────────────────────────────────────────────────
  "atlas.tt.nations": "{n} nations",
  "atlas.tt.land": "{n}% terre",
  "atlas.tt.players": "~{n} joueurs",

  // ── Cartes (grille) ─────────────────────────────────────────────────
  "atlas.card.players": "{n} joueurs",
  "atlas.card.nations": "{n} nations",
  "atlas.card.playlist": "{n}× playlist",

  // ── Modale détail ───────────────────────────────────────────────────
  "atlas.detail.back": "← Retour à l'Atlas",
  "atlas.detail.dimensions": "Dimensions",
  "atlas.detail.nations": "Nations",
  "atlas.detail.players_max": "Joueurs max",
  "atlas.detail.playlist": "Playlist",
  "atlas.detail.land": "Terre {n}%",
  "atlas.detail.water": "Eau {n}%",
  "atlas.detail.play": "Jouer sur OpenFront →",

  // ── Boutons pan & zoom (carte du monde + modale) ────────────────────
  "atlas.pz.zoom_aria": "Zoomer sur la carte",
  "atlas.pz.zoom_in": "Zoomer",
  "atlas.pz.zoom_out": "Dézoomer",
  "atlas.pz.reset_aria": "Réinitialiser la vue de la carte",
  "atlas.pz.reset": "Réinitialiser la vue",
});
window.__TFH_I18N_PARTIALS__.en = Object.assign(window.__TFH_I18N_PARTIALS__.en || {}, {
  // ── Page chrome (atlas.html) ────────────────────────────────────────
  "atlas.skip": "Skip to main content",
  "atlas.logo_aria": "Go to the dashboard",
  "atlas.nav_aria": "Main navigation",
  "atlas.theme_title": "Change theme",
  "atlas.theme_aria": "Toggle light/dark theme",
  "atlas.login": "Sign in",
  "atlas.title": "Atlas",
  "atlas.subtitle": "Interactive OpenFront maps — geography, stats and strategies",
  "atlas.loading": "Loading maps…",
  "atlas.footer_credit": "TheFrontHub · Atlas · Data provided by <a href=\"https://github.com/hfichter/openfront-atlas\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--orange)\">OpenFront Atlas</a> (Public Domain)",
  "atlas.rights_rest": "TheFrontHub. Not affiliated with OpenFront.io.",
  "atlas.made_with_a": "Made with",
  "atlas.made_with_b": "by the community",

  // ── States (atlas.js) ───────────────────────────────────────────────
  "atlas.error.title": "Error",
  "atlas.intro": "Explore OpenFront's {n} maps — real-world geography, fantasy worlds and arcade. Click a map for details, nations and strategies.",

  // ── Statistics ──────────────────────────────────────────────────────
  "atlas.stats.total": "Total maps",
  "atlas.stats.earth": "Earth",
  "atlas.stats.fantasy": "Other worlds",
  "atlas.stats.arcade": "Arcade/Tournament",

  // ── Category filters (= card catLabel) ──────────────────────────────
  "atlas.cat.all": "All",
  "atlas.cat.continental": "Continental",
  "atlas.cat.regional": "Regional",
  "atlas.cat.fantasy": "Other worlds",
  "atlas.cat.arcade": "Arcade",
  "atlas.cat.tournament": "Tournament",

  // ── World map legend ────────────────────────────────────────────────
  "atlas.legend.continental": "Continental",
  "atlas.legend.regional": "Regional",
  "atlas.legend.fantasy": "Fantasy",
  "atlas.legend.arcade": "Arcade",
  "atlas.legend.tournament": "Tournament",

  // ── Pin tooltip ─────────────────────────────────────────────────────
  "atlas.tt.nations": "{n} nations",
  "atlas.tt.land": "{n}% land",
  "atlas.tt.players": "~{n} players",

  // ── Map cards (grid) ────────────────────────────────────────────────
  "atlas.card.players": "{n} players",
  "atlas.card.nations": "{n} nations",
  "atlas.card.playlist": "{n}× playlist",

  // ── Detail modal ────────────────────────────────────────────────────
  "atlas.detail.back": "← Back to the Atlas",
  "atlas.detail.dimensions": "Dimensions",
  "atlas.detail.nations": "Nations",
  "atlas.detail.players_max": "Max players",
  "atlas.detail.playlist": "Playlist",
  "atlas.detail.land": "Land {n}%",
  "atlas.detail.water": "Water {n}%",
  "atlas.detail.play": "Play on OpenFront →",

  // ── Pan & zoom buttons (world map + modal) ──────────────────────────
  "atlas.pz.zoom_aria": "Zoom in on the map",
  "atlas.pz.zoom_in": "Zoom in",
  "atlas.pz.zoom_out": "Zoom out",
  "atlas.pz.reset_aria": "Reset the map view",
  "atlas.pz.reset": "Reset view",
});
