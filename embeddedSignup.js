// Shared Meta WhatsApp Embedded Signup helper — loaded by both the onboarding
// wizard (marketing/signup.js) and the logged-in app's Settings > WhatsApp
// screen (app.js), so the FB SDK loading + postMessage handshake only exists
// once. See meta-tech-provider-platform-spec.md §3 step 3 for the flow this
// implements; the postMessage payload shape and FB.login() config come from
// Meta's public Embedded Signup docs (best-effort — re-verify against a real
// Meta App before going live, same caveat as the original signup.js note).
(function () {
  let sdkReady = false;
  let lastMessage = null;

  function loadSdk(appId) {
    return new Promise((resolve, reject) => {
      if (sdkReady && window.FB) return resolve();
      window.fbAsyncInit = function fbAsyncInit() {
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: 'v20.0' });
        sdkReady = true;
        resolve();
      };
      if (!document.querySelector('script[data-wasi-fb-sdk]')) {
        const script = document.createElement('script');
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.dataset.wasiFbSdk = 'true';
        script.onerror = () => reject(new Error('Failed to load Facebook SDK'));
        document.head.appendChild(script);
      }
      setTimeout(() => { if (!sdkReady) reject(new Error('Timed out waiting for Facebook SDK')); }, 8000);
    });
  }

  window.addEventListener('message', (event) => {
    if (!event.origin || !event.origin.endsWith('facebook.com')) return;
    try { lastMessage = JSON.parse(event.data); } catch (_) { /* not ours */ }
  });

  // How long to wait for the FB.login popup to hand back a code before
  // giving up. Deliberately generous, not a typical request timeout: Meta's
  // own Coexistence docs say linking + initial history sync can legitimately
  // take "several minutes" for a number with a lot of chat history, and the
  // popup gives the user no feedback of its own while that's happening.
  // Without this, a stalled popup left the caller's UI spinning forever with
  // no way to tell a real failure from normal (if slow) syncing.
  const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

  // Reassures the user during the wait instead of leaving a bare spinner —
  // onProgress(message) is optional so callers without a status UI can omit it.
  const PROGRESS_STEPS = [
    { atMs: 15_000, message: 'Waiting for you to finish in the Facebook popup…' },
    { atMs: 60_000, message: 'Still connecting — if you scanned a QR code, this can take a few minutes while your chat history syncs. Keep the window open.' },
    { atMs: 180_000, message: 'Still waiting — larger chat histories can take several minutes to sync. Make sure your phone stays connected to the internet.' },
  ];

  // Runs the full FB.login() + postMessage handshake, resolves
  // { code, waba_id, phone_number_id }. Rejects with a message safe to show
  // the user directly (cancelled / error / timeout are all distinguished).
  async function connect({ appId, configId, onProgress }) {
    await loadSdk(appId);
    lastMessage = null;

    const timers = [];
    if (onProgress) {
      for (const step of PROGRESS_STEPS) {
        timers.push(setTimeout(() => onProgress(step.message), step.atMs));
      }
    }

    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const hardTimeout = setTimeout(() => {
          reject(new Error('Still not connected after 10 minutes. Please close the Facebook popup and try again — check that your phone has a stable internet connection.'));
        }, LOGIN_TIMEOUT_MS);
        timers.push(hardTimeout);

        window.FB.login((response) => {
          if (!response?.authResponse?.code) {
            return reject(new Error('WhatsApp connection was not completed.'));
          }
          resolve(response.authResponse.code);
        }, {
          config_id: configId,
          response_type: 'code',
          override_default_response_type: true,
          // featureType enables the Coexistence sub-flow (business keeps using
          // the WhatsApp Business app on their phone; Meta syncs history to the
          // Cloud API connection instead of migrating the number off the app).
          // An empty string here forces the plain migration flow for everyone,
          // even businesses who need to keep their app — see FINISH_* handling
          // below for why the two paths can't be told apart after the fact.
          extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
        });
      });
    } finally {
      timers.forEach(clearTimeout);
    }

    // Coexistence completions fire a distinct event name, not plain FINISH —
    // per Meta's "Onboard WhatsApp Business app users" doc. Which one fired
    // is the only reliable signal for which path the business took, so it's
    // captured explicitly here and threaded through as via_coexistence
    // rather than left for the backend to infer from waba_id/phone_number_id
    // shape (nothing in that data reliably distinguishes the two paths).
    const FINISH_EVENTS = {
      FINISH: false,
      FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: true,
    };

    for (let attemptsLeft = 10; attemptsLeft > 0; attemptsLeft--) {
      if (lastMessage?.type === 'WA_EMBEDDED_SIGNUP') {
        if (Object.prototype.hasOwnProperty.call(FINISH_EVENTS, lastMessage.event) && lastMessage.data) {
          return {
            code,
            waba_id: lastMessage.data.waba_id,
            phone_number_id: lastMessage.data.phone_number_id,
            via_coexistence: FINISH_EVENTS[lastMessage.event],
          };
        }
        if (lastMessage.event === 'CANCEL') throw new Error('Signup was cancelled in the Facebook popup.');
        if (lastMessage.event === 'ERROR') throw new Error(`Facebook reported an error: ${lastMessage.data?.error_message || 'unknown error'}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Got a login code from Facebook but no WhatsApp account details arrived. Please try again.');
  }

  window.WasiEmbeddedSignup = { connect };
})();
