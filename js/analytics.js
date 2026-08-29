/* ==========================================================================
   Site analytics. Dependency-free, cookieless, no personal data.

   Sends batched events to /api/event, which writes them into a Cloudflare
   Workers Analytics Engine dataset.

   Instrumentation is hybrid: every click is captured automatically, and the
   label is resolved through a fallback chain so anything tagged with
   data-track="..." gets a clean human-readable name instead of a CSS path.

   Opt out of your own traffic by visiting any page with ?notrack=1
   (re-enable with ?notrack=0).
   ========================================================================== */
(function () {
  'use strict';

  var ENDPOINT = '/api/event';
  var BATCH_SIZE = 25;    // flush early once this many events queue up
  var FLUSH_MS = 10000;   // ...or after this long, whichever comes first
  var MAX_QUEUE = 250;    // Analytics Engine caps data points per request
  var OPT_OUT_KEY = 'pj_notrack';

  /* ------------------------------------------------------------- Opt out */
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get('notrack') === '1') localStorage.setItem(OPT_OUT_KEY, '1');
    if (qs.get('notrack') === '0') localStorage.removeItem(OPT_OUT_KEY);
    if (localStorage.getItem(OPT_OUT_KEY) === '1') return;
  } catch (e) { /* private mode: carry on */ }

  /* ------------------------------------------------------------- Session */
  function sessionId() {
    try {
      var k = 'pj_sid';
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return 'nostore';
    }
  }

  function deviceClass() {
    var w = window.innerWidth || 0;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  var SID = sessionId();
  var PATH = location.pathname || '/';

  /* --------------------------------------------------------------- Queue */
  var queue = [];
  var timer = null;

  function envelope(events) {
    return JSON.stringify({
      sid: SID,
      ref: document.referrer || '',
      ttl: (document.title || '').slice(0, 200),
      dev: deviceClass(),
      vw: window.innerWidth || 0,
      vh: window.innerHeight || 0,
      events: events
    });
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_QUEUE);
    var payload = envelope(batch);

    // sendBeacon survives page unload; fetch is used for in-page flushes so
    // we don't burn the (small) beacon budget during a long session.
    if (useBeacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        body: payload,
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        credentials: 'omit'
      }).catch(function () { /* analytics must never surface an error */ });
    } catch (e) { /* ignore */ }
  }

  function schedule() {
    if (timer) return;
    timer = window.setTimeout(function () { timer = null; flush(false); }, FLUSH_MS);
  }

  function track(type, fields) {
    var ev = fields || {};
    ev.t = type;
    ev.p = PATH;
    ev.ts = Date.now();
    queue.push(ev);
    if (queue.length >= BATCH_SIZE) flush(false);
    else schedule();
  }

  // Expose a tiny manual API for one-off custom events.
  window.pjTrack = function (type, fields) { track(String(type), fields || {}); };

  /* ------------------------------------------------- Label resolution */
  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // Ordered fallback chain: explicit tag wins, CSS path is the last resort.
  function labelFor(el) {
    var tagged = el.closest('[data-track]');
    if (tagged) return clean(tagged.getAttribute('data-track'));

    // Only the element's own aria-label — closest() would climb to landmarks
    // like <nav aria-label="Primary"> and mislabel every link inside it.
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clean(aria);

    var text = clean(el.textContent);
    if (text) return text;

    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img) return clean(img.getAttribute('alt'));

    var titled = el.closest('[title]');
    if (titled) return clean(titled.getAttribute('title'));

    var a = el.closest('a[href]');
    if (a) return clean(a.getAttribute('href'));

    return cssPath(el);
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      var cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      if (cls) part += '.' + cls;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ').slice(0, 80);
  }

  function describe(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '?';
    var role = el.getAttribute && el.getAttribute('role');
    var type = el.getAttribute && el.getAttribute('type');
    return clean(tag + (type ? '[' + type + ']' : '') + (role ? '(' + role + ')' : ''));
  }

  /* --------------------------------------------------------- Pageview */
  track('pageview', { l: clean(document.title), h: location.href });

  /* ------------------------------------------------------------ Clicks */
  // Capture phase so we still see the click even if a handler stops bubbling.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest
      ? (e.target.closest('a, button, [role="button"], input, select, summary, [data-track]') || e.target)
      : e.target;
    if (!el || el.nodeType !== 1) return;

    var link = el.closest ? el.closest('a[href]') : null;
    var href = link ? link.getAttribute('href') : '';
    var abs = link ? link.href : '';

    var type = 'click';
    if (abs) {
      var isDownload = link.hasAttribute('download') || /\.(pdf|zip|docx?|pptx?|csv)$/i.test(abs);
      var isExternal = link.host && link.host !== location.host;
      if (isDownload) type = 'download';
      else if (isExternal) type = 'outbound';
      else if (href && href.charAt(0) === '#') type = 'anchor';
    }

    track(type, {
      l: labelFor(el),
      el: describe(el),
      h: abs || href || '',
      s: sectionOf(el)
    });

    // Leaving the page: get it out now rather than waiting for the timer.
    if (type === 'outbound' || type === 'download') flush(true);
  }, true);

  function sectionOf(el) {
    var sec = el.closest ? el.closest('section[id], [data-section]') : null;
    if (!sec) return '';
    return clean(sec.getAttribute('data-section') || sec.id);
  }

  /* ---------------------------------------------------- Section views */
  if ('IntersectionObserver' in window) {
    var seen = {};
    var secs = document.querySelectorAll('section[id], [data-section]');
    if (secs.length) {
      var sio = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var id = el.getAttribute('data-section') || el.id;
          if (!id || seen[id]) return;
          seen[id] = 1;
          sio.unobserve(el);
          track('section_view', { l: clean(id), s: clean(id) });
        });
      }, { threshold: 0.35 });
      Array.prototype.forEach.call(secs, function (s) { sio.observe(s); });
    }
  }

  /* ----------------------------------------------------- Scroll depth */
  var marks = [25, 50, 75, 100];
  var hit = {};
  var maxPct = 0;
  var ticking = false;

  function onScroll() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.round((window.scrollY / max) * 100) : 100;
    if (pct > maxPct) maxPct = Math.min(pct, 100);

    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (maxPct >= m && !hit[m]) {
        hit[m] = 1;
        track('scroll_depth', { l: m + '%', sc: m });
      }
    }
  }

  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () { onScroll(); ticking = false; });
  }, { passive: true });
  onScroll();

  /* --------------------------------------------------- Read-through
     Opt-in only. Matching bare <article> would fire on the home page, whose
     timeline entries are also <article> elements. */
  var article = document.querySelector('[data-article], .prose');
  if (article && 'IntersectionObserver' in window) {
    var end = document.createElement('div');
    end.setAttribute('aria-hidden', 'true');
    end.style.cssText = 'height:1px;width:100%;pointer-events:none;';
    article.appendChild(end);
    var rio = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      rio.disconnect();
      track('read_complete', { l: clean(document.title), ms: activeMs() });
    }, { threshold: 1 });
    rio.observe(end);
  }

  /* ------------------------------------------------- Engagement time
     Counts only time the tab is actually visible. */
  var activeSince = document.visibilityState === 'visible' ? Date.now() : 0;
  var activeTotal = 0;

  function activeMs() {
    return activeTotal + (activeSince ? Date.now() - activeSince : 0);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      activeSince = Date.now();
    } else {
      if (activeSince) { activeTotal += Date.now() - activeSince; activeSince = 0; }
      report();
      flush(true);
    }
  });

  /* --------------------------------------------------- Core Web Vitals */
  var vitals = { lcp: 0, cls: 0, inp: 0 };

  function observe(type, cb, opts) {
    try {
      var po = new PerformanceObserver(cb);
      po.observe(Object.assign({ type: type, buffered: true }, opts || {}));
      return po;
    } catch (e) { return null; }
  }

  observe('largest-contentful-paint', function (list) {
    var entries = list.getEntries();
    if (entries.length) vitals.lcp = entries[entries.length - 1].startTime;
  });

  observe('layout-shift', function (list) {
    list.getEntries().forEach(function (entry) {
      if (!entry.hadRecentInput) vitals.cls += entry.value;
    });
  });

  // Approximates INP by tracking the slowest interaction seen.
  observe('event', function (list) {
    list.getEntries().forEach(function (entry) {
      if (entry.interactionId && entry.duration > vitals.inp) vitals.inp = entry.duration;
    });
  }, { durationThreshold: 40 });

  /* -------------------------------------------------------- JS errors */
  var errCount = 0;
  window.addEventListener('error', function (e) {
    if (errCount++ > 5) return; // don't let a loop flood the dataset
    track('js_error', {
      l: clean(e.message || 'error'),
      d: clean((e.filename || '') + ':' + (e.lineno || 0)),
      v: 1
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (errCount++ > 5) return;
    track('js_error', { l: clean('unhandled rejection'), d: clean(String(e.reason)), v: 1 });
  });

  /* ---------------------------------------------------- Final report */
  var reported = false;
  function report() {
    if (reported) return;
    reported = true;
    track('engagement', { l: clean(document.title), ms: activeMs(), sc: maxPct });
    if (vitals.lcp) track('web_vital', { l: 'LCP', v: Math.round(vitals.lcp) });
    if (vitals.cls) track('web_vital', { l: 'CLS', v: Math.round(vitals.cls * 1000) / 1000 });
    if (vitals.inp) track('web_vital', { l: 'INP', v: Math.round(vitals.inp) });
  }

  // pagehide is the reliable end-of-page signal; unload is not.
  window.addEventListener('pagehide', function () { report(); flush(true); });
})();
