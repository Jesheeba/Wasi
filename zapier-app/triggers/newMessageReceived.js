// REST Hook (instant) trigger, not polling — Phase 0 investigation for
// build plan Phase 4 found no existing "list inbound messages across the
// account by time" endpoint to poll, and this event is already delivered
// instantly today via server/src/routes/metaWebhook.js's enqueueForwards +
// webhook_deliveries + forwardRunner.js. Subscribe/unsubscribe just register/
// remove a row in that same pipeline (server/src/routes/apiV1Subscriptions.js)
// — no new send/receive logic, only a new subscription record.
const crypto = require('crypto');

// subscribeHook's response (the full subscription row, including `secret`)
// is what zapier-platform-core persists as bundle.subscribeData for every
// later perform()/performUnsubscribe() call on this same subscription — see
// https://docs.zapier.com/platform/build/trigger#restt-hook-trigger. That's
// the only place this secret is ever stored; it's never logged or returned
// again after this.
const subscribeHook = (z, bundle) =>
  z.request({
    url: '/api/v1/subscriptions',
    method: 'POST',
    body: { target_url: bundle.targetUrl, event: 'message.received' },
  }).then((response) => response.json);

const unsubscribeHook = (z, bundle) =>
  z.request({
    url: `/api/v1/subscriptions/${bundle.subscribeData.id}`,
    method: 'DELETE',
  }).then((response) => response.json);

// Independent Auditor finding: the secret this trigger's subscribeHook gets
// back (routes/apiV1Subscriptions.js's stated purpose for returning it —
// "for the Zapier app to store... and verify the x-wasi-signature-256
// header on each delivery") was generated, signed on by forwardRunner.js,
// and then never actually checked anywhere — meaning anyone who discovered
// or guessed a client's live Zapier catch-hook URL could POST fabricated
// "customer messaged you" events and Zapier would treat them as real. This
// verifies the exact signature forwardRunner.js's deliverOne computes
// (server/src/services/forwardRunner.js: HMAC-SHA256 of the raw JSON body,
// keyed by this subscription's own secret), over bundle.rawRequest.content
// — the raw body bytes, not the already-parsed bundle.cleanedRequest, since
// HMAC must be computed over the exact bytes that were signed. Header
// lookup is case-insensitive: zapier-platform-core's own header-casing
// behavior for bundle.rawRequest.headers isn't guaranteed stable.
function verifySignature(bundle) {
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  const rawBody = bundle.rawRequest && bundle.rawRequest.content;
  const headers = (bundle.rawRequest && bundle.rawRequest.headers) || {};
  const headerKey = Object.keys(headers).find((k) => k.toLowerCase() === 'x-wasi-signature-256');
  const signatureHeader = headerKey ? headers[headerKey] : undefined;

  if (!secret || typeof rawBody !== 'string' || !signatureHeader) {
    throw new Error('Received a WhatsApp message event with no verifiable signature — refusing to process it.');
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !crypto.timingSafeEqual(actual, expectedBuf)) {
    throw new Error('WhatsApp message event failed signature verification — this was not sent by Wasi.');
  }
}

// forwardRunner.js's deliverOne (server/src/services/forwardRunner.js) POSTs
// `{ event, data }` to target_url — the actual message fields live under
// `data`, not at the top level of what Wasi sends. Independent QA finding:
// this previously assumed cleanedRequest/data were always present (a claim
// that turned out false — a malformed/empty bundle threw a raw TypeError,
// and a present-but-dataless cleanedRequest returned [null], which fails
// zapier-platform-core's own trigger-output schema check). Both are now
// handled explicitly: return [] rather than crash or emit a bogus item.
const perform = (z, bundle) => {
  verifySignature(bundle);
  const data = bundle.cleanedRequest && bundle.cleanedRequest.data;
  return data ? [data] : [];
};

module.exports = {
  key: 'new_message_received',
  noun: 'Message',
  display: {
    label: 'New WhatsApp Message Received',
    description: 'Triggers instantly when a customer sends a new WhatsApp message to your Wasi-connected number.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform,
    // No performList fallback yet (Phase 4 known gap, see CLAUDE.md) — Wasi
    // has no "list recent inbound messages" endpoint to power Zapier's
    // "load sample data" step during Zap setup. A user testing this trigger
    // must send a real WhatsApp message to their connected number first;
    // the sample below is what Zapier shows before that happens.
    sample: {
      chat_id: '11111111-1111-1111-1111-111111111111',
      message_id: '22222222-2222-2222-2222-222222222222',
      message_type: 'text',
      contact: { wa_id: '919876543210', name: 'Asha Verma' },
      message: { body: 'Hi, is this product still in stock?', sent_at: '2026-01-01T12:00:00.000Z', interactive: null },
      waba_id: '33333333-3333-3333-3333-333333333333',
      enqueued_at: '2026-01-01T12:00:00.000Z',
    },
  },
};
