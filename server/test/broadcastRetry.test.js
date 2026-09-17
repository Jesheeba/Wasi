// Load-analysis follow-up (2026-09-16 session, item 2): a broadcast
// recipient that hit a TRANSIENT send failure (a Meta rate-limit rejection,
// a network timeout) used to be marked 'failed' permanently on the very
// first attempt, identically to a genuinely permanent rejection. This adds
// retry-with-backoff for the transient case only — migration 071's
// attempt_count/next_attempt_at, broadcastRecipientsRepo.markFailedAttempt,
// and broadcastRunner.js's isTransientSendError classifier. Campaign-scoped
// backoff (30s/2m/10m), deliberately much shorter than forwardRunner's
// hours-long webhook schedule — see broadcastRecipientsRepo.js's own
// comment for why. Same dedicated-disposable-test-client + Meta-boundary-
// only fetch-faking pattern as broadcastPacing.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const broadcastRecipientsRepo = require('../src/repositories/broadcastRecipientsRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const { MessagingError } = require('../src/services/messagingService');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let emptyTagId;

const SUITE_PREFIX = '__test_suite__broadcastretry_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-broadcastretry-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });

  const tagRes = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}empty_tag` }),
  }).then((r) => r.json());
  emptyTagId = tagRes.id;
  assert.ok(emptyTagId, 'empty tag creation must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// --- isTransientSendError: pure classification, no DB/network involved ---

test('isTransientSendError: only send_failed errors carrying a documented Meta rate-limit code, or a timeout/network message, count as transient', () => {
  const rateLimited = new MessagingError('(#130429) Rate limit hit', 'send_failed');
  rateLimited.metaError = { code: 130429, message: 'Rate limit hit' };
  assert.equal(broadcastRunner.isTransientSendError(rateLimited), true);

  const otherMetaRejection = new MessagingError('(#131047) Message failed to send because more than 24 hours have passed', 'send_failed');
  otherMetaRejection.metaError = { code: 131047, message: '...' };
  assert.equal(broadcastRunner.isTransientSendError(otherMetaRejection), false, 'a real but non-rate-limit Meta rejection must not be treated as transient');

  const timeout = new MessagingError('Meta API request timed out after 20s', 'send_failed');
  timeout.metaError = null;
  assert.equal(broadcastRunner.isTransientSendError(timeout), true);

  const genericNetworkFailure = new MessagingError('fetch failed', 'send_failed');
  genericNetworkFailure.metaError = null;
  assert.equal(broadcastRunner.isTransientSendError(genericNetworkFailure), true);

  const unrelatedError = new MessagingError('Only a failed message can be retried.', 'not_failed');
  assert.equal(broadcastRunner.isTransientSendError(unrelatedError), false, 'a non-send_failed MessagingError code must never be retried here');

  const configError = new MessagingError('No connected WhatsApp Business number for this account.', 'waba_not_connected');
  assert.equal(broadcastRunner.isTransientSendError(configError), false, 'a config/precondition failure is not a per-message transient one, even if worded ambiguously');

  assert.equal(broadcastRunner.isTransientSendError(new Error('plain error, not a MessagingError at all')), false);
});

// --- broadcastRecipientsRepo.markFailedAttempt: direct repo-level test of
// the backoff schedule and eventual give-up, against a real inserted row ---

test('markFailedAttempt: retries at 30s/2m/10m, then gives up permanently on the 3rd failure', async () => {
  const contact = await contactsRepo.create(pool, testClientId, {
    name: 'Retry Target', phone: `9196${Date.now().toString().slice(-7)}`,
  });
  const broadcastRow = (await pool.query(
    `insert into broadcasts (client_id, title, tag_id, template_name) values ($1, $2, $3, 'whatever') returning id`,
    [testClientId, `${SUITE_PREFIX}repo_campaign`, emptyTagId]
  )).rows[0];
  const recipient = (await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id) values ($1, $2, $3) returning id`,
    [broadcastRow.id, testClientId, contact.id]
  )).rows[0];

  const before1 = Date.now();
  const r1 = await broadcastRecipientsRepo.markFailedAttempt(pool, recipient.id, 'transient failure #1', 0);
  assert.deepEqual(r1, { giveUp: false, nextAttemptCount: 1 });
  let row = (await pool.query('select * from broadcast_recipients where id = $1', [recipient.id])).rows[0];
  assert.equal(row.status, 'pending', 'must be retryable, not terminal, after the 1st failure');
  assert.equal(row.attempt_count, 1);
  // Wide tolerance windows, not a tight one — this project's own precedent
  // (webhookForwarding.test.js) only asserts direction ("pushed into the
  // future") specifically to avoid flakiness from clock skew/latency
  // against the real remote Supabase instance; this asserts direction PLUS
  // enough of a window to actually distinguish the 3 distinct backoff
  // stages from each other (30s vs 2m vs, below, the give-up case).
  let waitMs = new Date(row.next_attempt_at).getTime() - before1;
  assert.ok(waitMs > 15_000 && waitMs < 60_000, `expected ~30s backoff after attempt 1, got ${waitMs}ms`);

  const before2 = Date.now();
  const r2 = await broadcastRecipientsRepo.markFailedAttempt(pool, recipient.id, 'transient failure #2', row.attempt_count);
  assert.deepEqual(r2, { giveUp: false, nextAttemptCount: 2 });
  row = (await pool.query('select * from broadcast_recipients where id = $1', [recipient.id])).rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 2);
  waitMs = new Date(row.next_attempt_at).getTime() - before2;
  assert.ok(waitMs > 90_000 && waitMs < 180_000, `expected ~2m backoff after attempt 2, got ${waitMs}ms`);

  const r3 = await broadcastRecipientsRepo.markFailedAttempt(pool, recipient.id, 'transient failure #3 — final', row.attempt_count);
  assert.deepEqual(r3, { giveUp: true, nextAttemptCount: 3 });
  row = (await pool.query('select * from broadcast_recipients where id = $1', [recipient.id])).rows[0];
  assert.equal(row.status, 'failed', 'must give up permanently on the 3rd transient failure, not schedule a 4th attempt');
  assert.equal(row.attempt_count, 3);
  assert.equal(row.error_reason, 'transient failure #3 — final');
});

// --- claimBatch must honor next_attempt_at, not just status='pending' ---

test('claimBatch does not reclaim a recipient whose backoff has not elapsed yet, but does once it has', async () => {
  const contact = await contactsRepo.create(pool, testClientId, {
    name: 'Backoff Waiter', phone: `9195${Date.now().toString().slice(-7)}`,
  });
  const broadcastRow = (await pool.query(
    `insert into broadcasts (client_id, title, tag_id, template_name, status) values ($1, $2, $3, 'whatever', 'Sending') returning id`,
    [testClientId, `${SUITE_PREFIX}claim_campaign`, emptyTagId]
  )).rows[0];
  const recipient = (await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id, attempt_count, next_attempt_at)
     values ($1, $2, $3, 1, now() + interval '30 seconds') returning id`,
    [broadcastRow.id, testClientId, contact.id]
  )).rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const notYetDue = await broadcastRecipientsRepo.claimBatch(client, broadcastRow.id, 10);
    assert.equal(notYetDue.length, 0, 'a recipient still inside its backoff window must not be claimable');
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await pool.query(`update broadcast_recipients set next_attempt_at = now() - interval '1 second' where id = $1`, [recipient.id]);

  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    const nowDue = await broadcastRecipientsRepo.claimBatch(client2, broadcastRow.id, 10);
    assert.equal(nowDue.length, 1, 'the same recipient must be claimable once its backoff has elapsed');
    assert.equal(nowDue[0].id, recipient.id);
    await client2.query('COMMIT');
  } finally {
    client2.release();
  }
});

// --- End-to-end via processBroadcast: a real 429-shaped Meta rejection is
// retried (not permanently failed) and the broadcast waits for it, then a
// non-rate-limit rejection is failed immediately with no retry at all. ---

test('processBroadcast: a Meta rate-limit rejection is retried and the broadcast completes once the retry succeeds; an ordinary rejection fails immediately with no retry', async () => {
  const originalFetch = global.fetch;

  const templateName = `${SUITE_PREFIX}tpl_${Date.now()}`;
  let fetchImpl = async (url, options) => originalFetch(url, options);
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return fetchImpl(url, options);
  };

  try {
    fetchImpl = async (url) => {
      if (String(url).endsWith('/messages')) {
        throw new Error('unexpected send during template creation');
      }
      return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'UTILITY' }) };
    };
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({ name: templateName, category: 'Utility', body: 'A retry-with-backoff test message, no variables.' }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    // --- Case A: rate-limited once, then succeeds ---
    // A dedicated tag with exactly this ONE real member, created and tagged
    // BEFORE the broadcast — NOT the emptyTagId + a manual post-hoc
    // `insert into broadcast_recipients` this test originally used. That
    // pattern was wrong for what THIS test needs: routes/broadcasts.js's
    // POST handler marks a broadcast 'Completed' immediately at creation
    // when its audience resolves to zero recipients (a real, correct,
    // pre-existing behavior — an empty-audience campaign has nothing to
    // do). A manual insert afterward still gets processed by
    // processBroadcast, but the broadcast itself was already 'Completed'
    // before that ever ran, which made an earlier draft of this test's own
    // "must still be Sending while a recipient retries" assertion fail —
    // not because retry was broken, but because the test's own setup
    // short-circuited past the state it meant to observe. Tagging the
    // contact into a real, non-empty audience before creating the broadcast
    // makes createFromAudience pick it up naturally at creation time
    // (recipients.length === 1), the same real path a genuine campaign uses.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rateLimitedTag = await fetch(`${baseUrl}/api/tags`, {
      method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}ratelimited_tag` }),
    }).then((r) => r.json());
    const contact = await contactsRepo.create(pool, testClientId, {
      name: 'Rate Limited Then OK', phone: `9194${Date.now().toString().slice(-7)}`, tag_id: rateLimitedTag.id,
    });
    const createRes = await fetch(`${baseUrl}/api/broadcasts`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({ title: `${SUITE_PREFIX}ratelimited_campaign`, templateName, scheduled_date: tomorrow, tag_id: rateLimitedTag.id }),
    });
    const broadcast = await createRes.json();
    assert.equal(broadcast.recipient_count, 1, 'the tagged contact must be picked up as a real recipient at creation time, not zero');

    let sendAttempts = 0;
    fetchImpl = async (url) => {
      if (!String(url).endsWith('/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: 'x', status: 'APPROVED', category: 'UTILITY' }) };
      }
      sendAttempts++;
      if (sendAttempts === 1) {
        return { ok: false, status: 429, json: async () => ({ error: { message: '(#130429) Rate limit hit', code: 130429 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}retry_ok` }] }) };
    };

    let row = (await pool.query('select * from broadcasts where id = $1', [broadcast.id])).rows[0];
    await broadcastRunner.processBroadcast(row);

    let recipientRow = (await pool.query('select * from broadcast_recipients where broadcast_id = $1', [broadcast.id])).rows[0];
    assert.equal(recipientRow.status, 'pending', 'rate-limited on the only attempt so far — must be scheduled to retry, not failed');
    assert.equal(recipientRow.attempt_count, 1);
    assert.match(recipientRow.error_reason, /130429|Rate limit/);

    row = (await pool.query('select * from broadcasts where id = $1', [broadcast.id])).rows[0];
    // scheduled_date is TOMORROW (see this test's own comment on why —
    // avoiding this shared DB's live broadcastRunner), so
    // broadcastsRepo.create left this row 'Scheduled', not 'Sending' — that
    // status field never flips to 'Sending' on its own since this test
    // calls processBroadcast() directly rather than tick()'s
    // Scheduled -> Sending promotion (same pattern broadcastPacing.test.js
    // established). The actual thing under test here is that it must NOT
    // have jumped to 'Completed' while a retry is still outstanding.
    assert.notEqual(row.status, 'Completed', 'broadcast must not be marked Completed while a recipient is mid-backoff');
    assert.equal(row.status, 'Scheduled');

    // Simulate the backoff having elapsed instead of waiting 30 real seconds.
    await pool.query(`update broadcast_recipients set next_attempt_at = now() - interval '1 second' where id = $1`, [recipientRow.id]);
    row = (await pool.query('select * from broadcasts where id = $1', [broadcast.id])).rows[0];
    await broadcastRunner.processBroadcast(row);

    recipientRow = (await pool.query('select * from broadcast_recipients where broadcast_id = $1', [broadcast.id])).rows[0];
    assert.equal(recipientRow.status, 'sent', 'the retried attempt must succeed once Meta stops rate-limiting it');
    assert.equal(sendAttempts, 2, 'exactly 2 real Meta send calls — the rate-limited one and the retry, no more');

    row = (await pool.query('select * from broadcasts where id = $1', [broadcast.id])).rows[0];
    assert.equal(row.status, 'Completed');

    // --- Case B: an ordinary (non-rate-limit) rejection must fail
    // immediately, with no retry at all — same dedicated-tag setup as Case
    // A, for the same reason (avoid the zero-recipient auto-Completed path). ---
    const rejectedTag = await fetch(`${baseUrl}/api/tags`, {
      method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}rejected_tag` }),
    }).then((r) => r.json());
    const contact2 = await contactsRepo.create(pool, testClientId, {
      name: 'Rejected Outright', phone: `9193${Date.now().toString().slice(-7)}`, tag_id: rejectedTag.id,
    });
    const createRes2 = await fetch(`${baseUrl}/api/broadcasts`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({ title: `${SUITE_PREFIX}rejected_campaign`, templateName, scheduled_date: tomorrow, tag_id: rejectedTag.id }),
    });
    const broadcast2 = await createRes2.json();
    assert.equal(broadcast2.recipient_count, 1);

    let rejectedSendAttempts = 0;
    fetchImpl = async (url) => {
      if (!String(url).endsWith('/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: 'x', status: 'APPROVED', category: 'UTILITY' }) };
      }
      rejectedSendAttempts++;
      return { ok: false, status: 400, json: async () => ({ error: { message: '(#131009) Parameter value is not valid', code: 131009 } }) };
    };

    const row2 = (await pool.query('select * from broadcasts where id = $1', [broadcast2.id])).rows[0];
    await broadcastRunner.processBroadcast(row2);

    const recipientRow2 = (await pool.query('select * from broadcast_recipients where broadcast_id = $1', [broadcast2.id])).rows[0];
    assert.equal(recipientRow2.status, 'failed', 'a non-rate-limit rejection must fail immediately, not be scheduled for retry');
    assert.equal(recipientRow2.attempt_count, 0, 'markFailed (the permanent path) does not touch attempt_count — only markFailedAttempt does');
    assert.equal(rejectedSendAttempts, 1, 'must never be retried — exactly one real Meta call for this recipient');

    const finalBroadcast2 = await pool.query('select status from broadcasts where id = $1', [broadcast2.id]);
    assert.equal(finalBroadcast2.rows[0].status, 'Completed', 'a permanently-failed recipient still counts as resolved, so the broadcast completes');
  } finally {
    global.fetch = originalFetch;
  }
});
