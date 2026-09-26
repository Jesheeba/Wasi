// Instagram DM Automation, Phase 1 — Facebook Login for Business handshake
// for linking a Facebook Page (and its connected Instagram professional
// account) to Wasi. Sibling to embeddedSignup.js, not a parameter to it:
// that file's entire complexity (accumulating postMessage fields, a FINISH/
// CANCEL/ERROR terminal-event listener, a multi-minute Coexistence QR-sync
// wait) exists because WhatsApp's Embedded Signup wizard reports its own
// completion asynchronously via postMessage, sometimes without ever
// delivering the ids this app needs. Instagram/Page linking has no such
// wizard — FB.login() with a dedicated config_id (META_IG_CONFIG_ID, a
// separate Facebook Login for Business configuration scoped to Page/
// Instagram permissions) returns an authorization code directly through its
// own callback; GET /me/accounts (server-side, instagramClient.listManagedPages)
// is what resolves which Page/Instagram account got linked, same as this
// app's WhatsApp discovery moved server-side.
//
// Requires Meta App Review approval for the Page/Instagram scopes on
// META_IG_CONFIG_ID before a real (non-developer-role) account can complete
// this — see CLAUDE.md.
(function () {
  let sdkReady = Boolean(window.FB);

  function loadSdk(appId) {
    return new Promise((resolve, reject) => {
      if (sdkReady && window.FB) return resolve();
      // Shares embeddedSignup.js's script tag (same data-wasi-fb-sdk marker)
      // if that file already injected one — never loads/inits the SDK twice.
      if (window.FB) {
        sdkReady = true;
        return resolve();
      }
      window.fbAsyncInit = function fbAsyncInit() {
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: 'v25.0' });
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

  const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

  // Resolves { code }. Rejects with a message safe to show the user
  // directly.
  async function connect({ appId, configId }) {
    await loadSdk(appId);

    return new Promise((resolve, reject) => {
      const hardTimeout = setTimeout(() => {
        reject(new Error('Still not connected after 2 minutes. Please try again.'));
      }, LOGIN_TIMEOUT_MS);

      window.FB.login((response) => {
        clearTimeout(hardTimeout);
        if (!response?.authResponse?.code) {
          if (response?.status === 'not_authorized') {
            return reject(new Error('Facebook says this account is not authorized to link this Page/Instagram account — an Admin role on the Meta Business Manager that owns the Page is usually required.'));
          }
          return reject(new Error('Instagram connection was not completed.'));
        }
        resolve({ code: response.authResponse.code });
      }, {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        auth_type: 'reauthenticate',
      });
    });
  }

  window.WasiInstagramSignup = { connect };
})();
