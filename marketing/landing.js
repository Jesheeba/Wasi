// Wasi landing page — restrained scroll motion. Hover states are pure CSS
// (landing.css); this file only handles the gentle on-scroll fade-in.
//
// Two mechanisms, not one, and this is deliberate, not belt-and-suspenders
// for its own sake: an IntersectionObserver alone is not reliable here.
// Confirmed empirically (not assumed) while building this page: a single
// fast scroll straight to the bottom (a real mouse-wheel jump, simulating
// pressing End or a fast trackpad fling) can move the viewport from above
// a .fade-in element to below it inside one rendering step — the element's
// intersection state never crosses the observed threshold, so the
// observer's callback never fires for it at all, and it stays opacity:0
// forever. On this page's real length, a first test of this left 24 of 30
// sections permanently blank after one fast scroll to the bottom.
//
// The fix: a throttled scroll listener acts as a correctness safety net
// alongside the observer — the observer handles the common case
// (efficient, no per-scroll work for most visitors), while the scroll
// listener catches anything the observer missed, by directly checking
// each remaining element's current position rather than relying on
// threshold-crossing detection.
//
// The html.js class this depends on is added by an inline, non-deferred
// script in landing.html's <head> (before first paint), not here — so
// there's never a flash of hidden content before this file has even
// loaded. See landing.css's own comment on .fade-in for why it defaults to
// fully visible until .js is present.
(function () {
  var pending = Array.prototype.slice.call(document.querySelectorAll('.fade-in'));
  if (!pending.length) return;

  function reveal(el) {
    el.classList.add('is-visible');
    var i = pending.indexOf(el);
    if (i !== -1) pending.splice(i, 1);
  }

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            reveal(entry.target);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    pending.slice().forEach(function (el) { observer.observe(el); });
  }

  // Catch-up pass: anything still pending whose top edge has already
  // reached or passed the viewport's bottom edge gets revealed directly —
  // this is what saves an element the observer jumped past. Throttled to
  // once per animation frame regardless of how many scroll events fire.
  var ticking = false;
  function catchUp() {
    ticking = false;
    if (!pending.length) return;
    pending.slice().forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) reveal(el);
    });
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(catchUp);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  // Also catch anything already at/above the fold on load, before any
  // scroll event has fired at all.
  catchUp();
})();
