// Wasi marketing — the ONE place plan names, prices and feature copy live for
// the public site (landing pricing cards + comparison table, and the signup
// wizard's plan picker). Checkout math in signup.js still overrides prices from
// GET /api/billing/plans once the visitor is logged in; this is the static
// copy shown before that call is possible (the endpoint needs client auth).
(function () {
  var CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';

  var PLANS = [
    {
      id: 'Starter', target: 'Solo & small business', price: 999,
      note: '1 WABA number · 500 conversations/mo', signupDesc: '1 number · 500 conversations/mo',
      features: ['1 WhatsApp number', '500 conversations / month', 'Shared chat inbox', 'Contacts & CRM', 'Basic keyword automation'],
    },
    {
      id: 'Growth', target: 'Growing SMB', price: 2999, featured: true,
      note: '1 WABA number · 3,000 conversations/mo',
      signupDesc: '1 number · 3,000 conversations/mo · campaigns, templates, analytics',
      features: ['Everything in Starter', '3,000 conversations / month', 'Broadcast campaigns', 'Message templates & tags', 'Analytics dashboard'],
    },
    {
      id: 'Scale', target: 'Agencies & larger teams', price: 7999,
      note: 'Multiple numbers · unlimited conversations*',
      signupDesc: 'Multiple numbers · unlimited conversations* · team seats, API access',
      features: ['Everything in Growth', 'Multiple WABA numbers', 'Unlimited conversations*', 'Team seats & roles', 'API access & priority support'],
    },
  ];

  var COMPARE = [
    ['WhatsApp numbers', '1', '1', 'Multiple'],
    ['Conversations / month', '500', '3,000', 'Unlimited*'],
    ['Chat inbox', 1, 1, 1],
    ['Contacts & CRM', 1, 1, 1],
    ['Basic automation', 1, 1, 1],
    ['Broadcast campaigns', 0, 1, 1],
    ['Templates & tags', 0, 1, 1],
    ['Analytics dashboard', 0, 1, 1],
    ['Team seats', 0, 0, 1],
    ['API access', 0, 0, 1],
    ['Priority support', 0, 0, 1],
  ];

  function fmt(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

  function renderPricing(grid, table) {
    if (grid) {
      grid.innerHTML = PLANS.map(function (p) {
        var cta = p.featured ? 'btn-primary' : 'btn-secondary';
        return '<div class="price-card' + (p.featured ? ' featured' : '') + '">' +
          (p.featured ? '<span class="price-badge">Most popular</span>' : '') +
          '<h3>' + p.id + '</h3>' +
          '<div class="price-target">' + p.target.replace('&', '&amp;') + '</div>' +
          '<div class="price-amount"><span class="amt">' + fmt(p.price) + '</span><span class="per">/ month</span></div>' +
          '<div class="price-note">' + p.note + '</div>' +
          '<ul class="price-features">' + p.features.map(function (f) { return '<li>' + CHECK + f.replace('&', '&amp;') + '</li>'; }).join('') + '</ul>' +
          '<a href="/marketing/signup.html?plan=' + p.id + '" class="btn ' + cta + ' btn-block">Start Free Trial</a>' +
          '</div>';
      }).join('');
    }
    if (table) {
      table.innerHTML = '<thead><tr><th>Feature</th>' + PLANS.map(function (p) { return '<th>' + p.id + '</th>'; }).join('') + '</tr></thead><tbody>' +
        COMPARE.map(function (r) {
          return '<tr><td>' + r[0] + '</td>' + r.slice(1).map(function (v) {
            if (v === 1) return '<td class="yes">✓</td>';
            if (v === 0) return '<td>—</td>';
            return '<td>' + v + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody>';
    }
  }

  function renderSignupOptions(container) {
    if (!container) return;
    container.innerHTML = PLANS.map(function (p) {
      return '<label class="plan-option" data-plan="' + p.id + '">' +
        '<div class="plan-option-main"><span class="radio"></span><div>' +
        '<div class="plan-option-name">' + p.id + '</div>' +
        '<div class="plan-option-desc">' + p.signupDesc + '</div></div></div>' +
        '<div class="plan-option-price">' + fmt(p.price) + '<small>/mo</small></div></label>';
    }).join('');
  }

  window.WasiPlans = { plans: PLANS, renderPricing: renderPricing, renderSignupOptions: renderSignupOptions };
})();
