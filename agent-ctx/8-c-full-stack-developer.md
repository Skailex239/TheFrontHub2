# Task 8-c — full-stack-developer

## Goal
Rendre bilingue FR/EN la page lobby.html + sa logique lobby.js (1284 lignes) via l'infrastructure i18n en place (i18n.js + partials `window.__TFH_I18N_PARTIALS__`), sans refactor ni régression (drag/carousel, tri-niveaux WS, favoris intacts).

## Files modified
- `lobby.html` — 44 tags data-i18n* (topbar, sidebar, footers, auth-modal)
- `lobby.js` — helper `T()` + ~45 littéraux FR routés via `T(clé, fallback, params)`
- `i18n-dict-lobby.js` — 90 clés lobby.* en fr ET en (squelette remplacé, en-tête conservé)

## Key decisions
1. **Helper i18n** : `const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params) : fb);` en tête de lobby.js. Le `params` optionnel sert aux chaînes paramétrées ({n}, {map}…) ; le fallback FR inline garantit un affichage identique si i18n.js est absent.
2. **Fallbacks = FR actuel** : chaque `T("clé", "texte FR actuel")` garde le FR byte-identique (35 fallbacks simples auto-comparés au dict par le script de validation — zéro divergence).
3. **Clés dynamiques** : `T("lobby.pill_" + p, fb)` pour les pills (PILL_LABELS), `T("lobby.filter_" + f.key, f.label)` pour les filtres, `T("lobby.sec_" + sec.key, sec.label)` pour les sections — pas de nouveau champ dans SECTIONS/FILTERS (le `label` existant sert de fallback).
4. **Pills dynamiques** : « Or ×N » / « Or NM » traduits au push (`lobby.pill_gold_x`, `lobby.pill_gold_m`) ; `pillLabel()` laisse passer les libellés déjà traduits.
5. **Comparaisons « urgent »** : les 4 tests `txt === "Imminent" || txt === "En cours"` remplacés par un helper `isUrgentCountdown(txt)` (comparaison sur les valeurs traduites) — évite 4 duplications et les bugs de langue.
6. **SOURCE_META** : passe de `label`/`title` à `labelKey`/`labelFb`/`titleKey`/`titleFb` (évaluation paresseuse de T() dans renderStatus, pas de valeur figée au chargement du module).
7. **Footer commun** : `footer.rights` NON utilisé telle quelle (le {year} ne serait pas substitué par data-i18n et l'année vivrait dans le span#tfh-current-year) → ligne splittée : `© <span id="tfh-current-year">…</span> <span data-i18n="lobby.footer_not_affiliated">`. Idem `footer.made_with` (le span .tfh-heart aurait été détruit par innerHTML) → split `lobby.made_with_prefix` / `♥` (span conservé) / `lobby.made_with_suffix`. ⚠️ Rappel pour les autres agents : les clés communes sont assignées APRÈS la fusion des partials dans i18n.js → un partial ne peut PAS surcharger une clé commune.
8. **Crédit minhkarl** : « Lobby inspiré du projet » wrappé dans un span (l'élément parent a un enfant <i data-icon>), liens + « minhkarl.github.io » + « GitHub » intacts ; seuls les tooltips des liens sont traduits (data-i18n-title).
9. **Auth modal** : clés communes réutilisées telles quelles (auth.modal_title, auth.modal_subtitle, auth.continue_discord, auth.perk1/2 via data-i18n-html, auth.security_note, auth.dropdown_online/my_profile/logout, modal.close pour l'aria de la croix). Sidebar : nav.dashboard/maps/ranked/lobby/atlas/tournaments/my_profile/support — textes wrappés dans <span data-i18n> à cause des <i data-icon>.
10. **Non traduit** (conformément aux règles) : console.log/warn/error, commentaires, `<span>TheFrontHub · Lobby</span>`, noms de cartes bruts (mapDisplayName gère déjà via map.*), icônes SVG.

## Validation
- `node --check lobby.js` (via /tmp/lobby-check.mjs) ✓ ; `node --check i18n-dict-lobby.js` ✓
- Script croisé (harnace Node, stubs window/document) : 108 clés nécessaires (44 data-i18n* HTML + T() JS + clés dynamiques pill/filter/sec) → toutes présentes en fr ET en (partiel + commun) ✓ ; 35 fallbacks FR = dict fr ✓ ; 0 collision lobby.* vs clés communes ✓ ; 12 rendus paramétrés testés fr+en (pas de {placeholder} résiduel) ✓
- Test runtime EN/FR : buildCard renvoie « Almost full »/« Join »/fav titles EN, pillLabel("crowded")→"Crowded", countdown "In progress"/"Imminent", describeTeams "2 teams of 5", modeLabel special→"Special" ; FR inchangé (« Presque pleine », « Rejoindre », « En cours », « 2 équipes de 5 », « Spécial ») ✓
- Drag/carousel (seuil 6 px, suppressClick), auto-scroll, tri WS, favoris, délégation de clic étoile : aucun code de logique touché hors libellés.
- dist/ NON rebuilt (règle) — `dist/i18n-dict-lobby.min.js` et `dist/lobby.min.js` seront régénérés par scripts/build.js au pipeline.

## Notes for parent
- 90 clés lobby.* ajoutées (fr+en). Les zones : topbar (title/subtitle), filtres, sections, cartes (Presque pleine/Rejoindre/étoile), timers (En attente/En cours/Imminent), pills ×19, états vides ×4, bandeau Prochaine partie, barre d'état (Temps réel/Cache 5 min/Hors ligne/Connexion… + tooltips + compteur parties/joueurs), label « Actualisé il y a… », toasts ×5, footer lobby + compléments footer commun, a11y (skip-link, logo, nav, thème, flèches carrousel, hero aria).
- Si d'autres pages reprennent la sidebar/footer : les clés lobby.theme_*, lobby.login, lobby.skip_link, lobby.logo_aria, lobby.nav_aria, lobby.footer_not_affiliated, lobby.made_with_prefix/suffix sont spécifiques lobby (namespace respecté) — à factoriser en clés communes par l'orchestrateur si souhaité.
