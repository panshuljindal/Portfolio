/* ==========================================================================
   Shared behaviour: nav, drawer, scroll progress, reveals, scrollspy,
   stat counters, reading progress. Dependency-free.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Opt into the hidden-then-reveal treatment only once we know we can undo it.
  // If anything below throws, the safety net at the end still shows everything.
  root.classList.add('js-ready');

  function revealAll() {
    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
      el.style.transitionDelay = '0ms';
      el.classList.add('is-in');
    });
  }

  // Last-resort guarantee: content is never left invisible.
  window.setTimeout(revealAll, 3000);
  window.addEventListener('error', revealAll);

  var raf = function (fn) { return window.requestAnimationFrame(fn); };
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ---------------------------------------------------------------- Nav */
  var nav = $('.nav');
  var progress = $('.progress');

  function onScroll() {
    var y = window.scrollY;
    if (nav) nav.classList.toggle('is-stuck', y > 12);

    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = 'scaleX(' + (max > 0 ? Math.min(y / max, 1) : 0) + ')';
    }
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    raf(function () { onScroll(); ticking = false; });
  }, { passive: true });
  onScroll();

  /* ------------------------------------------------------------- Drawer */
  var drawer = $('#drawer');
  var scrim = $('#scrim');
  var toggle = $('#navToggle');

  function setDrawer(open) {
    if (!drawer || !scrim) return;
    drawer.classList.toggle('is-open', open);
    scrim.classList.toggle('is-open', open);
    document.body.style.overflow = open ? 'hidden' : '';
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      var first = drawer.querySelector('a, button');
      if (first) first.focus();
    } else if (toggle) {
      toggle.focus();
    }
  }

  if (toggle) toggle.addEventListener('click', function () { setDrawer(true); });
  if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
  var closeBtn = $('#drawerClose');
  if (closeBtn) closeBtn.addEventListener('click', function () { setDrawer(false); });
  if (drawer) {
    $$('a', drawer).forEach(function (a) {
      a.addEventListener('click', function () { setDrawer(false); });
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer && drawer.classList.contains('is-open')) setDrawer(false);
  });

  /* ------------------------------------------------------------ Reveals */
  var revealables = $$('.reveal');
  if (revealables.length) {
    if (reduced || !('IntersectionObserver' in window)) {
      revealables.forEach(function (el) { el.classList.add('is-in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var delay = parseFloat(el.dataset.delay || 0);
          if (delay) el.style.transitionDelay = delay + 'ms';
          el.classList.add('is-in');
          io.unobserve(el);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
      revealables.forEach(function (el) { io.observe(el); });
    }
  }

  /* --------------------------------------------------- Stagger children */
  $$('[data-stagger]').forEach(function (group) {
    var step = parseInt(group.dataset.stagger, 10) || 80;
    $$(':scope > .reveal', group).forEach(function (child, i) {
      if (!child.dataset.delay) child.dataset.delay = String(i * step);
    });
  });

  /* ----------------------------------------------------- Stat counters */
  var counters = $$('[data-count]');
  if (counters.length && !reduced && 'IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        cio.unobserve(el);

        var target = parseFloat(el.dataset.count);
        var prefix = el.dataset.prefix || '';
        var suffix = el.dataset.suffix || '';
        var decimals = (el.dataset.count.split('.')[1] || '').length;
        var duration = 1400;
        var start = performance.now();

        (function tick(now) {
          var p = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = prefix + (target * eased).toFixed(decimals) + suffix;
          if (p < 1) raf(tick);
        })(start);
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* --------------------------------------------------------- Scrollspy */
  var spyLinks = $$('.nav-links a[href^="#"]');
  if (spyLinks.length && 'IntersectionObserver' in window) {
    var sections = spyLinks
      .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean);

    if (sections.length) {
      var visible = new Map();
      var sio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0); });

        var bestId = null, best = 0;
        visible.forEach(function (ratio, id) { if (ratio > best) { best = ratio; bestId = id; } });

        spyLinks.forEach(function (a) {
          a.classList.toggle('is-active', bestId !== null && a.getAttribute('href') === '#' + bestId);
        });
      }, { rootMargin: '-20% 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] });
      sections.forEach(function (s) { sio.observe(s); });
    }
  }

  /* ----------------------------------------------------- Marquee clone */
  var track = $('.marquee-track');
  if (track && !track.dataset.cloned) {
    track.innerHTML += track.innerHTML;
    track.dataset.cloned = '1';
  }

  /* ------------------------------------------------ Portrait fallback
     This script is deferred, so an image may have already failed before we
     get here — its `error` event is long gone. Check both: swap immediately
     if it has already failed, otherwise listen for a failure still to come. */
  $$('img[data-fallback]').forEach(function (img) {
    var swap = function () {
      var fb = img.dataset.fallback;
      if (!fb || img.src.indexOf(fb) !== -1) return; // don't loop on a broken fallback
      delete img.dataset.fallback;
      img.src = fb;
    };
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener('error', swap, { once: true });
  });

  /* ---------------------------------------------------------- Year */
  $$('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
