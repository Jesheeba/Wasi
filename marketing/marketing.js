// Wasi marketing site — small progressive-enhancement behaviors.
// No framework, no build step: plain DOM APIs only, matching the rest of this repo.

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  // Pricing cards + comparison table come from plans.js (single source).
  if (window.WasiPlans) {
    WasiPlans.renderPricing(document.getElementById('pricing-grid'), document.getElementById('compare-table'));
  }

  // Mobile nav: a class toggle (styling lives in marketing.css), no inline styles.
  const nav = document.querySelector('.site-nav');
  const toggle = document.getElementById('nav-toggle');
  if (nav && toggle) {
    const setOpen = (open) => {
      nav.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('nav-open')));
    nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  }

  // Only one FAQ item open at a time, for a tidier accordion feel.
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach((item) => {
    item.addEventListener('toggle', () => {
      if (item.open) {
        faqItems.forEach((other) => {
          if (other !== item) other.open = false;
        });
      }
    });
  });
});
