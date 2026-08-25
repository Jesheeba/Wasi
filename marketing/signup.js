// Wasi CRM — client onboarding wizard.
// Plain vanilla JS, no build step. Talks directly to the Express/Postgres
// backend documented in server/README.md.

(() => {
  // Same-origin in production (this page is served by the same Express
  // process as the API — see server/src/app.js); cross-port only in local
  // dev where static files run separately from the API on :4000.
  const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '4000')
    ? 'http://localhost:4000'
    : '';

  // Fallback only — overwritten by GET /api/billing/plans as soon as it
  // loads, so a pricing change in the plans table doesn't need a redeploy to
  // take effect in the actual checkout math (the static plan cards' marked-up
  // copy below is a separate, rarely-changed concern — this project has no
  // build step to template them from the same source).
  let PLAN_PRICING_INR = { Starter: 999, Growth: 2999, Scale: 7999 };

  const state = {
    step: 1,
    token: localStorage.getItem('client_token') || null,
    client: null,
    selectedPlan: null,
    subscription: null,
    checkoutOutcome: null, // 'success' | 'unconfigured' | 'error' | null
    onboardingConfig: null,
    wabaConnected: false,
    wabaSkipped: false,
  };

  // ---------------------------------------------------------------------
  // Small fetch helper
  // ---------------------------------------------------------------------
  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      const err = new Error('Could not reach the Wasi server. Is it running on http://localhost:4000?');
      err.networkError = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // Step indicator + step visibility
  // ---------------------------------------------------------------------
  function renderStepIndicator() {
    for (let i = 1; i <= 4; i++) {
      const dot = document.querySelector(`[data-dot="${i}"]`);
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    }
    for (let i = 1; i <= 3; i++) {
      const conn = document.querySelector(`[data-connector="${i}"]`);
      conn.classList.toggle('done', state.step > i);
    }
  }

  function goToStep(n) {
    state.step = n;
    document.querySelectorAll('.wizard-step').forEach((el) => {
      el.hidden = Number(el.dataset.step) !== n;
    });
    renderStepIndicator();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n === 3) initStep3();
    if (n === 4) renderDoneSummary();
  }

  // ---------------------------------------------------------------------
  // STEP 1 — Account creation
  // ---------------------------------------------------------------------
  function clearFieldErrors() {
    document.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
    document.querySelectorAll('#step1-form .form-input').forEach((el) => el.classList.remove('input-error'));
  }

  function showStep1Error(message) {
    const banner = document.getElementById('step1-error');
    banner.textContent = message;
    banner.classList.toggle('visible', Boolean(message));
  }

  function applyFieldError(fieldName, message) {
    const el = document.querySelector(`[data-error-for="${fieldName}"]`);
    const input = document.getElementById(fieldName);
    if (el) el.textContent = message;
    if (input) input.classList.add('input-error');
  }

  function initStep1() {
    const form = document.getElementById('step1-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors();
      showStep1Error('');

      const businessName = document.getElementById('businessName').value.trim();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;

      // Light client-side pre-check so obvious mistakes don't round-trip.
      let hasClientError = false;
      if (!businessName) { applyFieldError('businessName', 'Business name is required.'); hasClientError = true; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { applyFieldError('email', 'Enter a valid email address.'); hasClientError = true; }
      if (password.length < 8) { applyFieldError('password', 'Password must be at least 8 characters.'); hasClientError = true; }
      if (hasClientError) return;

      const submitBtn = document.getElementById('step1-submit');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner" style="border-color: rgba(255,255,255,0.5); border-top-color:#fff;"></span> Creating account…';

      try {
        const data = await api('/api/auth/register', {
          method: 'POST',
          auth: false,
          body: { businessName, email, password },
        });
        state.token = data.token;
        state.client = data.client;
        localStorage.setItem('client_token', data.token);
        localStorage.setItem('client_info', JSON.stringify(data.client));

        // Preselect a plan from ?plan= if the visitor arrived from a pricing card.
        const params = new URLSearchParams(window.location.search);
        const requestedPlan = params.get('plan');
        if (requestedPlan && PLAN_PRICING_INR[requestedPlan]) {
          selectPlan(requestedPlan);
        }

        goToStep(2);
      } catch (err) {
        if (err.status === 409) {
          applyFieldError('email', err.message);
          showStep1Error('That email is already registered. Try logging in instead.');
        } else if (err.status === 400 && err.body && Array.isArray(err.body.details)) {
          // zod validation issues: [{ path: ['email'], message: '...' }, ...]
          err.body.details.forEach((issue) => {
            const field = issue.path && issue.path[0];
            if (field) applyFieldError(field, issue.message);
          });
          showStep1Error('Please fix the highlighted fields.');
        } else {
          showStep1Error(err.message || 'Something went wrong creating your account. Please try again.');
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Continue <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      }
    });
  }

  // ---------------------------------------------------------------------
  // STEP 2 — Plan selection + Razorpay checkout
  // ---------------------------------------------------------------------
  function selectPlan(plan) {
    state.selectedPlan = plan;
    document.querySelectorAll('.plan-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.plan === plan);
    });
  }

  function setBanner(id, message, extraHtml) {
    const el = document.getElementById(id);
    if (!message) {
      el.classList.remove('visible');
      el.innerHTML = '';
      return;
    }
    el.classList.add('visible');
    el.innerHTML = `${extraHtml || ''}<span>${message}</span>`;
  }

  const infoIconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function revealStep2Next() {
    // Keep the checkout button visible (relabeled "Retry payment" in the
    // finally block below) so the user can retry, rather than hiding their
    // only way back into the payment flow.
    document.getElementById('step2-next-btn').hidden = false;
  }

  async function runCheckout() {
    if (!state.selectedPlan) {
      setBanner('step2-error', 'Pick a plan to continue.');
      return;
    }
    setBanner('step2-error', '');
    setBanner('step2-warn', '');
    setBanner('step2-info', '');

    const btn = document.getElementById('step2-checkout-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-color: rgba(255,255,255,0.5); border-top-color:#fff;"></span> Contacting payment provider…';

    try {
      const data = await api('/api/billing/checkout', {
        method: 'POST',
        body: { plan: state.selectedPlan },
      });
      state.subscription = data.subscription;

      if (!data.keyId) {
        // Backend created the order row but has no Razorpay key configured —
        // shouldn't normally happen since checkout throws first, but handle
        // it defensively rather than trying to open a broken widget.
        state.checkoutOutcome = 'unconfigured';
        setBanner('step2-warn', "Payment isn't fully configured in this environment yet — you can continue to test the WhatsApp connection step below.", infoIconSvg);
        revealStep2Next();
        return;
      }

      // Real integration path: load Razorpay Checkout.js and open it with
      // the order (one-off) or subscription (recurring, GAP_FIX_PLAN.md
      // Phase E4 — only reachable once a plan has a real razorpay_plan_id;
      // UNVERIFIED against a live account, see razorpayClient.js) details
      // the backend just created. Checkout.js takes subscription_id
      // instead of order_id/amount/currency for the recurring case — the
      // plan itself already encodes the amount and cadence.
      await loadScriptOnce('https://checkout.razorpay.com/v1/checkout.js');
      state.checkoutOutcome = 'opened';
      setBanner('step2-info', 'Complete payment in the popup to activate billing — or click Next below to continue testing without completing payment.', infoIconSvg);
      revealStep2Next();

      const isRecurring = Boolean(data.subscriptionId);
      const rzp = new window.Razorpay({
        key: data.keyId,
        ...(isRecurring
          ? { subscription_id: data.subscriptionId }
          : { order_id: data.razorpayOrderId, amount: data.amount, currency: data.currency }),
        name: 'Wasi CRM',
        description: `${state.selectedPlan} plan subscription`,
        prefill: { email: state.client && state.client.email, name: state.client && state.client.name },
        theme: { color: '#4AC959' },
        handler: () => {
          state.checkoutOutcome = 'success';
          setBanner('step2-info', 'Payment received. You can continue to connect WhatsApp.', infoIconSvg);
        },
        modal: {
          ondismiss: () => {
            if (state.checkoutOutcome !== 'success') {
              setBanner('step2-info', 'Payment window closed. You can retry payment or click Next to continue testing.', infoIconSvg);
            }
          },
        },
      });
      rzp.on('payment.failed', () => {
        setBanner('step2-warn', 'The payment attempt failed. You can retry, or click Next to continue testing without completing payment.', infoIconSvg);
      });
      rzp.open();
    } catch (err) {
      if (err.status === 502) {
        // Expected in this dev environment: no real Razorpay keys configured.
        state.checkoutOutcome = 'unconfigured';
        setBanner('step2-warn', "Payment isn't configured in this environment yet — you can continue to test the WhatsApp connection step below.", infoIconSvg);
        revealStep2Next();
      } else {
        state.checkoutOutcome = 'error';
        setBanner('step2-error', err.message || 'Checkout failed. Please try again.');
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Retry payment <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    }
  }

  function initStep2() {
    document.querySelectorAll('.plan-option').forEach((el) => {
      el.addEventListener('click', () => selectPlan(el.dataset.plan));
    });
    if (!state.selectedPlan) selectPlan('Growth'); // sensible default, matches "Most popular" on the landing page

    document.getElementById('step2-checkout-btn').addEventListener('click', runCheckout);
    document.getElementById('step2-next-btn').addEventListener('click', () => goToStep(3));
    document.querySelector('[data-back="1"]').addEventListener('click', () => goToStep(1));

    api('/api/billing/plans').then((plans) => {
      PLAN_PRICING_INR = Object.fromEntries(plans.map((p) => [p.id, p.price_inr]));
    }).catch(() => { /* keep the fallback defaults */ });
  }

  // ---------------------------------------------------------------------
  // STEP 3 — Connect WhatsApp (Meta Embedded Signup)
  // ---------------------------------------------------------------------
  let step3Initialized = false;

  function renderStep3Body(html) {
    document.getElementById('step3-body').innerHTML = html;
  }

  async function initStep3() {
    if (step3Initialized) return;
    step3Initialized = true;

    try {
      state.onboardingConfig = await api('/api/onboarding/config');
    } catch (err) {
      renderStep3Body(`
        <div class="connect-box">
          <div class="connect-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg></div>
          <h3>Couldn't check WhatsApp settings</h3>
          <p>${err.message || 'Please try again.'}</p>
          <button type="button" class="btn btn-secondary" id="step3-skip">Skip for now</button>
        </div>
      `);
      document.getElementById('step3-skip').addEventListener('click', () => {
        state.wabaSkipped = true;
        goToStep(4);
      });
      return;
    }

    if (!state.onboardingConfig.configured) {
      // Expected state in this dev environment: no real Meta app is wired up yet.
      renderStep3Body(`
        <div class="connect-box">
          <div class="connect-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg></div>
          <h3>WhatsApp connection isn't available yet</h3>
          <p>This platform's Meta App hasn't been configured (no <code>META_APP_ID</code>/<code>META_CONFIG_ID</code> set). Contact your platform admin to finish setup — your account and plan are already saved, so you won't lose progress.</p>
          <button type="button" class="btn btn-primary" id="step3-skip">
            Skip for now
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      `);
      document.getElementById('step3-skip').addEventListener('click', () => {
        state.wabaSkipped = true;
        goToStep(4);
      });
      return;
    }

    // configured === true: wire up the real Embedded Signup flow.
    renderStep3Body(`
      <div class="connect-box">
        <div class="connect-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
        <h3>Connect your WhatsApp Business Account</h3>
        <p>You'll log into your Facebook Business Manager in a popup and pick or create a WhatsApp Business Account. This takes about 2 minutes.</p>
        <div id="step3-status"></div>
        <button type="button" class="btn btn-primary" id="fb-connect-btn" disabled>
          <span class="spinner" style="border-color: rgba(255,255,255,0.5); border-top-color:#fff;"></span>
          Loading Facebook SDK…
        </button>
      </div>
      <p style="text-align:center;"><button type="button" class="btn-link" id="step3-skip-link">Skip for now</button></p>
    `);
    document.getElementById('step3-skip-link').addEventListener('click', () => {
      state.wabaSkipped = true;
      goToStep(4);
    });

    const connectBtn = document.getElementById('fb-connect-btn');
    connectBtn.disabled = false;
    connectBtn.innerHTML = 'Connect WhatsApp Business Account';
    connectBtn.addEventListener('click', () => startEmbeddedSignup(state.onboardingConfig));
  }

  // Uses the shared window.WasiEmbeddedSignup helper (embeddedSignup.js) —
  // same FB SDK load + postMessage handshake the logged-in app's
  // Settings > WhatsApp screen uses, so this logic only exists once.
  async function startEmbeddedSignup({ appId, configId }) {
    const statusEl = document.getElementById('step3-status');
    statusEl.innerHTML = '<div class="status-pill pending">Waiting for Facebook popup…</div>';
    try {
      const { code, waba_id, phone_number_id, via_coexistence } = await window.WasiEmbeddedSignup.connect({ appId, configId });
      await completeWhatsAppConnect(code, { waba_id, phone_number_id, via_coexistence });
    } catch (err) {
      statusEl.innerHTML = `<div class="status-pill error">${err.message}</div>`;
    }
  }

  async function completeWhatsAppConnect(code, { waba_id, phone_number_id, via_coexistence }) {
    const statusEl = document.getElementById('step3-status');
    statusEl.innerHTML = '<div class="status-pill pending">Finishing setup on our side…</div>';
    try {
      const data = await api('/api/onboarding/whatsapp/connect', {
        method: 'POST',
        body: { code, waba_id, phone_number_id, via_coexistence },
      });
      state.wabaConnected = true;
      statusEl.innerHTML = `<div class="status-pill success">Connected: ${(data.waba && data.waba.display_name) || phone_number_id}</div>`;
      document.getElementById('step3-next-btn').hidden = false;
    } catch (err) {
      // Expected failure mode in this dev environment: 502 because
      // META_APP_ID/META_APP_SECRET aren't set for a real Meta app.
      statusEl.innerHTML = `<div class="status-pill error">${(err.body && err.body.error) || err.message}${err.body && err.body.hint ? ` — ${err.body.hint}` : ''}</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // STEP 4 — Done
  // ---------------------------------------------------------------------
  function renderDoneSummary() {
    const wabaLine = state.wabaConnected
      ? 'Connected'
      : (state.wabaSkipped ? 'Skipped — connect later from Settings' : 'Not connected');
    const paymentLine = state.checkoutOutcome === 'success'
      ? 'Paid'
      : (state.checkoutOutcome === 'unconfigured' ? 'Not configured in this environment' : 'Pending');

    document.getElementById('done-summary').innerHTML = `
      <div class="row"><span class="lbl">Business</span><span class="val">${(state.client && state.client.name) || '—'}</span></div>
      <div class="row"><span class="lbl">Email</span><span class="val">${(state.client && state.client.email) || '—'}</span></div>
      <div class="row"><span class="lbl">Plan</span><span class="val">${state.selectedPlan || '—'} (₹${PLAN_PRICING_INR[state.selectedPlan] || '—'}/mo)</span></div>
      <div class="row"><span class="lbl">Payment</span><span class="val">${paymentLine}</span></div>
      <div class="row"><span class="lbl">WhatsApp</span><span class="val">${wabaLine}</span></div>
    `;
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) lucide.createIcons();
    initStep1();
    initStep2();
    document.querySelector('[data-back="2"]').addEventListener('click', () => goToStep(2));
    document.getElementById('step3-next-btn').addEventListener('click', () => goToStep(4));

    // If already logged in from an earlier attempt in this browser, skip step 1.
    const savedClient = localStorage.getItem('client_info');
    if (state.token && savedClient) {
      try {
        state.client = JSON.parse(savedClient);
        goToStep(2);
      } catch (_) { /* ignore malformed cache */ }
    }

    renderStepIndicator();
  });
})();
