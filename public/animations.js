/* ============================================
   TheFrontHub — Animation Engine (OPTIMIZED)
   Particles reduced, tilt throttled, no re-init
   ============================================ */

(function () {
  'use strict';

  var REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Floating Particles (lightweight) ── */
  function initParticles() {
    if (REDUCED_MOTION) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'particles-canvas';
    document.body.prepend(canvas);

    var ctx = canvas.getContext('2d');
    var particles = [];
    var PARTICLE_COUNT = 18; // Was 35 — halved for perf
    var mouse = { x: -1000, y: -1000 };
    var animId = 0;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }, { passive: true });

    for (var i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.2 + 0.08
      });
    }

    function drawParticles() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        // Mouse repulsion (only for nearby particles)
        var dx = p.x - mouse.x;
        var dy = p.y - mouse.y;
        var dist = dx * dx + dy * dy; // Skip sqrt for perf
        if (dist < 14400) { // 120²
          dist = Math.sqrt(dist);
          p.vx += dx / dist * 0.015;
          p.vy += dy / dist * 0.015;
        }

        p.vx *= 0.992;
        p.vy *= 0.992;

        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,122,0,' + p.opacity + ')';
        ctx.fill();
      }

      // Pause when tab hidden
      animId = requestAnimationFrame(drawParticles);
    }

    // Pause animation when tab is hidden
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        cancelAnimationFrame(animId);
      } else {
        animId = requestAnimationFrame(drawParticles);
      }
    });

    drawParticles();
  }

  /* ── 2. Scroll Reveal via IntersectionObserver ── */
  /* ── Auto-reveal rules: add .reveal class to known selectors ── */
  var AUTO_REVEAL_RULES = [
    { selector: '.hero-stats .stat-card', cls: 'reveal', stagger: true },
    { selector: '.feed-card', cls: 'reveal' },
    { selector: '.hof-card', cls: 'reveal', stagger: true },
    { selector: '.chart-card', cls: 'reveal', stagger: true },
    { selector: '.profile-stats-grid .modal-stat', cls: 'reveal', stagger: true },
    { selector: '.profile-sections-grid .feed-card', cls: 'reveal', stagger: true },
    { selector: '.sidebar', cls: 'reveal-left' },
    { selector: '.content', cls: 'reveal-right' },
    /* Dashboard — only panels + headers. NOT .dash-row (scrollable container
       means IntersectionObserver never fires for off-screen rows → stuck
       at opacity:0, blocking the scroll). Rows have their own .dash-row-in
       CSS entrance animation. */
    { selector: '.dash-panel', cls: 'reveal', stagger: true },
    { selector: '.dash-panel-header', cls: 'reveal' },
    /* Tournois — cards + sections */
    { selector: '.trn-card', cls: 'reveal', stagger: true },
    { selector: '.trn-section', cls: 'reveal' },
    { selector: '.trn-hero', cls: 'reveal' }
  ];

  /* Apply auto-reveal classes to elements that don't have them yet.
     Called both on init AND after dynamic content injection (TFH_reveal). */
  function applyAutoReveal() {
    AUTO_REVEAL_RULES.forEach(function (rule) {
      var els = document.querySelectorAll(rule.selector);
      els.forEach(function (el, i) {
        if (!el.classList.contains('reveal') && !el.classList.contains('reveal-left') && !el.classList.contains('reveal-right') && !el.classList.contains('reveal-scale')) {
          el.classList.add(rule.cls);
          if (rule.stagger) {
            var idx = rule.maxStagger ? Math.min(i, rule.maxStagger) : i;
            el.style.transitionDelay = (idx * 0.04) + 's';
          }
        }
      });
    });
  }

  function initScrollReveal() {
    applyAutoReveal();

    var reveals = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale');
    if (!reveals.length) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -32px 0px' });

    reveals.forEach(function (el) { observer.observe(el); });
  }

  /* ── 3. Number Count-Up Animation ── */
  function animateCountUp(el) {
    var target = parseInt(el.getAttribute('data-count') || el.textContent.replace(/[^\d]/g, ''), 10);
    if (isNaN(target) || target === 0) return;

    var duration = 800; // Was 1200 — faster
    var start = performance.now();
    el.classList.add('counting');

    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(ease * target);
      el.textContent = current.toLocaleString('fr-FR');

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target.toLocaleString('fr-FR');
        el.classList.remove('counting');
        el.classList.add('count-pop');
      }
    }
    requestAnimationFrame(tick);
  }

  function initCountUp() {
    var statValues = document.querySelectorAll('.stat-value');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !entry.target.classList.contains('counted')) {
          entry.target.classList.add('counted');
          animateCountUp(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    statValues.forEach(function (el) {
      var val = el.textContent.replace(/[^\d]/g, '');
      if (val && parseInt(val, 10) > 0) {
        el.setAttribute('data-count', val);
        observer.observe(el);
      }
    });
  }

  /* ── 4. Ripple Effect on Buttons ── */
  function initRipple() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.login-btn, .auth-btn, .share-btn, .see-more-btn, .settings-action-btn, .profile-edit-btn, .tab-btn, .runs-btn, .gg-btn');
      if (!btn) return;

      btn.classList.add('ripple');
      var rect = btn.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var size = Math.max(rect.width, rect.height) * 2;

      var wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.width = wave.style.height = size + 'px';
      wave.style.left = (x - size / 2) + 'px';
      wave.style.top = (y - size / 2) + 'px';

      btn.appendChild(wave);
      wave.addEventListener('animationend', function () { wave.remove(); });
    });
  }

  /* ── 5. Staggered Page Entrance ── */
  function initPageEntrance() {
    var elements = [
      { sel: '.site-logo', delay: 0 },
      { sel: '.nav .header-right', delay: 1 },
      { sel: '.hero-stats', delay: 2 },
      { sel: '.tabs', delay: 3 },
      { sel: '.search-bar', delay: 4 },
      { sel: '.main-grid', delay: 5 },
      { sel: '.profile-page-header', delay: 0 },
      { sel: '#profile-loading, #profile-gate, #profile-setup, #profile-main', delay: 2 }
    ];

    elements.forEach(function (rule) {
      var el = document.querySelector(rule.sel);
      if (el && !el.classList.contains('animate-entrance')) {
        el.classList.add('animate-entrance');
        el.classList.add('stagger-' + rule.delay);
      }
    });
  }

  /* ── 6. Shimmer on Loading States ── */
  function initShimmer() {
    document.querySelectorAll('.loading').forEach(function (el) {
      el.classList.add('shimmer');
    });
  }

  /* ── 7. 3D Tilt on Cards (THROTTLED — was O(n) on every mousemove) ── */
  function init3DTilt() {
    if (REDUCED_MOTION) return;
    var tiltTargets = '.stat-card, .hof-card';
    var MAX_TILT = 4; // Was 6 — subtler
    var lastTime = 0;
    var THROTTLE_MS = 32; // ~30fps for tilt (smooth enough)

    document.addEventListener('mousemove', function (e) {
      var now = performance.now();
      if (now - lastTime < THROTTLE_MS) return;
      lastTime = now;

      var cards = document.querySelectorAll(tiltTargets);
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var rect = card.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var dist = Math.sqrt((e.clientX - cx) * (e.clientX - cx) + (e.clientY - cy) * (e.clientY - cy));
        if (dist > 350) {
          card.style.transform = '';
          continue;
        }

        var x = (e.clientX - rect.left) / rect.width - 0.5;
        var y = (e.clientY - rect.top) / rect.height - 0.5;
        var rotY = x * MAX_TILT;
        var rotX = -y * MAX_TILT;

        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          card.style.transform = 'perspective(600px) rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) translateY(-3px)';
        } else {
          card.style.transform = '';
        }
      }
    }, { passive: true });
  }

  /* ── 8. Smooth value updates for live stats ── */
  function initLiveUpdates() {
    var statEls = document.querySelectorAll('.stat-value');
    statEls.forEach(function (el) {
      var lastVal = el.textContent;
      var observer = new MutationObserver(function () {
        if (el.textContent !== lastVal) {
          lastVal = el.textContent;
          el.classList.remove('count-pop');
          void el.offsetWidth;
          el.classList.add('count-pop');
        }
      });
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ── 8. Lenis smooth scroll (Linear/Apple feel) ──
     Initializes Lenis if available (loaded via lenis.js before animations.js).
     Uses default lerp=0.1 for a buttery, premium scroll. */
  var lenisInstance = null;
  function initLenis() {
    if (REDUCED_MOTION) return;
    if (typeof window.Lenis !== 'function') return;

    lenisInstance = new window.Lenis({
      duration: 1.1,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.5,
    });

    function raf(time) {
      lenisInstance.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    // Expose for anchor links
    window.TFH_lenis = lenisInstance;
  }

  /* ── 9. Scroll progress bar (thin, top) ──
     Creates a .scroll-progress element that grows with scroll. */
  function initScrollProgress() {
    if (REDUCED_MOTION) return;
    var bar = document.createElement('div');
    bar.className = 'scroll-progress';
    document.body.appendChild(bar);

    function update() {
      var st = document.documentElement.scrollTop || document.body.scrollTop;
      var sh = (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight;
      var pct = sh > 0 ? (st / sh) * 100 : 0;
      bar.style.width = pct + '%';
    }
    // Use Lenis scroll event if available, else fallback to native
    if (lenisInstance) {
      lenisInstance.on('scroll', update);
    } else {
      window.addEventListener('scroll', update, { passive: true });
    }
    update();
  }

  /* ── 10. Premium scroll reveal (fade + up + blur, 100ms stagger) ──
     Auto-applies .reveal-premium to known section/card selectors.
     Uses IntersectionObserver to add .is-visible when in viewport. */
  var PREMIUM_REVEAL_RULES = [
    { selector: '.hero-stats .stat-card', cls: 'reveal-premium', stagger: true, max: 8 },
    { selector: '.feed-card', cls: 'reveal-premium', stagger: true, max: 12 },
    { selector: '.hof-card', cls: 'reveal-premium', stagger: true, max: 8 },
    { selector: '.chart-card', cls: 'reveal-premium', stagger: true, max: 6 },
    { selector: '.profile-stats-grid .modal-stat', cls: 'reveal-premium', stagger: true, max: 8 },
    { selector: '.profile-sections-grid .feed-card', cls: 'reveal-premium', stagger: true, max: 8 },
    { selector: '.sidebar', cls: 'reveal-slide-left' },
    { selector: '.content', cls: 'reveal-slide-right' },
    /* Dashboard — only panels + headers get reveal. Rows are inside a
       scrollable container (.dash-list has overflow-y:auto), so the
       IntersectionObserver (which observes the viewport, not the container)
       never fires for rows below the fold. Rows already have their own
       CSS entrance animation (.dash-row-in), so they don't need reveal. */
    { selector: '.dash-panel', cls: 'reveal-premium', stagger: true, max: 4 },
    { selector: '.dash-panel-header', cls: 'reveal-fade' },
    /* Tournois */
    { selector: '.trn-card', cls: 'reveal-premium', stagger: true, max: 8 },
    { selector: '.trn-section', cls: 'reveal-premium' },
    { selector: '.trn-hero', cls: 'reveal-scale-premium' },
    /* Generic sections */
    { selector: 'section', cls: 'reveal-premium', stagger: false },
    { selector: 'main > *', cls: 'reveal-premium', stagger: true, max: 6 }
  ];

  function applyPremiumReveal() {
    PREMIUM_REVEAL_RULES.forEach(function (rule) {
      var els = document.querySelectorAll(rule.selector);
      els.forEach(function (el, i) {
        // Skip if already has any reveal class
        if (el.classList.contains('reveal-premium') ||
            el.classList.contains('reveal-fade') ||
            el.classList.contains('reveal-slide-left') ||
            el.classList.contains('reveal-slide-right') ||
            el.classList.contains('reveal-scale-premium')) return;
        // Skip if inside a .dash-list (rows are handled separately with stagger)
        if (rule.selector === 'section' && el.closest('.dash-panel')) return;

        el.classList.add(rule.cls);
        if (rule.stagger) {
          var idx = rule.max ? Math.min(i, rule.max) : i;
          el.style.transitionDelay = (idx * 0.1) + 's'; // 100ms stagger
        }
      });
    });
  }

  function initPremiumReveal() {
    if (REDUCED_MOTION) return;
    applyPremiumReveal();

    var reveals = document.querySelectorAll(
      '.reveal-premium:not(.is-visible), ' +
      '.reveal-fade:not(.is-visible), ' +
      '.reveal-slide-left:not(.is-visible), ' +
      '.reveal-slide-right:not(.is-visible), ' +
      '.reveal-scale-premium:not(.is-visible)'
    );

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(function (el) { observer.observe(el); });
  }

  /* ── 11. Magnetic hover on buttons ──
     Elements with .magnetic translate toward the cursor (subtle, max 6px). */
  function initMagneticHover() {
    if (REDUCED_MOTION) return;
    var targets = document.querySelectorAll('.magnetic, .login-btn, .auth-btn, .dash-more-btn, .see-more-btn');
    var MAX_PULL = 6; // px

    targets.forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var rect = el.getBoundingClientRect();
        var x = e.clientX - rect.left - rect.width / 2;
        var y = e.clientY - rect.top - rect.height / 2;
        var pullX = (x / rect.width) * MAX_PULL;
        var pullY = (y / rect.height) * MAX_PULL;
        el.style.transform = 'translate(' + pullX + 'px, ' + pullY + 'px) translateY(-2px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
      });
    });
  }

  /* ── 12. Smooth page transitions ──
     Intercept internal link clicks → fade out → navigate.
     On page load, body gets .page-enter (fade in). */
  function initPageTransitions() {
    if (REDUCED_MOTION) return;

    // Fade in on load — remove any stale page-exit from bfcache
    document.body.classList.remove('page-exit');
    document.body.classList.add('page-enter');

    // Handle bfcache restore (back/forward button) — re-fade-in
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) {
        document.body.classList.remove('page-exit');
        document.body.classList.remove('page-enter');
        void document.body.offsetWidth; // force reflow
        document.body.classList.add('page-enter');
      }
    });

    // Intercept same-origin link clicks
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (!link) return;

      var href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      if (link.target === '_blank') return;
      if (link.hasAttribute('download')) return;

      // Same-origin only
      var url;
      try { url = new URL(link.href, window.location.href); }
      catch (err) { return; }
      if (url.origin !== window.location.origin) return;

      // Skip if it's just a hash change on the same page
      if (url.pathname === window.location.pathname && url.hash) return;

      e.preventDefault();
      document.body.classList.add('page-exit');
      setTimeout(function () {
        window.location.href = link.href;
      }, 200);
    });
  }

  /* ── Initialize Everything ── */
  function init() {
    initPageTransitions();
    initLenis();
    initScrollProgress();
    initPremiumReveal();
    initMobileNav();
    initPageEntrance();
    initScrollReveal();
    initCountUp();
    initMagneticHover();
    initRipple();
    initShimmer();
    // Disabled: too heavy / distracting for a premium minimalist feel
    // init3DTilt();    // 3D card tilt on mousemove (CPU)
    // initLiveUpdates(); // MutationObserver on every .stat-value
    // initParticles(); // Floating orange particles canvas (CPU, distracting)
  }

  /* ── 13. Mobile navigation drawer (hamburger) ──
     Creates a hamburger button + backdrop dynamically on every page.
     Tapping the button slides the sidebar in from the left.
     Tapping the backdrop or a nav link closes it.
     Only active on screens ≤ 900px (CSS controls visibility). */
  function initMobileNav() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // Create hamburger button
    var btn = document.createElement('button');
    btn.className = 'mobile-nav-btn';
    btn.setAttribute('aria-label', 'Ouvrir le menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    document.body.appendChild(btn);

    // Create backdrop
    var backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    function open() {
      sidebar.classList.add('open');
      backdrop.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Fermer le menu');
      // Swap to X icon
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      // Stop Lenis from scrolling the background
      if (window.TFH_lenis && typeof window.TFH_lenis.stop === 'function') {
        window.TFH_lenis.stop();
      }
    }

    function close() {
      sidebar.classList.remove('open');
      backdrop.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Ouvrir le menu');
      // Restore hamburger icon
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
      if (window.TFH_lenis && typeof window.TFH_lenis.start === 'function') {
        window.TFH_lenis.start();
      }
    }

    function toggle() {
      if (sidebar.classList.contains('open')) close();
      else open();
    }

    btn.addEventListener('click', toggle);
    backdrop.addEventListener('click', close);

    // Close when a nav link is tapped (snappy navigation)
    sidebar.querySelectorAll('a.nav-item, .nav-item').forEach(function (link) {
      link.addEventListener('click', function () {
        // Only close if it's an actual navigation link (has href)
        if (link.getAttribute('href') || link.getAttribute('onclick')) {
          close();
        }
      });
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        close();
      }
    });

    // Close when resizing to desktop
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900 && sidebar.classList.contains('open')) {
        close();
      }
    });
  }

  /* ── Re-init for dynamically injected content ──
     Call window.TFH_reveal() after injecting new elements (e.g. dashboard
     renders its rows async after fetching scores). This re-scans for
     .reveal elements and observes them. */
  function reinitReveal() {
    // First, add .reveal classes to any new elements that match auto-reveal rules
    applyAutoReveal();
    applyPremiumReveal();

    // Re-scan both legacy and premium reveal classes
    var reveals = document.querySelectorAll(
      '.reveal:not(.revealed), .reveal-left:not(.revealed), .reveal-right:not(.revealed), .reveal-scale:not(.revealed), ' +
      '.reveal-premium:not(.is-visible), .reveal-fade:not(.is-visible), .reveal-slide-left:not(.is-visible), .reveal-slide-right:not(.is-visible), .reveal-scale-premium:not(.is-visible)'
    );
    if (!reveals.length) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { observer.observe(el); });
  }

  // Expose globally so dashboard.js / tournois.js can call after async render
  window.TFH_reveal = reinitReveal;
  window.TFH_initScrollReveal = initScrollReveal;

  // Logo click animation + redirect to dashboard
  window.logoClickAnim = function (e) {
    e.preventDefault();
    const logo = e.currentTarget || document.querySelector('.logo');
    if (!logo) return;
    logo.classList.remove('clicked');
    void logo.offsetWidth; // force reflow
    logo.classList.add('clicked');
    setTimeout(function () {
      window.location.href = 'dashboard.html';
    }, 350);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

