// Payment reminder + auto-suspend-for-nonpayment feature
// (paymentReminderRunner.js, clientNotifier.js, routes/clients.js's
// status-change audit logging + new /payment-status route).
//
// Real DB writes through disposable test clients (same pattern as
// templateEdit.test.js/adminSecretMasking.test.js), never the real 6
// clients. Meta calls faked by stubbing global.fetch for graph.facebook.com
// only. Runner tests call the PER-CLIENT functions (sendReminderIfDue/
// enforceNonpaymentForClient) directly, never the bulk sendReminders()/
// enforceNonpayment()/tick() — those scan every real active/unpaid client
// in this shared production database, and calling them from a test would
// process (and potentially message) real clients, not just this file's
// disposable one. See CLAUDE.md's "live background workers" convention.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SUITE_PREFIX = '__test_suite__paymentreminder_';

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function setup() {
  const { createApp } = require('../src/app');
  const { pool } = require('../src/db/pool');
  const clientsRepo = require('../src/repositories/clientsRepo');
  const wabasRepo = require('../src/repositories/wabasRepo');
  const auditLogRepo = require('../src/repositories/auditLogRepo');
  const paymentReminderRunner = require('../src/services/paymentReminderRunner');
  const { encrypt } = require('../src/utils/encryption');

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-paymentreminder-${Date.now()}-${Math.random().toString(36).slice(2)}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const clientId = registered.client?.id;
  assert.ok(clientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  const adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');

  await wabasRepo.upsertForClient(clientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-test-token'),
  });

  return { pool, clientsRepo, auditLogRepo, paymentReminderRunner, server, baseUrl, clientId, adminToken };
}

async function teardown({ pool, clientId, server }) {
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
}

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// --- isReminderDueToday: pure, no DB ---

test('isReminderDueToday: matches activated_at\'s day-of-month, skips the activation month itself', () => {
  const { isReminderDueToday } = require('../src/services/paymentReminderRunner');
  const client = { activated_at: '2026-06-15T00:00:00.000Z', last_reminder_sent_on: null };

  assert.equal(isReminderDueToday(client, new Date('2026-06-15T12:00:00Z')), false, 'never fires in the activation month itself');
  assert.equal(isReminderDueToday(client, new Date('2026-07-15T12:00:00Z')), true, 'fires on the same day-of-month a month later');
  assert.equal(isReminderDueToday(client, new Date('2026-07-14T12:00:00Z')), false, 'not the anniversary day yet');
});

test('isReminderDueToday: month-end fallback — activated on the 31st still fires on a 30-day month\'s last day', () => {
  const { isReminderDueToday } = require('../src/services/paymentReminderRunner');
  const client = { activated_at: '2026-01-31T00:00:00.000Z', last_reminder_sent_on: null };

  assert.equal(isReminderDueToday(client, new Date('2026-04-30T12:00:00Z')), true, 'April has 30 days — fires on the 30th');
  assert.equal(isReminderDueToday(client, new Date('2026-04-29T12:00:00Z')), false);
  assert.equal(isReminderDueToday(client, new Date('2026-05-31T12:00:00Z')), true, 'May has 31 — fires on the real day again');
});

test('isReminderDueToday: already sent today is not due again', () => {
  const { isReminderDueToday, todayDateString } = require('../src/services/paymentReminderRunner');
  const now = new Date('2026-07-15T12:00:00Z');
  const client = { activated_at: '2026-06-15T00:00:00.000Z', last_reminder_sent_on: todayDateString(now) };
  assert.equal(isReminderDueToday(client, now), false);
});

test('isReminderDueToday: no activated_at at all is never due', () => {
  const { isReminderDueToday } = require('../src/services/paymentReminderRunner');
  assert.equal(isReminderDueToday({ activated_at: null, last_reminder_sent_on: null }, new Date()), false);
});

// --- sendReminderIfDue: DB-backed, per-client only ---

test('sendReminderIfDue: a due client sends the template, logs audit, stamps last_reminder_sent_on', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, paymentReminderRunner, clientId, server } = ctx;
  const originalFetch = global.fetch;
  const originalEnv = process.env.PAYMENT_REMINDER_WABA_ID;
  try {
    process.env.PAYMENT_REMINDER_WABA_ID = `${SUITE_PREFIX}waba`;
    await clientsRepo.update(pool, clientId, {
      status: 'active', contact_phone: '15550001111',
      activated_at: '2026-06-15T00:00:00.000Z',
    });

    let sendCall = null;
    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.endsWith('/messages')) {
        sendCall = { url: urlStr, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.fake123' }] }) };
      }
      return originalFetch(url, options);
    };

    const now = new Date('2026-07-15T12:00:00Z');
    const client = await clientsRepo.findById(pool, clientId);
    const sent = await paymentReminderRunner.sendReminderIfDue(client, now, pool);

    assert.equal(sent, true);
    assert.ok(sendCall, 'must call Meta to send the reminder template');
    assert.equal(sendCall.body.template.name, 'wasi_payment_reminder');

    const updated = await clientsRepo.findById(pool, clientId);
    assert.equal(paymentReminderRunner.dateOnlyString(updated.last_reminder_sent_on), '2026-07-15');

    const audit = await auditLogRepo.list({ clientId });
    assert.ok(audit.some((a) => a.action === 'payment_reminder_sent'), 'must audit-log the send');
  } finally {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.PAYMENT_REMINDER_WABA_ID;
    else process.env.PAYMENT_REMINDER_WABA_ID = originalEnv;
    await teardown({ pool, clientId, server });
  }
});

test('sendReminderIfDue: a not-due client is skipped entirely — no send, no audit row, no column change', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, paymentReminderRunner, clientId, server } = ctx;
  try {
    await clientsRepo.update(pool, clientId, { status: 'active', activated_at: '2026-06-15T00:00:00.000Z' });
    const now = new Date('2026-07-14T12:00:00Z'); // day before the anniversary
    const client = await clientsRepo.findById(pool, clientId);
    const sent = await paymentReminderRunner.sendReminderIfDue(client, now, pool);

    assert.equal(sent, false);
    const updated = await clientsRepo.findById(pool, clientId);
    assert.equal(updated.last_reminder_sent_on, null);
    const audit = await auditLogRepo.list({ clientId });
    assert.ok(!audit.some((a) => a.action === 'payment_reminder_sent'));
  } finally {
    await teardown({ pool, clientId, server });
  }
});

// --- enforceNonpaymentForClient: the day-3/day-5 timeline ---

test('enforceNonpaymentForClient: under 3 days unpaid does nothing', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, paymentReminderRunner, clientId, server } = ctx;
  try {
    await clientsRepo.update(pool, clientId, {
      status: 'active', payment_status: 'unpaid', payment_marked_unpaid_at: daysAgoIso(1),
    });
    const client = await clientsRepo.findById(pool, clientId);
    const action = await paymentReminderRunner.enforceNonpaymentForClient(client, new Date(), pool);
    assert.equal(action, null);
    const unchanged = await clientsRepo.findById(pool, clientId);
    assert.equal(unchanged.status, 'active');
    assert.equal(unchanged.payment_warning_sent_at, null);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('enforceNonpaymentForClient: 3+ days unpaid sends the warning once, not twice', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, paymentReminderRunner, clientId, server } = ctx;
  const originalFetch = global.fetch;
  const originalEnv = process.env.PAYMENT_REMINDER_WABA_ID;
  try {
    process.env.PAYMENT_REMINDER_WABA_ID = `${SUITE_PREFIX}waba`;
    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.endsWith('/messages')) {
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
      }
      return originalFetch(url, options);
    };

    await clientsRepo.update(pool, clientId, {
      status: 'active', contact_phone: '15550001111',
      payment_status: 'unpaid', payment_marked_unpaid_at: daysAgoIso(3.5),
    });

    const client = await clientsRepo.findById(pool, clientId);
    const action = await paymentReminderRunner.enforceNonpaymentForClient(client, new Date(), pool);
    assert.equal(action, 'warned');
    const afterWarning = await clientsRepo.findById(pool, clientId);
    assert.ok(afterWarning.payment_warning_sent_at, 'payment_warning_sent_at must be stamped');
    assert.equal(afterWarning.status, 'active', 'a warning must not suspend the account');

    // Second call the same day must be a no-op — warning already sent.
    const secondAction = await paymentReminderRunner.enforceNonpaymentForClient(afterWarning, new Date(), pool);
    assert.equal(secondAction, null);

    const audit = await auditLogRepo.list({ clientId });
    assert.equal(audit.filter((a) => a.action === 'payment_suspension_warning_sent').length, 1, 'exactly one warning audit row');
  } finally {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.PAYMENT_REMINDER_WABA_ID;
    else process.env.PAYMENT_REMINDER_WABA_ID = originalEnv;
    await teardown({ pool, clientId, server });
  }
});

test('enforceNonpaymentForClient: 5+ days unpaid auto-suspends and stamps auto_suspended_for_nonpayment', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, paymentReminderRunner, clientId, server } = ctx;
  try {
    await clientsRepo.update(pool, clientId, {
      status: 'active', payment_status: 'unpaid', payment_marked_unpaid_at: daysAgoIso(6),
    });
    const client = await clientsRepo.findById(pool, clientId);
    const action = await paymentReminderRunner.enforceNonpaymentForClient(client, new Date(), pool);
    assert.equal(action, 'suspended');

    const updated = await clientsRepo.findById(pool, clientId);
    assert.equal(updated.status, 'suspended');
    assert.equal(updated.auto_suspended_for_nonpayment, true);

    const audit = await auditLogRepo.list({ clientId });
    assert.ok(audit.some((a) => a.action === 'auto_suspended_nonpayment'));
  } finally {
    await teardown({ pool, clientId, server });
  }
});

// --- routes/clients.js: PATCH status + POST /payment-status ---

test('PATCH /api/clients/:id: first transition to active stamps activated_at, logs audit, resets auto_suspended_for_nonpayment', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, baseUrl, adminToken, clientId, server } = ctx;
  try {
    await clientsRepo.update(pool, clientId, { status: 'pending_setup', auto_suspended_for_nonpayment: true });

    const res = await fetch(`${baseUrl}/api/clients/${clientId}`, {
      method: 'PATCH', headers: authed(adminToken), body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.activated_at, 'activated_at must be set on first activation');
    assert.equal(body.auto_suspended_for_nonpayment, false, 'a manual status change clears the auto-suspend flag');

    // A second, later transition (e.g. suspend then reactivate) must NOT
    // move the original activation date — it's the billing-cycle anchor.
    const firstActivatedAt = body.activated_at;
    await fetch(`${baseUrl}/api/clients/${clientId}`, {
      method: 'PATCH', headers: authed(adminToken), body: JSON.stringify({ status: 'suspended' }),
    });
    const reactivated = await fetch(`${baseUrl}/api/clients/${clientId}`, {
      method: 'PATCH', headers: authed(adminToken), body: JSON.stringify({ status: 'active' }),
    }).then((r) => r.json());
    assert.equal(reactivated.activated_at, firstActivatedAt);

    const audit = await auditLogRepo.list({ clientId });
    assert.ok(audit.some((a) => a.action === 'client_status_changed'), 'status changes must be audit-logged (previously a gap)');
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('POST /api/clients/:id/payment-status: marking unpaid starts the countdown, marking paid clears it', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, auditLogRepo, baseUrl, adminToken, clientId, server } = ctx;
  try {
    await clientsRepo.update(pool, clientId, { status: 'active' });

    const unpaidRes = await fetch(`${baseUrl}/api/clients/${clientId}/payment-status`, {
      method: 'POST', headers: authed(adminToken), body: JSON.stringify({ paid: false }),
    });
    assert.equal(unpaidRes.status, 200);
    const unpaidBody = await unpaidRes.json();
    assert.equal(unpaidBody.payment_status, 'unpaid');
    assert.ok(unpaidBody.payment_marked_unpaid_at);

    const paidRes = await fetch(`${baseUrl}/api/clients/${clientId}/payment-status`, {
      method: 'POST', headers: authed(adminToken), body: JSON.stringify({ paid: true }),
    });
    const paidBody = await paidRes.json();
    assert.equal(paidBody.payment_status, 'paid');
    assert.equal(paidBody.payment_marked_unpaid_at, null);
    assert.equal(paidBody.payment_warning_sent_at, null);
    assert.equal(paidBody.status, 'active', 'was never auto-suspended, so status is untouched');

    const audit = await auditLogRepo.list({ clientId });
    assert.ok(audit.some((a) => a.action === 'client_marked_unpaid'));
    assert.ok(audit.some((a) => a.action === 'client_marked_paid'));
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('POST /api/clients/:id/payment-status: marking paid after an AUTO-suspend restores Service; a MANUAL suspend is left alone', async () => {
  const ctx = await setup();
  const { pool, clientsRepo, baseUrl, adminToken, clientId, server } = ctx;
  try {
    // Case 1: auto-suspended by this feature -> marking paid reactivates.
    await clientsRepo.update(pool, clientId, { status: 'suspended', auto_suspended_for_nonpayment: true, payment_status: 'unpaid' });
    const restored = await fetch(`${baseUrl}/api/clients/${clientId}/payment-status`, {
      method: 'POST', headers: authed(adminToken), body: JSON.stringify({ paid: true }),
    }).then((r) => r.json());
    assert.equal(restored.status, 'active');
    assert.equal(restored.auto_suspended_for_nonpayment, false);

    // Case 2: manually suspended for an unrelated reason -> marking paid
    // must NOT silently reactivate the account.
    await clientsRepo.update(pool, clientId, { status: 'suspended', auto_suspended_for_nonpayment: false, payment_status: 'unpaid' });
    const untouched = await fetch(`${baseUrl}/api/clients/${clientId}/payment-status`, {
      method: 'POST', headers: authed(adminToken), body: JSON.stringify({ paid: true }),
    }).then((r) => r.json());
    assert.equal(untouched.status, 'suspended', 'a manual suspension is not this feature\'s to undo');
  } finally {
    await teardown({ pool, clientId, server });
  }
});
