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

  // Runs the full FB.login() + postMessage handshake, resolves
  // { code, waba_id, phone_number_id }. Rejects with a message safe to show
  // the user directly (cancelled / error / timeout are all distinguished).
  async function connect({ appId, configId }) {
    await loadSdk(appId);
    lastMessage = null;

    const code = await new Promise((resolve, reject) => {
      window.FB.login((response) => {
        if (!response?.authResponse?.code) {
          return reject(new Error('WhatsApp connection was not completed.'));
        }
        resolve(response.authResponse.code);
      }, {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      });
    });

    for (let attemptsLeft = 10; attemptsLeft > 0; attemptsLeft--) {
      if (lastMessage?.type === 'WA_EMBEDDED_SIGNUP') {
        if (lastMessage.event === 'FINISH' && lastMessage.data) {
          return { code, waba_id: lastMessage.data.waba_id, phone_number_id: lastMessage.data.phone_number_id };
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
