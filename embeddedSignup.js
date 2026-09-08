// Shared Meta WhatsApp Embedded Signup helper — loaded by both the onboarding
// wizard (marketing/signup.js) and the logged-in app's Settings > WhatsApp
// screen (app.js), so the FB SDK loading + postMessage handshake only exists
// once. See meta-tech-provider-platform-spec.md §3 step 3 for the flow this
// implements.
//
// 2026-09-05: 3 real clients lost their entire Coexistence signup attempt
// with zero trace anywhere in Wasi (see CLAUDE.md Known Gaps for the full
// investigation). Original root cause theory: Meta spreads a Coexistence
// completion's identifying fields across MULTIPLE postMessage events, with
// an earlier "session-log" message carrying phone_number_id ahead of the
// terminal FINISH event. Fixed at the time by accumulating fields across
// every message instead of overwriting (see `sessionData` below), rather
// than keeping a single `lastMessage` that the terminal event would clobber.
//
// CORRECTED 2026-09-07 (see CLAUDE.md Known Gaps — this session's Embedded
// Signup v4 migration): re-verified directly against Meta's CURRENT
// Coexistence doc and found the original theory was never quite right —
// there is no session-log event, and no message-spreading. Under v4,
// FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING is the ONLY event this flow ever
// fires, and its `data` deliberately carries `waba_id` alone —
// `phone_number_id` is never sent via postMessage at all, by design (the
// number is already registered on the WhatsApp Business app; Meta's own
// docs say to fetch it server-side afterward via a follow-up API call, not
// wait for it here). `sessionData`'s accumulate-never-overwrite behavior is
// left in as harmless, still-correct defensive code — nothing in the
// current docs rules out a future multi-message shape — but the mechanism
// this app now actually depends on for phone_number_id is server-side
// discovery (see `wabaConnectionService.js`, PLAN.md item 25), not anything
// arriving through this listener.
//
// CHANGED AGAIN 2026-09-08, same day: FINISH was confirmed absent on 3 real
// attempts in a row (see CLAUDE.md Known Gaps), so this file no longer waits
// up to 10 minutes for it after a code is obtained. connect() now grants at
// most FINISH_GRACE_MS (5s) as a free shortcut, then calls the backend with
// whatever it has — server-side discovery is the primary mechanism now, not
// a fallback behind a long wait. The listener keeps running indefinitely
// either way, so a FINISH that does eventually arrive (even after connect()
// has already returned) is still captured and logged, just never blocking.
(function () {
  let sdkReady = false;

  // Corrected 2026-09-07 (see top-of-file comment): FINISH_WHATSAPP_BUSINESS_
  // APP_ONBOARDING is the only event this flow fires, carrying `waba_id`
  // alone — there's no earlier session-log message to rescue anything from.
  // `sessionData` still accumulates every message's `data` fields (a later
  // message's fields augment, never clear, the running total) as harmless
  // defensive code, not because a real message sequence needs it today.
  // `terminalEvent` separately tracks the most recent FINISH/CANCEL/ERROR
  // event name, since that's what actually decides when to resolve/reject —
  // a different concern from which fields have arrived so far.
  let sessionData = {};
  let terminalEvent = null;

  // Found live 2026-09-07 (5 real attempts, see CLAUDE.md Known Gaps): a
  // reject function registered by connect() while it's waiting for a code,
  // so a terminal postMessage arriving on THIS channel — not just
  // FB.login's own callback below — can end that wait too. Needed because
  // FB.login's callback was found to fire in 1-5 seconds with no code while
  // the user was still genuinely mid-wizard (business selection, QR scan,
  // Finish); a codeless callback no longer rejects by itself, so without
  // this, connect() would have no way to notice a real FINISH/CANCEL/ERROR
  // arriving afterward and would just sit until the 10-minute hard timeout.
  let pendingCodeReject = null;

  // CHANGED AGAIN 2026-09-08, same day: the fix below (wait up to the full
  // 10-minute hard timeout for FINISH) was itself wrong in the other
  // direction. A live check of the client's actual 14:25 UTC attempt found
  // FINISH never arrived at all — on this attempt or either of the two
  // before it — and separately confirmed, server-to-server, that Meta DOES
  // fully link the WABA and starts sending it real account_update webhooks
  // even when the browser-side wizard never fires FINISH (see CLAUDE.md
  // Known Gaps). Waiting 10 minutes on a signal that has never once arrived
  // just means 10 minutes of silence before the thing that actually works
  // (server-side discovery, PLAN.md item 25) ever gets a chance to run.
  // pendingTerminalWake still exists for the same reason — a wake function
  // the message listener calls the moment a real terminal event arrives —
  // but connect() now only grants it a brief grace window
  // (FINISH_GRACE_MS), not the full hard timeout, and proceeds to
  // POST /whatsapp/connect with whatever it has either way. The listener
  // itself keeps running indefinitely (module scope, never torn down), so a
  // FINISH that arrives after this grace window — or after connect() has
  // already returned — is still captured in sessionData/terminalEvent and
  // logged; it just never blocks the connect call again.
  let pendingTerminalWake = null;

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
        // Bumped 2026-09-07 from v20.0 — set the same day as the rest of
        // this file's original Embedded Signup setup (2026-08-17) and never
        // revisited since. Meta's current implementation doc explicitly
        // says to set this to "the latest API version" and shows v25.0 as
        // that value today; a stale version here was found to be one of
        // three concrete gaps (alongside the config_id and sessionInfoVersion
        // below) between this integration and Meta's current v4 docs — see
        // CLAUDE.md Known Gaps.
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

  window.addEventListener('message', (event) => {
    // Fixed 2026-09-07 — a real attempt produced ZERO [WasiEmbeddedSignup]
    // lines despite reportedly completing, and this logging used to sit
    // AFTER the origin filter below. That meant the one thing most worth
    // seeing — whether a message arrived at all, and from what origin — was
    // exactly what the filter could silently hide. Every message this
    // listener is invoked with is now logged unconditionally, before any
    // filtering, so a wrong assumption about the origin can never again
    // produce silent zero output. The filter itself is unchanged and still
    // gates BEHAVIOR below (Meta's own implementation example uses this
    // exact same `endsWith('facebook.com')` check, confirmed directly
    // against developers.facebook.com — not a guess) — it now just doesn't
    // gate visibility too.
    console.log('[WasiEmbeddedSignup] message event fired — origin:', JSON.stringify(event.origin), 'raw event.data:', event.data);
    if (!event.origin || !event.origin.endsWith('facebook.com')) {
      console.log('[WasiEmbeddedSignup] origin did not match facebook.com — filtered out, not processed.');
      return;
    }
    // Found live 2026-09-08 — Facebook's own SDK sends non-JSON, URL-
    // encoded internal messages (its own XD/iframe comms machinery) from a
    // facebook.com-ending origin too, which used to hit JSON.parse and log
    // as a caught failure every time — harmless, but reads exactly like an
    // error in the console. Every real WA_EMBEDDED_SIGNUP message is a JSON
    // object, so it always starts with '{'; anything that doesn't is
    // skipped before ever attempting to parse it, logged as an explicitly
    // expected non-JSON message instead of a caught exception.
    if (typeof event.data !== 'string' || !event.data.trim().startsWith('{')) {
      console.log('[WasiEmbeddedSignup] non-JSON message from facebook.com (expected — the SDK\'s own internal comms, not embedded-signup-related) — ignored.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(event.data);
      console.log('[WasiEmbeddedSignup] parsed message:', JSON.stringify(parsed));
    } catch (err) {
      console.log('[WasiEmbeddedSignup] JSON.parse failed on this message despite looking JSON-shaped (kept as a log only, not necessarily an error):', err.message);
      return;
    }
    if (parsed?.type !== 'WA_EMBEDDED_SIGNUP') return;
    // Merge, never replace — see sessionData's declaration above for why.
    if (parsed.data && typeof parsed.data === 'object') {
      Object.assign(sessionData, parsed.data);
    }
    if (parsed.event === 'CANCEL' || parsed.event === 'ERROR' || Object.prototype.hasOwnProperty.call(FINISH_EVENTS, parsed.event)) {
      terminalEvent = parsed.event;
      // Found live 2026-09-07 — see CLAUDE.md Known Gaps: FB.login's own
      // callback can no longer be relied on to end connect()'s wait (it can
      // fire early, with no code, while the popup is still genuinely in
      // progress) — so THIS terminal postMessage is now what ends it, if
      // connect() is still waiting. Rejects either way (even on a real
      // FINISH) so the existing catch block below decides the outcome from
      // terminalEvent/sessionData exactly as it already does for the
      // hard-timeout-with-FINISH-already-seen case — no new branching logic
      // duplicated here.
      if (pendingCodeReject) {
        const reject = pendingCodeReject;
        pendingCodeReject = null;
        console.log('[WasiEmbeddedSignup] terminal postMessage (' + parsed.event + ') is ending connect()\'s wait for a code — FB.login\'s callback never delivered one.');
        if (parsed.event === 'CANCEL') {
          reject(new Error('Signup was cancelled in the Facebook popup.'));
        } else if (parsed.event === 'ERROR') {
          reject(new Error(`Facebook reported an error: ${sessionData.error_message || 'unknown error'}`));
        } else {
          reject(new Error('Meta reported the WhatsApp signup finished, but this browser did not receive the authorization code.'));
        }
      } else if (pendingTerminalWake) {
        // Wakes connect()'s brief post-code grace wait the moment a real
        // terminal event arrives, instead of sitting out the full window.
        // Only resolve() is needed here (never reject) — the code right
        // after the await re-checks terminalEvent itself and throws the
        // specific message for CANCEL/ERROR, exactly like the immediate
        // pre-wait check does.
        const wake = pendingTerminalWake;
        pendingTerminalWake = null;
        console.log('[WasiEmbeddedSignup] terminal postMessage (' + parsed.event + ') is ending connect()\'s brief post-code wait.');
        wake();
      } else {
        // Found live 2026-09-08: previously nothing was logged here at all —
        // a terminal event arriving after connect() had already resolved
        // (or after the grace window elapsed) fell through this if/else
        // chain silently. Now that phase 2 no longer blocks for up to 10
        // minutes, a late FINISH/CANCEL/ERROR is a real, expected case, not
        // an edge case — it's still captured in sessionData/terminalEvent
        // for anything that reads them later, and now explicitly logged too,
        // so "the listener keeps running, it just never blocks" is
        // observable in the console, not just true in theory.
        console.log('[WasiEmbeddedSignup] terminal postMessage (' + parsed.event + ') arrived with nothing waiting on it (connect() already moved on) — logged only, waba_id so far: ' + (sessionData.waba_id || 'none') + '.');
      }
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

  // How long to wait for a FINISH postMessage AFTER a code is already in
  // hand, before giving up on it and calling the backend anyway. Changed
  // 2026-09-08 from "wait up to LOGIN_TIMEOUT_MS" (10 minutes) down to this
  // — a live check of 3 real attempts (including the client's 14:25 UTC one)
  // found FINISH never arrived on ANY of them, while a separate server-side
  // check confirmed Meta fully links the WABA and starts sending real
  // account_update webhooks regardless. Server-side discovery
  // (wabaConnectionService.discoverWabaAndPhoneNumber, via debug_token) is
  // now the primary mechanism for waba_id/phone_number_id, not a fallback
  // behind a long wait — this window is only a free, cheap shortcut for the
  // (currently unproven) case where FINISH happens to already be in transit.
  const FINISH_GRACE_MS = 5000;

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
    // Timing/elapsed logging added 2026-09-07 — per direct instruction, so a
    // single real attempt tells us definitively which of 3 scenarios
    // happened (hard timeout with no FINISH ever seen; hard timeout with a
    // FINISH already captured, i.e. the incomplete-state path; or
    // FB.login's callback genuinely never firing for some other reason) —
    // instead of the DB's identical-empty-result-for-all-three ambiguity.
    const connectStartedAt = Date.now();
    console.log('[WasiEmbeddedSignup] connect() started at', new Date(connectStartedAt).toISOString());

    await loadSdk(appId);
    sessionData = {};
    terminalEvent = null;
    pendingCodeReject = null;
    pendingTerminalWake = null;

    const timers = [];
    if (onProgress) {
      for (const step of PROGRESS_STEPS) {
        timers.push(setTimeout(() => onProgress(step.message), step.atMs));
      }
    }

    let code;
    try {
      try {
        code = await new Promise((resolve, reject) => {
          const hardTimeout = setTimeout(() => {
            const elapsedMs = Date.now() - connectStartedAt;
            console.log('[WasiEmbeddedSignup] HARD TIMEOUT fired after', elapsedMs, 'ms — terminalEvent at this moment:', terminalEvent, '— sessionData at this moment:', JSON.stringify(sessionData));
            pendingCodeReject = null;
            reject(new Error('Still not connected after 10 minutes. Please close the Facebook popup and try again — check that your phone has a stable internet connection.'));
          }, LOGIN_TIMEOUT_MS);
          timers.push(hardTimeout);

          // Registered so the message listener above can end this wait on a
          // real terminal postMessage too, not just FB.login's own callback
          // below or the hard timeout — see this variable's declaration.
          pendingCodeReject = reject;

          window.FB.login((response) => {
            const elapsedMs = Date.now() - connectStartedAt;
            if (!response?.authResponse?.code) {
              // Found live 2026-09-07 (see CLAUDE.md Known Gaps): with
              // response_type: 'code' genuinely honored, authResponse should
              // contain ONLY { code }. accessToken/userID/expiresIn is the
              // shape of a PLAIN Facebook Login response — getting that shape
              // back means FB.login() short-circuited on a cached fbsr_
              // <APP_ID> cookie (set on THIS site's own domain, survives a
              // facebook.com logout) before ever reaching the embedded-signup
              // dialog. auth_type: 'reauthenticate' below is meant to prevent
              // this; this check exists so a future occurrence — e.g. a
              // browser where reauthenticate doesn't hold — is named
              // explicitly in the log instead of silently falling into the
              // same generic message a real cancelled/failed attempt gets.
              // This specific case DOES reject immediately (unlike the
              // generic codeless case below) — we know for certain no dialog
              // ever opened, so there is nothing left to wait for.
              if (response?.authResponse?.accessToken) {
                console.log('[WasiEmbeddedSignup] FB.login callback fired after', elapsedMs, 'ms with a CACHED-SESSION SHORT-CIRCUIT — accessToken present but no code, meaning auth_type: reauthenticate did not force a fresh dialog in this browser. response:', JSON.stringify(response));
                pendingCodeReject = null;
                return reject(new Error('WhatsApp connection could not start a fresh signup — your browser reused a cached Facebook session instead of opening the dialog. Try again in a private/incognito window, or clear this site\'s cookies for Facebook, then retry.'));
              }
              // Found live 2026-09-07 (5 real attempts, all identical — see
              // CLAUDE.md Known Gaps): this callback can fire in 1-5 seconds
              // with status 'not_authorized' while the user was still
              // actively completing the popup's wizard (business selection,
              // QR scan, Finish) — proof this callback tracks only the
              // initial OAuth/permission-grant step, a separate and much
              // earlier stage than the wizard itself, per Meta's own
              // Coexistence doc (the wizard's own completion is reported
              // only via the FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING
              // postMessage). A codeless response here is therefore NOT
              // treated as the flow's outcome anymore — only named and
              // logged. pendingCodeReject stays registered: the real outcome
              // is left for a genuine terminal postMessage (see the message
              // listener above) or the hard timeout to decide, so a flow
              // that's still genuinely in progress is never killed early by
              // this callback again.
              console.log('[WasiEmbeddedSignup] FB.login callback fired after', elapsedMs, 'ms with NO code — status:', JSON.stringify(response?.status), '— NOT rejecting; waiting for a postMessage or the hard timeout instead. response:', JSON.stringify(response));
              if (response?.status === 'not_authorized' && onProgress) {
                // BSP-conflict wording added 2026-09-07 — a real client
                // (TNPSC Mentors) hit this exact not_authorized case for a
                // reason unrelated to admin access at all: Meta support
                // confirmed the WABA was still managed by another BSP, which
                // fails Coexistence's eligibility check silently. Named here
                // alongside the existing admin-access note so the next
                // client in this situation gets pointed at the fix
                // immediately instead of costing a support escalation —
                // shared by both app.js and marketing/signup.js, since both
                // just display whatever onProgress hands them.
                onProgress(
                  'Facebook says this account isn\'t authorized to connect this WhatsApp number — this usually means the Facebook account being used isn\'t a full Admin on the Meta Business Manager that owns the number. If you\'re still in the popup, an Admin account may be needed to finish. ' +
                  'We couldn\'t complete the connection. If this number was previously used with another WhatsApp API provider (AiSensy, Wati, Interakt, Gupshup or similar), that provider needs to release it first — the client can check under Business Settings → WhatsApp Accounts → Partners in their Meta Business Manager and remove any existing provider, then try again. ' +
                  'Still waiting in case this resolves…'
                );
              }
              return;
            }
            console.log('[WasiEmbeddedSignup] FB.login callback fired after', elapsedMs, 'ms WITH a code.');
            pendingCodeReject = null;
            resolve(response.authResponse.code);
          }, {
            config_id: configId,
            response_type: 'code',
            override_default_response_type: true,
            // Found live 2026-09-07: without this, FB.login() can resolve
            // immediately from a cached fbsr_<APP_ID> cookie on THIS site's
            // own domain (set by a prior successful login) rather than
            // opening the signup dialog — reproduced twice, including after
            // fully logging out of facebook.com itself, which ruled out a
            // live Facebook session and confirmed it's this site-local
            // cache. Not in Meta's own Embedded Signup example code or docs
            // (checked directly, not assumed) — auth_type is a general FB
            // Login SDK option whose documented purpose is forcing the
            // dialog to show even when an existing session/cache would
            // otherwise resolve it. See CLAUDE.md Known Gaps.
            auth_type: 'reauthenticate',
            // featureType enables the Coexistence sub-flow (business keeps
            // using the WhatsApp Business app on their phone; Meta syncs
            // history to the Cloud API connection instead of migrating the
            // number off the app). An empty string here forces the plain
            // migration flow for everyone, even businesses who need to keep
            // their app — see FINISH_* handling below for why the two paths
            // can't be told apart after the fact. Meta's docs confirm
            // 'coexistence' itself (an earlier, now-invalid value seen in
            // some third-party examples) is no longer accepted — this value
            // is current, unchanged.
            //
            // sessionInfoVersion DROPPED 2026-09-07 — re-verified directly
            // against Meta's current Coexistence doc (searched the live page
            // text specifically) and it appears nowhere anymore, in prose or
            // example code; Meta's general implementation doc's own current
            // FB.login() example only ever shows `extras: { setup: {} }`.
            // This was one of three concrete gaps found between this
            // integration (built 2026-08-17, unrevisited since) and Meta's
            // current v4 docs — see CLAUDE.md Known Gaps. Its removal does
            // NOT reintroduce the original 2026-09-05 phone_number_id loss:
            // that fix's actual justification no longer holds either (see
            // this file's top-of-file comment) — under v4,
            // phone_number_id is never expected to arrive here at all, by
            // design; `wabaConnectionService.js`'s server-side discovery
            // (PLAN.md item 25) is Meta's own documented mechanism for it,
            // already built and already triggered whenever this flow
            // resolves without one (see routes/onboarding.js).
            extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' },
          });
        });
      } catch (codeErr) {
        console.log('[WasiEmbeddedSignup] code-acquisition promise REJECTED after', Date.now() - connectStartedAt, 'ms — reason:', codeErr.message, '— terminalEvent:', terminalEvent, '— sessionData:', JSON.stringify(sessionData));
        // PLAN.md item 25, Part B — FB.login's callback (the OAuth `code`)
        // and the postMessage FINISH event are two independent return
        // channels that can arrive out of order, or one without the other
        // (confirmed 2026-09-07 against Meta's own documented architecture
        // plus an independently-corroborated integration guide). If code
        // acquisition failed (timeout or a genuine non-completion) but a
        // FINISH-type postMessage already arrived — Meta really did link the
        // account — that must not collapse into the same generic "nothing
        // happened" error a real non-attempt produces. Marked distinctly so
        // the caller can report it to the backend instead of just a toast.
        if (terminalEvent && Object.prototype.hasOwnProperty.call(FINISH_EVENTS, terminalEvent) && sessionData.waba_id) {
          console.log('[WasiEmbeddedSignup] -> routing to the INCOMPLETE state (FINISH was already seen).');
          const incompleteErr = new Error(
            'Meta finished linking your WhatsApp account, but this browser never received the authorization code needed to complete the connection.'
          );
          incompleteErr.incomplete = true;
          incompleteErr.waba_id = sessionData.waba_id;
          throw incompleteErr;
        }
        console.log('[WasiEmbeddedSignup] -> no FINISH was ever seen either. Genuine "nothing happened" rejection.');
        throw codeErr;
      }
    } finally {
      timers.forEach(clearTimeout);
      pendingCodeReject = null;
    }

    // PHASE 2, REWRITTEN 2026-09-08: server-side discovery is now the
    // PRIMARY path for waba_id/phone_number_id, not a fallback sitting
    // behind a long wait. A live check of the client's 14:25 UTC attempt
    // (see CLAUDE.md Known Gaps) found FINISH had not arrived on any of the
    // last 3 real attempts, while account_update webhooks confirmed Meta
    // fully links the WABA regardless — so a long wait here was pure delay
    // with no evidence it ever pays off. Two cases only:
    //
    // 1. FINISH already arrived (checked immediately — it may have beaten
    //    the FB.login callback, same as before) — free shortcut, use it.
    // 2. Otherwise, wait at most FINISH_GRACE_MS (5s) for one to still show
    //    up, then call the backend with whatever's in hand regardless. The
    //    code alone is enough — wabaConnectionService.discoverWabaAndPhone
    //    Number resolves waba_id/phone_number_id server-side from the
    //    access token via debug_token.
    //
    // CANCEL/ERROR are still treated as real, deliberate signals (not
    // something to paper over by calling connect anyway) — but per the
    // instruction that "the code alone is enough," a genuine FINISH-or-
    // nothing outcome always proceeds to the backend now, never blocks
    // further, and never invents a second "incomplete" record for it.
    if (terminalEvent === 'CANCEL') throw new Error('Signup was cancelled in the Facebook popup.');
    if (terminalEvent === 'ERROR') throw new Error(`Facebook reported an error: ${sessionData.error_message || 'unknown error'}`);
    if (terminalEvent && Object.prototype.hasOwnProperty.call(FINISH_EVENTS, terminalEvent)) {
      console.log('[WasiEmbeddedSignup] FINISH already seen before the grace wait — using it directly, no wait needed.');
      return {
        code,
        waba_id: sessionData.waba_id,
        phone_number_id: sessionData.phone_number_id,
        via_coexistence: FINISH_EVENTS[terminalEvent],
      };
    }

    if (onProgress) onProgress('Talking to Meta to finish connecting your WhatsApp number…');
    await new Promise((resolve) => {
      const graceTimeout = setTimeout(resolve, FINISH_GRACE_MS);
      pendingTerminalWake = () => { clearTimeout(graceTimeout); resolve(); };
    });
    pendingTerminalWake = null;

    if (terminalEvent === 'CANCEL') throw new Error('Signup was cancelled in the Facebook popup.');
    if (terminalEvent === 'ERROR') throw new Error(`Facebook reported an error: ${sessionData.error_message || 'unknown error'}`);
    console.log(
      '[WasiEmbeddedSignup] proceeding to POST /whatsapp/connect after',
      Date.now() - connectStartedAt,
      'ms — terminalEvent:', terminalEvent, '— waba_id so far:', sessionData.waba_id || 'none (server-side discovery will resolve it)'
    );
    // via_coexistence defaults true deliberately, FINISH or not: this app's
    // FB.login call is unconditionally Coexistence-enabled (featureType is
    // never empty), so this attempt was always one — defaulting false would
    // risk the backend trying to register-with-PIN a number that's already
    // active on the WhatsApp Business app.
    return {
      code,
      waba_id: sessionData.waba_id,
      phone_number_id: sessionData.phone_number_id,
      via_coexistence: terminalEvent && Object.prototype.hasOwnProperty.call(FINISH_EVENTS, terminalEvent)
        ? FINISH_EVENTS[terminalEvent]
        : true,
    };
  }

  window.WasiEmbeddedSignup = { connect };
})();
