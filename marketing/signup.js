// Wasi CRM - client onboarding wizard.
// Plain vanilla JS, no build step. Talks directly to the Express/Postgres
// backend documented in server/README.md.

(() => {
  // Same-origin in production (this page is served by the same Express
  // process as the API - see server/src/app.js); cross-port only in local
  // dev where static files run separately from the API on :4000.
  const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '4000')
    ? 'http://localhost:4000'
    : '';

  // Fallback only - overwritten by GET /api/billing/plans as soon as it
  // loads, so a pricing change in the plans table doesn't need a redeploy to
  // take effect in the actual checkout math (the static plan cards' marked-up
  // copy below is a separate, rarely-changed concern - this project has no
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
  async function api(path, { method = 'GET', body, auth = true, timeoutMs = 45_000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (networkErr) {
      if (networkErr.name === 'TimeoutError' || networkErr.name === 'AbortError') {
        const err = new Error('Request timed out. Please check your connection and try again.');
        err.networkError = true;
        throw err;
      }
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
  // STEP 1 - Account creation
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

  // Shared by email signup and "Continue with Google": store the session and
  // move on to choosing a plan.
  function afterAccountCreated(data) {
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
  }

  // ---------------------------------------------------------------------
  // "Continue with Google" (build-docs/features/google-login.md)
  // A Google sign-in that arrives before the business name is typed is held
  // here; the main button then finishes the signup with it.
  // ---------------------------------------------------------------------
  let pendingGoogleCredential = null;

  function setSubmitLabel(html) {
    document.getElementById('step1-submit').innerHTML = html;
  }
  const CONTINUE_HTML = 'Continue <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  async function finishWithGoogle(credential, businessName) {
    const submitBtn = document.getElementById('step1-submit');
    submitBtn.disabled = true;
    setSubmitLabel('<span class="spinner" style="border-color: rgba(255,255,255,0.5); border-top-color:#fff;"></span> Creating account…');
    try {
      const data = await api('/api/auth/google', { method: 'POST', auth: false, body: { credential, intent: 'signup', businessName } });
      pendingGoogleCredential = null;
      if (data.created === false) {
        // This Google account already has a Wasi account: just sign them in.
        localStorage.setItem('client_token', data.token);
        window.location.href = '/app';
        return;
      }
      afterAccountCreated(data);
    } catch (err) {
      pendingGoogleCredential = null; // a fresh sign-in is needed after any failure
      setGoogleMode(false);
      showStep1Error(err.message || 'Google sign-in failed. Please try again.');
    } finally {
      submitBtn.disabled = false;
      setSubmitLabel(pendingGoogleCredential ? 'Finish with Google' : CONTINUE_HTML);
    }
  }

  // The email inside Google's sign-in token, for display only - the server
  // verifies the token itself before creating anything.
  function googleEmail(credential) {
    try {
      const part = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part)))).email || '';
    } catch (_) { return ''; }
  }

  // Signed in with Google: the email comes from Google and the password is
  // not needed, so lock the one and hide the other.
  function setGoogleMode(on, email) {
    const emailInput = document.getElementById('email');
    emailInput.readOnly = on;
    if (on && email) emailInput.value = email;
    if (!on) emailInput.value = '';
    document.getElementById('password-group').hidden = on;
  }

  function onGoogleCredential(credential) {
    clearFieldErrors();
    showStep1Error('');
    setGoogleMode(true, googleEmail(credential));
    const businessName = document.getElementById('businessName').value.trim();
    if (!businessName) {
      pendingGoogleCredential = credential;
      setSubmitLabel('Finish with Google');
      applyFieldError('businessName', 'Signed in with Google. Enter your business name to finish.');
      document.getElementById('businessName').focus();
      return;
    }
    finishWithGoogle(credential, businessName);
  }

  async function initGoogleSignIn() {
    let clientId = null;
    try {
      ({ clientId } = await api('/api/auth/google/config', { auth: false, timeoutMs: 8000 }));
    } catch (_) { return; } // Google sign-in is optional: email signup still works
    if (!clientId) return;
    // The Google script loads async; wait for it briefly.
    for (let i = 0; i < 50 && !(window.google && google.accounts && google.accounts.id); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!(window.google && google.accounts && google.accounts.id)) return;
    google.accounts.id.initialize({ client_id: clientId, callback: (r) => onGoogleCredential(r.credential), ux_mode: 'popup' });
    google.accounts.id.renderButton(document.getElementById('google-signin-button'), {
      theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 320,
    });
    document.getElementById('google-signin').hidden = false;
  }

  // The CRM login page sends a Google sign-in here when that Google account
  // has no Wasi account yet, so the visitor doesn't sign in twice. Read once.
  function takeHandedOverGoogleCredential() {
    let credential = null;
    try {
      credential = sessionStorage.getItem('wasi_google_signup_credential');
      sessionStorage.removeItem('wasi_google_signup_credential');
    } catch (_) { /* storage unavailable */ }
    if (credential) onGoogleCredential(credential);
  }

  function initStep1() {
    const form = document.getElementById('step1-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors();
      showStep1Error('');

      if (pendingGoogleCredential) {
        const name = document.getElementById('businessName').value.trim();
        if (!name) { applyFieldError('businessName', 'Business name is required.'); return; }
        await finishWithGoogle(pendingGoogleCredential, name);
        return;
      }

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
        afterAccountCreated(data);
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
  // STEP 2 - Plan selection + Razorpay checkout
  // ---------------------------------------------------------------------
  function selectPlan(plan) {
    if (state.couponCode && plan !== state.selectedPlan) setCouponStatus('', false); // a coupon is checked per plan
    state.selectedPlan = plan;
    document.querySelectorAll('.plan-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.plan === plan);
    });
  }

  // Coupon - checked by the server (POST /api/billing/coupon, the same lookup
  // checkout uses), so the price shown can't drift from what is charged.
  function setCouponStatus(message, ok) {
    if (!ok) state.couponCode = null;
    const el = document.getElementById('coupon-status');
    if (!el) return;
    el.textContent = message;
    el.className = `coupon-status${message ? (ok ? ' ok' : ' bad') : ''}`;
  }

  async function applyCoupon() {
    const code = document.getElementById('coupon-code').value.trim();
    if (!code) { setCouponStatus('Enter a coupon code.', false); return; }
    if (!state.selectedPlan) { setCouponStatus('Pick a plan first.', false); return; }
    const btn = document.getElementById('coupon-apply-btn');
    btn.disabled = true;
    try {
      const r = await api('/api/billing/coupon', { method: 'POST', body: { plan: state.selectedPlan, couponCode: code } });
      state.couponCode = r.couponApplied;
      setCouponStatus(`Coupon ${r.couponApplied} applied: ₹${r.amountInr}/month instead of ₹${r.originalAmountInr}.`, true);
    } catch (err) {
      setCouponStatus(err.message || 'Invalid coupon code.', false);
    } finally {
      btn.disabled = false;
    }
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

  // Next is only offered once the payment is confirmed: an unpaid account is
  // blocked server-side (services/serviceAccess.js), so there is nothing to
  // continue to. See build-docs/features/unpaid-signup-block.md.
  function revealStep2Next() {
    document.getElementById('step2-next-btn').hidden = false;
  }

  // Razorpay's success callback -> server-side signature check -> account
  // unblocked at once, without waiting for the webhook.
  async function confirmPayment(response) {
    setBanner('step2-warn', '');
    setBanner('step2-info', 'Confirming your payment…', infoIconSvg);
    try {
      await api('/api/billing/verify-payment', { method: 'POST', body: response });
      state.checkoutOutcome = 'success';
      setBanner('step2-info', 'Payment received. Next, connect WhatsApp.', infoIconSvg);
      revealStep2Next();
      document.getElementById('step2-checkout-btn').hidden = true;
    } catch (err) {
      setBanner('step2-info', '');
      setBanner('step2-warn', `We could not confirm the payment yet (${err.message}). If you were charged, it will be confirmed automatically within a few minutes - reload this page, or contact support@sirahdigital.in.`, infoIconSvg);
    }
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
        body: state.couponCode ? { plan: state.selectedPlan, couponCode: state.couponCode } : { plan: state.selectedPlan },
      });
      state.subscription = data.subscription;

      if (!data.keyId) {
        // Backend created the order row but has no Razorpay key configured -
        // shouldn't normally happen since checkout throws first, but handle
        // it defensively rather than trying to open a broken widget.
        state.checkoutOutcome = 'unconfigured';
        setBanner('step2-warn', "Payment isn't available right now, so your account can't be activated yet. Please try again later or contact support@sirahdigital.in.", infoIconSvg);
        return;
      }

      // Real integration path: load Razorpay Checkout.js and open it with
      // the order details the backend just created.
      await loadScriptOnce('https://checkout.razorpay.com/v1/checkout.js');
      state.checkoutOutcome = 'opened';
      setBanner('step2-info', 'Complete payment in the popup to activate your account.', infoIconSvg);

      const rzp = new window.Razorpay({
        key: data.keyId,
        order_id: data.razorpayOrderId,
        amount: data.amount,
        currency: data.currency,
        name: 'Wasi CRM',
        description: `${state.selectedPlan} plan subscription${data.couponApplied ? ` (coupon ${data.couponApplied})` : ''}`,
        prefill: { email: state.client && state.client.email, name: state.client && state.client.name },
        theme: { color: '#4AC959' },
        handler: (response) => { confirmPayment(response); },
        modal: {
          ondismiss: () => {
            if (state.checkoutOutcome !== 'success') {
              setBanner('step2-info', 'Payment window closed. Your account is activated once payment is complete - click Retry payment.', infoIconSvg);
            }
          },
        },
      });
      rzp.on('payment.failed', () => {
        setBanner('step2-warn', 'The payment attempt failed. Please retry payment.', infoIconSvg);
      });
      rzp.open();
    } catch (err) {
      if (err.status === 502) {
        // Expected in this dev environment: no real Razorpay keys configured.
        state.checkoutOutcome = 'unconfigured';
        setBanner('step2-warn', "Payment isn't available right now, so your account can't be activated yet. Please try again later or contact support@sirahdigital.in.", infoIconSvg);
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
    document.getElementById('coupon-apply-btn').addEventListener('click', applyCoupon);
    document.getElementById('coupon-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); }
    });
    document.getElementById('coupon-code').addEventListener('input', () => {
      if (state.couponCode) setCouponStatus('', false); // edited after applying: apply again
    });
    document.getElementById('step2-next-btn').addEventListener('click', () => goToStep(3));
    document.querySelector('[data-back="1"]').addEventListener('click', () => goToStep(1));

    api('/api/billing/plans').then((plans) => {
      PLAN_PRICING_INR = Object.fromEntries(plans.map((p) => [p.id, p.price_inr]));
    }).catch(() => { /* keep the fallback defaults */ });
  }

  // ---------------------------------------------------------------------
  // STEP 3 - Connect WhatsApp (Meta Embedded Signup)
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
          <p>This platform's Meta App hasn't been configured (no <code>META_APP_ID</code>/<code>META_CONFIG_ID</code> set). Contact your platform admin to finish setup - your account and plan are already saved, so you won't lose progress.</p>
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

  // Uses the shared window.WasiEmbeddedSignup helper (embeddedSignup.js) -
  // same FB SDK load + postMessage handshake the logged-in app's
  // Settings > WhatsApp screen uses, so this logic only exists once.
  async function startEmbeddedSignup({ appId, configId }) {
    const statusEl = document.getElementById('step3-status');
    statusEl.innerHTML = '<div class="status-pill pending">Waiting for Facebook popup…</div>';
    try {
      const { code, waba_id, phone_number_id, via_coexistence } = await window.WasiEmbeddedSignup.connect({
        appId,
        configId,
        onProgress: (message) => {
          statusEl.innerHTML = `<div class="status-pill pending">${message}</div>`;
        },
      });
      await completeWhatsAppConnect(code, { waba_id, phone_number_id, via_coexistence });
    } catch (err) {
      // PLAN.md item 25, Part B - embeddedSignup.js marks the "FINISH
      // arrived, the OAuth code never did" race with err.incomplete instead
      // of a plain rejection. Record it as its own state rather than
      // showing the same generic failure a real non-attempt would - Meta
      // really did link the account on its side.
      if (err.incomplete) {
        try {
          await api('/api/onboarding/whatsapp/connect-incomplete', {
            method: 'POST',
            body: { waba_id: err.waba_id },
          });
          statusEl.innerHTML = `<div class="status-pill error">${err.message}</div>`;
        } catch (recordErr) {
          // Fixed 2026-09-07 - this used to be console.error'd into
          // silence. This is the worst case in the whole flow: Meta linked
          // the account AND we failed to even record that fact - if this is
          // swallowed too, there is zero trace anywhere, browser or server,
          // exactly the failure class this item exists to close. Unlike
          // app.js's toast (which auto-dismisses in 2.2s), this status pill
          // stays on screen until the user navigates away, so it's loud
          // enough here without needing a blocking alert() too - but the
          // WABA ID must actually be in it for a support contact to be useful.
          console.error('Failed to record incomplete WhatsApp connection:', recordErr.message);
          statusEl.innerHTML = `<div class="status-pill error">Meta linked your WhatsApp account, but we also failed to record that on our end - nothing was saved automatically. Please contact support with this WhatsApp Business Account ID: <strong>${err.waba_id}</strong></div>`;
        }
        return;
      }
      statusEl.innerHTML = `<div class="status-pill error">${err.message}</div>`;
    }
  }

  async function completeWhatsAppConnect(code, { waba_id, phone_number_id, via_coexistence }) {
    const statusEl = document.getElementById('step3-status');
    // Real progress instead of a silent "Finishing setup…" the whole time -
    // 2026-09-08: server-side discovery (debug_token, phone number
    // enumeration, webhook subscription, registration, template sync) is
    // now the primary path and can genuinely take several seconds.
    statusEl.innerHTML = '<div class="status-pill pending">Finishing setup on our side…</div>';
    const serverProgressTimers = [
      setTimeout(() => { statusEl.innerHTML = '<div class="status-pill pending">Verifying your account with Meta…</div>'; }, 3000),
      setTimeout(() => { statusEl.innerHTML = '<div class="status-pill pending">Finding your WhatsApp number…</div>'; }, 8000),
      setTimeout(() => { statusEl.innerHTML = '<div class="status-pill pending">Still working - almost done…</div>'; }, 15000),
    ];
    try {
      const data = await api('/api/onboarding/whatsapp/connect', {
        method: 'POST',
        body: { code, waba_id, phone_number_id, via_coexistence },
        timeoutMs: 90_000,
      });
      serverProgressTimers.forEach(clearTimeout);
      state.wabaConnected = true;
      statusEl.innerHTML = `<div class="status-pill success">Connected: ${(data.waba && data.waba.display_name) || phone_number_id}</div>`;
      document.getElementById('step3-next-btn').hidden = false;
    } catch (err) {
      serverProgressTimers.forEach(clearTimeout);
      // onboarding.js's /whatsapp/connect always puts the SPECIFIC reason in
      // body.detail, with a generic body.error as the top-level summary (see
      // that route's catch block) - this used to show only the generic
      // string, so a real rejection (e.g. the new missing-phone_number_id
      // case, 2026-09-05) read as a content-free "WhatsApp connection
      // failed" with no way to tell what actually happened. Preferring
      // body.detail surfaces the actual reason instead.
      statusEl.innerHTML = `<div class="status-pill error">${(err.body && (err.body.detail || err.body.error)) || err.message}${err.body && err.body.hint ? ` - ${err.body.hint}` : ''}</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // STEP 4 - Done
  // ---------------------------------------------------------------------
  function renderDoneSummary() {
    const wabaLine = state.wabaConnected
      ? 'Connected'
      : (state.wabaSkipped ? 'Skipped - connect later from Settings' : 'Not connected');
    const paymentLine = state.checkoutOutcome === 'success'
      ? 'Paid'
      : (state.checkoutOutcome === 'unconfigured' ? 'Not configured in this environment' : 'Pending');

    document.getElementById('done-summary').innerHTML = `
      <div class="row"><span class="lbl">Business</span><span class="val">${(state.client && state.client.name) || '-'}</span></div>
      <div class="row"><span class="lbl">Email</span><span class="val">${(state.client && state.client.email) || '-'}</span></div>
      <div class="row"><span class="lbl">Plan</span><span class="val">${state.selectedPlan || '-'} (₹${PLAN_PRICING_INR[state.selectedPlan] || '-'}/mo)</span></div>
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
    initGoogleSignIn();
    takeHandedOverGoogleCredential();
    initStep2();
    document.querySelector('[data-back="2"]').addEventListener('click', () => goToStep(2));
    document.getElementById('step3-next-btn').addEventListener('click', () => goToStep(4));

    // If already logged in from an earlier attempt in this browser, skip step 1
    // - and step 2 too once the account is paid.
    const savedClient = localStorage.getItem('client_info');
    if (state.token && savedClient) {
      try {
        state.client = JSON.parse(savedClient);
        goToStep(2);
        api('/api/auth/me').then((client) => {
          state.client = client;
          if (client.status === 'payment_confirmed' || client.status === 'active') {
            state.checkoutOutcome = 'success';
            goToStep(3);
          }
        }).catch(() => { /* stay on the plan step */ });
      } catch (_) { /* ignore malformed cache */ }
    }

    renderStepIndicator();
  });
})();
