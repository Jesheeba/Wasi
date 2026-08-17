// Wasi CRM marketing site — small progressive-enhancement behaviors.
// No framework, no build step: plain DOM APIs only, matching the rest of this repo.

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  // Mobile nav toggle: reveal the nav links as a dropdown under the bar.
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const isOpen = links.style.display === 'flex';
      links.style.display = isOpen ? 'none' : 'flex';
      if (!isOpen) {
        links.style.position = 'absolute';
        links.style.top = 'var(--header-height)';
        links.style.left = '0';
        links.style.right = '0';
        links.style.background = '#fff';
        links.style.flexDirection = 'column';
        links.style.padding = '16px 24px';
        links.style.borderBottom = '1px solid var(--border-light)';
        links.style.gap = '16px';
      }
    });
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
