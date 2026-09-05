# Task 8-a — i18n index.html + app.js (Speedruns + Classé)

## État trouvé au démarrage
Un run précédent interrompu (non journalisé) avait déjà : tagué ~118 data-i18n* dans index.html,
rempli i18n-dict-home.js (132 clés) et routé ~59 chaînes de app.js (helpers T/TP/LOCALE en tête,
module bundle par dist/app.min.js). Le worklog ne contenait pas d'entrée 8-a → audit complet
ligne par ligne avant complément (scans : accents, mots FR courants, title=/aria-label=,
template literals, comparaison html.parser HEAD vs courant).

## Changements réels apportés
1. app.js (2 compléments, seules chaînes visibles restées en dur) :
   - `throw new Error(T("home.error_fetch", "Impossible de récupérer les données"))` (loadData —
     le message s'affiche dans #map-list via `${T("home.error_prefix")}${e.message}`).
   - `title="'+T("home.watch_replay","Voir le replay")+'"` dans showTeamStatsModal (lignes équipe).
   - Laissé intacts : console.*, commentaires, "GG!"/"PB"/"LIVE"/"Top 100"/"1v1"/"2v2" (identiques EN),
     labels modes (Duos/Trios/Quads identiques, abbrev. HvN OK EN), getMapDisplayName (clés map.* communes).
2. index.html :
   - th "V - D" → data-i18n="ranked.th_vd" (EN "W - L") ; th "MV" → data-i18n="ranked.th_mv" (EN "MOV").
   - data-i18n-aria des 2 recherches : search.player / maps.search → home.player_search_aria /
     home.map_search_aria (les clés communes portent le placeholder avec « ... », l'aria FR n'en a pas).
   - Cache-busters : dist/i18n-dict-home.min.js?v=2, dist/app.min.js?v=20 (preload + script body).
3. i18n-dict-home.js : +4 clés (fr+en) → 135/135 (home.* 60, ranked.* 57, modal.* 18).
   fr = textes exacts actuels ; en = gaming naturel. Aucune clé commune redéfinie.

## Validation (toutes OK)
- node --check app.js (via /tmp/a.mjs) + node --check i18n-dict-home.js.
- /home/z/my-project/validate-i18n-home.mjs (vm Node, dict de page + i18n.js fusionnés par langue) :
  203 clés uniques (120 data-i18n* HTML + 92 clés T/TP/window.t JS) toutes présentes fr+en ;
  0 clé du dict de page inutilisée ; 71 fallbacks littéraux JS == valeurs fr du dict à l'octet près ;
  textes visibles + attributs (placeholder/title/aria) du HTML == valeurs fr ;
  data-i18n-html (auth.perk1/2, modal.verify_step2) vérifiés littéralement ;
  rendu runtime t() fr (« Aucune partie classée 2v2 trouvée », « Bienvenue Skailex ! Redirection... »)
  et en (« No ranked 2v2 games found », « W - L », « MOV », « Complete your profile »).
- FR inchangé vs git HEAD (textes visibles, tags strippés) : 0 texte retiré ; 1 ajout « Langue »
  (rangée choix de langue Task 6+7, taggée lang.label).
- Balayage html.parser des nœuds texte hors data-i18n : restent uniquement <title>, Top 10/25/50,
  Elo, Winrate (identiques EN) — meta/og/JSON-LD hors périmètre data-i18n.

## Points d'attention orchestrateur
- dist/ NON rebuildé (règle) → `node scripts/build.js` AVANT déploiement (app.min.js + i18n-dict-home.min.js) ;
  les ?v=20 / ?v=2 sont déjà bumpés dans index.html.
- i18n.js appelle window.renderAll() après updateDOMTranslations — app.js expose renderAll
  (re-render dynamique EN sans reload quand la langue du compte arrive via applyAccountLanguage) ;
  setLanguage reload la page (chemin principal).
- ranked.modal_history_prefix = "Historique " et _suffix = " récent" : espaces de bord VOULUS
  (collage autour du span mode 1v1/2v2) — ne pas les "nettoyer".
- L'updateSubtitle JS (home.subtitle {mode}/{min}/{bots}/{size}) écrase le h3 statique
  header.subtitle dès le premier rendu : l'EN du sous-titre serveur vient de home.subtitle (page), OK.
- Script de validation réutilisable : /home/z/my-project/validate-i18n-home.mjs (changer ROOT/page).
