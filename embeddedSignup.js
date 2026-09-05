// Shared Meta WhatsApp Embedded Signup helper — loaded by both the onboarding
// wizard (marketing/signup.js) and the logged-in app's Settings > WhatsApp
// screen (app.js), so the FB SDK loading + postMessage handshake only exists
// once. See meta-tech-provider-platform-spec.md §3 step 3 for the flow this
// implements.
//
// 2026-09-05: 3 real clients lost their entire Coexistence signup attempt
// with zero trace anywhere in Wasi (see CLAUDE.md Known Gaps for the full
// investigation). Root cause confirmed against Meta's current published docs
// (developers.facebook.com/documentation/business-messaging/whatsapp/
// embedded-signup/onboarding-business-app-users/), not assumed: Meta spreads
// a Coexistence completion's identifying fields across MULTIPLE postMessage
// events — the terminal FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING event's own
// `data` only ever carries `waba_id`, never `phone_number_id` — but this
// file used to keep a single `lastMessage` variable, overwritten on every
// event, so the terminal message always clobbered an earlier session-log
// message that actually had the phone_number_id. Fixed by accumulating
// fields across every message instead of overwriting (see `sessionData`
// below). Diagnostic console logging is kept in deliberately, on top of the
// fix: this merge behavior is built from Meta's documented shape, not yet
// confirmed against a real live Coexistence attempt — do not remove the
// logging until that's verified.
(function () {
  let sdkReady = false;

  // Meta spreads a Coexistence completion's identifying fields across
  // MULTIPLE postMessage events, not one: sessionInfoVersion: '3' (below)
  // makes Meta fire session-log messages carrying phone_number_id as the
  // user progresses through the flow, but the terminal
  // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING event's own `data` only ever
  // carries `waba_id` (confirmed 2026-09-05 against Meta's current published
  // docs — see CLAUDE.md Known Gaps for the investigation). The previous
  // version of this file kept a single `lastMessage` variable, overwritten on
  // every event, so the terminal message always clobbered an earlier one that
  // had the phone_number_id — silently losing it on every real Coexistence
  // completion. `sessionData` accumulates every message's `data` fields
  // instead (a later message's fields augment, never clear, the running
  // total); `terminalEvent` separately tracks the most recent
  // FINISH/CANCEL/ERROR event name, since that's what actually decides when
  // to resolve/reject — it's a different concern from which fields have
  // arrived so far.
  let sessionData = {};
  let terminalEvent = null;

  // Coexistence completions fire a distinct event name, not plain FINISH —
  // per Meta's "Onboard WhatsApp Business app users" doc. Which one fired is
  // the only reliable signal for which path the business took, so it's
  // captured explicitly here and threaded through as via_coexistence rather
  // than left for the backend to infer from waba_id/phone_number_id shape
  // (nothing in that data reliably distinguishes the two paths). Hoisted to
  // module scope (was local to connect()) so the message listener below —
  // which needs to recognize a terminal event the moment it arrives, not
  // just when connect()'s polling loop next checks — can reference it too.
  const FINISH_EVENTS = {
    FINISH: false,
    FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: true,
  };

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
    // Diagnostic logging kept in deliberately (per direct instruction,
    // 2026-09-05) — the merge fix below is built on Meta's *documented*
    // shape, not yet confirmed against a real live attempt. Every raw
    // message, parsed or not, is logged so the next real Coexistence
    // completion can confirm phone_number_id really does arrive on an
    // earlier session-log message before this logging is ever removed.
    console.log('[WasiEmbeddedSignup] postMessage received from', event.origin, '— raw event.data:', event.data);
    let parsed;
    try {
      parsed = JSON.parse(event.data);
      console.log('[WasiEmbeddedSignup] parsed message:', JSON.stringify(parsed));
    } catch (err) {
      console.log('[WasiEmbeddedSignup] JSON.parse failed on this message (kept as a log only, not necessarily an error — could be an unrelated facebook.com message):', err.message);
      return;
    }
    if (parsed?.type !== 'WA_EMBEDDED_SIGNUP') return;
    // Merge, never replace — see sessionData's declaration above for why.
    if (parsed.data && typeof parsed.data === 'object') {
      Object.assign(sessionData, parsed.data);
    }
    if (parsed.event === 'CANCEL' || parsed.event === 'ERROR' || Object.prototype.hasOwnProperty.call(FINISH_EVENTS, parsed.event)) {
      terminalEvent = parsed.event;
    }
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
  // { code, waba_id, phone_number_id, via_coexistence }. waba_id/
  // phone_number_id can legitimately come back undefined on a genuine FINISH
  // (see the resolve branch below for why that's intentional, not a bug here).
  // Rejects with a message safe to show the user directly (cancelled / error
  // / no FINISH ever arriving are all distinguished).
  async function connect({ appId, configId, onProgress }) {
    await loadSdk(appId);
    sessionData = {};
    terminalEvent = null;

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

    for (let attemptsLeft = 10; attemptsLeft > 0; attemptsLeft--) {
      if (terminalEvent === 'CANCEL') throw new Error('Signup was cancelled in the Facebook popup.');
      if (terminalEvent === 'ERROR') throw new Error(`Facebook reported an error: ${sessionData.error_message || 'unknown error'}`);
      if (terminalEvent && Object.prototype.hasOwnProperty.call(FINISH_EVENTS, terminalEvent)) {
        // Resolve on FINISH even if waba_id/phone_number_id never showed up
        // in any message's data — deliberately NOT thrown here. Meta's own
        // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING payload only guarantees
        // waba_id, and this file has no way to write an audit trail of a
        // failure this far into the flow (no backend access from the
        // browser). The caller sends whatever it gets to
        // POST /whatsapp/connect regardless, and THAT route is what checks
        // for a missing phone_number_id, fails with a specific message, and
        // records it — the same audited failure path every other connect
        // error already goes through, so this class of failure is never
        // silent again (see onboarding.js and CLAUDE.md Known Gaps, 2026-09-05).
        return {
          code,
          waba_id: sessionData.waba_id,
          phone_number_id: sessionData.phone_number_id,
          via_coexistence: FINISH_EVENTS[terminalEvent],
        };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Got a login code from Facebook but no WhatsApp account details arrived. Please try again.');
  }

  window.WasiEmbeddedSignup = { connect };
})();
