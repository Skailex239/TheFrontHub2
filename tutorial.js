/**
 * tutorial.js — Système de tutoriel interactif pour TheFrontHub
 *
 * Au premier passage sur le site, affiche un guide pas-à-pas avec :
 *   - Spotlight (halo lumineux) sur l'élément à découvrir
 *   - Tooltip avec titre + description + boutons "Suivant" / "Passer"
 *   - Sauvegarde dans localStorage('tfs-tutorial-completed')
 *
 * Le tutoriel ne se déclenche qu'une fois (si completed !== '1').
 * L'utilisateur peut le skip via le bouton "Passer le tutoriel".
 *
 * Étapes (adaptatives selon les éléments présents sur la page) :
 *   1. Bienvenue (modal plein écran)
 *   2. Sidebar / nav principale
 *   3. Recherche joueur (si présent)
 *   4. Theme toggle
 *   5. Bouton Discord (footer)
 *   6. Tu es prêt ! (modal final)
 *
 * Le tutoriel est chargé en module sur toutes les pages.
 */

const TUTORIAL_KEY = 'tfs-tutorial-completed';

/* ═══ i18n (moteur global i18n.js — clés tut.* dans i18n-dict-support.js) ═══
   T(k, fb) : traduit via window.t, retombe sur le texte FR si i18n absent.
   TP(k, params, fb) : idem avec substitution {param}.
   TK : retombe AUSSI sur le fallback quand la clé manque du dictionnaire
   (pages ne chargeant pas i18n-dict-support.js → window.t renverrait la clé). */
const T = (k, fb) => (typeof window.t === 'function' ? window.t(k) : fb);
const TP = (k, params, fb) => {
  if (typeof window.t !== 'function') return fb;
  const v = window.t(k, params);
  return v && v !== k ? v : fb;
};
const TK = (k, fb) => {
  const v = T(k, fb);
  return v === k || v == null ? fb : v;
};

// Étapes du tutoriel.
// Chaque étape peut avoir :
//   - target: sélecteur CSS de l'élément à spotlighter (ou null pour modal)
//   - title: titre court
//   - text: description
//   - position: 'top' | 'bottom' | 'left' | 'right' (position du tooltip par rapport au target)
//   - waitFor: délai avant l'affichage (en ms) pour laisser le temps aux éléments de charger
const TUTORIAL_STEPS = [
  {
    target: null,  // modal plein écran
    k: 's1',
    title: 'Bienvenue sur TheFrontHub ! 👋',
    text: 'Le hub ultime pour OpenFront.io : speedruns, classements, tournois et stats joueurs. Découvrons le site ensemble en 30 secondes.',
    position: 'center',
  },
  {
    target: '#tab-btn-maps, .nav-item[href="index.html"]',
    k: 's2',
    title: '🏆 Speedruns',
    text: 'Le classement des meilleurs temps sur chaque carte. Clique sur une carte pour voir le top 25.',
    position: 'right',
  },
  {
    target: '#tab-btn-ranked, .nav-item[href="index.html?tab=ranked"]',
    k: 's3',
    title: '⚔️ Mode Classé',
    text: 'Le mode compétitif 1v1 avec système d\'ELO. Vois ton rang et ton historique.',
    position: 'right',
  },
  {
    target: '#tab-btn-tournois, .nav-item[href="tournois.html"]',
    k: 's4',
    title: '🥇 Tournois',
    text: 'Le circuit compétitif avec Power Ranking, calendrier et résultats détaillés.',
    position: 'right',
  },
  {
    target: '#player-search',
    k: 's5',
    title: '🔍 Recherche joueur',
    text: 'Tape le pseudo d\'un joueur pour voir ses stats et son rang.',
    position: 'bottom',
    skipIfMissing: true,
  },
  {
    target: '.theme-toggle',
    k: 's6',
    title: '🌗 Thème clair/sombre',
    text: 'Bascule entre le mode clair, sombre ou auto (selon ton système).',
    position: 'right',
  },
  {
    target: '.tfh-footer-discord',
    k: 's7',
    title: '💬 Communauté',
    text: 'Rejoins le Discord pour suivre les actus, participer aux tournois et parler avec la communauté.',
    position: 'top',
  },
  {
    target: null,
    k: 's8',
    title: 'Tu es prêt ! 🚀',
    text: 'Tu connais maintenant les bases. Explore le site, et bonne chance pour battre des records !',
    position: 'center',
    isLast: true,
  },
];

let _currentStep = 0;
let _overlay = null;
let _spotlight = null;
let _tooltip = null;

/**
 * Vérifie si le tutoriel doit être lancé.
 */
function shouldRunTutorial() {
  try {
    return localStorage.getItem(TUTORIAL_KEY) !== '1';
  } catch (e) {
    return false;
  }
}

/**
 * Trouve un élément par sélecteur (supporte les sélecteurs multiples séparés par virgule).
 */
function findTarget(selector) {
  if (!selector) return null;
  const selectors = selector.split(',').map(s => s.trim());
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return el;
    }
  }
  return null;
}

/**
 * Calcule la position du tooltip en fonction de la position demandée.
 */
function positionTooltip(targetRect, position) {
  const tooltip = _tooltip;
  if (!tooltip) return;

  // D'abord mesurer le tooltip
  const tipRect = tooltip.getBoundingClientRect();
  const tipW = tipRect.width;
  const tipH = tipRect.height;
  const gap = 12;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let top, left;

  if (position === 'center') {
    // Centré dans la viewport
    left = (viewportW - tipW) / 2;
    top = (viewportH - tipH) / 2;
  } else if (position === 'top') {
    left = targetRect.left + (targetRect.width - tipW) / 2;
    top = targetRect.top - tipH - gap;
  } else if (position === 'bottom') {
    left = targetRect.left + (targetRect.width - tipW) / 2;
    top = targetRect.bottom + gap;
  } else if (position === 'left') {
    left = targetRect.left - tipW - gap;
    top = targetRect.top + (targetRect.height - tipH) / 2;
  } else if (position === 'right') {
    left = targetRect.right + gap;
    top = targetRect.top + (targetRect.height - tipH) / 2;
  }

  // Clamp dans la viewport
  const margin = 16;
  left = Math.max(margin, Math.min(left, viewportW - tipW - margin));
  top = Math.max(margin, Math.min(top, viewportH - tipH - margin));

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

/**
 * Positionne le spotlight sur l'élément cible.
 */
function positionSpotlight(target) {
  if (!_spotlight) return;
  if (!target) {
    // Pas de cible → cacher le spotlight
    _spotlight.style.display = 'none';
    return;
  }
  _spotlight.style.display = 'block';
  const r = target.getBoundingClientRect();
  const pad = 6;
  _spotlight.style.left = (r.left - pad) + 'px';
  _spotlight.style.top = (r.top - pad) + 'px';
  _spotlight.style.width = (r.width + pad * 2) + 'px';
  _spotlight.style.height = (r.height + pad * 2) + 'px';
}

/**
 * Affiche une étape du tutoriel.
 */
function showStep(idx) {
  if (idx >= TUTORIAL_STEPS.length) {
    finishTutorial();
    return;
  }

  const step = TUTORIAL_STEPS[idx];
  _currentStep = idx;

  // Trouver la cible
  const target = step.target ? findTarget(step.target) : null;

  // Si l'étape nécessite un élément absent, on la skip
  if (step.target && !target && step.skipIfMissing) {
    showStep(idx + 1);
    return;
  }

  // Si pas de target mais pas center, on skip aussi (élément non trouvé)
  if (step.target && !target && step.position !== 'center') {
    showStep(idx + 1);
    return;
  }

  // Créer les éléments s'ils n'existent pas
  if (!_overlay) {
    createTutorialElements();
  }

  // Positionner le spotlight
  positionSpotlight(target);

  // Mettre à jour le contenu du tooltip (titres/textes via i18n, fallback FR)
  const progress = TP('tut.progress', { n: idx + 1, total: TUTORIAL_STEPS.length }, `Étape ${idx + 1} / ${TUTORIAL_STEPS.length}`);
  const isLast = step.isLast || idx === TUTORIAL_STEPS.length - 1;
  _tooltip.innerHTML = `
    <div class="tfh-tutorial-progress">${progress}</div>
    <h3 class="tfh-tutorial-title">${TK('tut.' + step.k + '_title', step.title)}</h3>
    <p class="tfh-tutorial-text">${TK('tut.' + step.k + '_text', step.text)}</p>
    <div class="tfh-tutorial-actions">
      <button class="tfh-tutorial-skip" type="button">${TK('tut.skip', 'Passer le tutoriel')}</button>
      <button class="tfh-tutorial-next" type="button">${isLast ? TK('tut.finish', 'Terminer 🎉') : TK('tut.next', 'Suivant →')}</button>
    </div>
  `;

  // Bind events
  _tooltip.querySelector('.tfh-tutorial-next').addEventListener('click', () => {
    if (isLast) {
      finishTutorial();
    } else {
      showStep(idx + 1);
    }
  });
  _tooltip.querySelector('.tfh-tutorial-skip').addEventListener('click', skipTutorial);

  // Afficher
  _overlay.style.display = 'block';
  _tooltip.style.display = 'block';

  // Positionner le tooltip (après que le DOM l'ait rendu pour mesurer sa taille)
  requestAnimationFrame(() => {
    const targetRect = target ? target.getBoundingClientRect() : null;
    positionTooltip(targetRect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }, step.position);
  });

  // Scroll l'élément cible dans la viewport si nécessaire
  if (target) {
    const r = target.getBoundingClientRect();
    if (r.top < 50 || r.bottom > window.innerHeight - 50) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Re-positionner après le scroll
      setTimeout(() => {
        const newRect = target.getBoundingClientRect();
        positionSpotlight(target);
        positionTooltip(newRect, step.position);
      }, 400);
    }
  }
}

/**
 * Crée les éléments DOM du tutoriel (overlay, spotlight, tooltip).
 */
function createTutorialElements() {
  // Overlay (fond sombre)
  _overlay = document.createElement('div');
  _overlay.className = 'tfh-tutorial-overlay';
  _overlay.style.display = 'none';
  document.body.appendChild(_overlay);

  // Spotlight (halo lumineux sur l'élément cible)
  _spotlight = document.createElement('div');
  _spotlight.className = 'tfh-tutorial-spotlight';
  _spotlight.style.display = 'none';
  document.body.appendChild(_spotlight);

  // Tooltip (boîte de dialogue)
  _tooltip = document.createElement('div');
  _tooltip.className = 'tfh-tutorial-tooltip';
  _tooltip.style.display = 'none';
  document.body.appendChild(_tooltip);

  // Click sur l'overlay = skip
  _overlay.addEventListener('click', skipTutorial);

  // Repositionner au resize / scroll
  window.addEventListener('resize', () => {
    if (_overlay.style.display === 'block') {
      const step = TUTORIAL_STEPS[_currentStep];
      const target = step && step.target ? findTarget(step.target) : null;
      positionSpotlight(target);
      if (target) {
        const r = target.getBoundingClientRect();
        positionTooltip(r, step.position);
      }
    }
  });
}

/**
 * Démarre le tutoriel.
 */
function startTutorial() {
  if (!shouldRunTutorial()) return;
  showStep(0);
}

/**
 * Passe le tutoriel (skip).
 */
function skipTutorial() {
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch (e) {}
  cleanupTutorial();
}

/**
 * Termine le tutoriel normalement.
 */
function finishTutorial() {
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch (e) {}
  cleanupTutorial();
  // Petit toast de fin
  setTimeout(() => {
    if (typeof window.showToast === 'function') {
      window.showToast(TK('tut.toast_welcome', 'Bienvenue sur TheFrontHub ! 🎉'), 'success', 3000);
    }
  }, 200);
}

/**
 * Nettoie les éléments DOM du tutoriel.
 */
function cleanupTutorial() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_spotlight) { _spotlight.remove(); _spotlight = null; }
  if (_tooltip) { _tooltip.remove(); _tooltip = null; }
  _currentStep = 0;
}

/**
 * Permet de relancer le tutoriel manuellement (via console ou bouton).
 */
function restartTutorial() {
  try { localStorage.removeItem(TUTORIAL_KEY); } catch (e) {}
  startTutorial();
}

// Exposer publiquement
if (typeof window !== 'undefined') {
  window.startTutorial = startTutorial;
  window.restartTutorial = restartTutorial;

  // Lancer le tutoriel au chargement si pas déjà fait
  // On attend que les éléments dynamiques soient rendus (app.js, etc.)
  function autoStartTutorial() {
    if (!shouldRunTutorial()) return;

    // Vérifier qu'on n'est pas sur une page sans éléments (ex: page de login)
    // Attendre 2.5s pour laisser le temps à loadData() de finir
    setTimeout(() => {
      try {
        startTutorial();
      } catch (e) {
        console.warn('[tutorial] Could not start:', e);
      }
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStartTutorial);
  } else {
    autoStartTutorial();
  }
}
