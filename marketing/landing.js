// Wasi landing page — beat-reveal wiring. BEAT 1 SPIKE ONLY.
//
// One IntersectionObserver watches each .beat section as a whole (not each
// element inside it) — crossing the threshold adds .is-active once, and
// CSS (landing.css's .beat-reveal rules) handles all the internal
// sequencing via transition-delay on that single class. Revealed once,
// stays revealed on scroll-back-up — no re-animating every pass.
//
// The html.js class this depends on is added by an inline, non-deferred
// script in landing.html's <head> (before first paint) — not here — so
// there's never a flash of hidden content before this file has even
// loaded. See landing.css's own comment for why .beat-reveal defaults to
// fully visible until .js is present.
(function () {
  var beats = document.querySelectorAll('.beat');
  if (!('IntersectionObserver' in window) || !beats.length) return;

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-active');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.45 }
  );

  beats.forEach(function (beat) { observer.observe(beat); });
})();
