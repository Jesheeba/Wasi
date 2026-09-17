// Real client rejection, not hypothetical: Riyaz (Sirah Digital)'s
// 'booking_otp' template was rejected by Meta (rejection_reason
// 'INCORRECT_CATEGORY') for OTP/verification-code content submitted under
// Utility instead of Authentication. This is the server-side half of the
// fix — templateParams.js's checkCategoryContentMismatch, unit-tested in
// templateParams.test.js, wired into POST / and PUT /:id as a non-blocking
// `warnings` field on an otherwise-successful response (the template still
// really gets submitted to Meta — this only adds a heads-up, it never
// withholds the 201/200). Real DB writes through a disposable test client
// (same pattern as templateEdit.test.js); Meta calls faked by stubbing
// global.fetch for graph.facebook.com only.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SUITE_PREFIX = '__test_suite__templatecategorymismatch_';

async function setup() {
  const { createApp } = require('../src/app');
  const { pool } = require('../src/db/pool');

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-templatecategorymismatch-${Date.now()}-${Math.random().toString(36).slice(2)}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const clientId = registered.client?.id;
  const authToken = registered.token;
  assert.ok(clientId && authToken, 'dedicated test client registration must succeed');

  return { pool, server, baseUrl, clientId, authToken };
}

async function teardown({ pool, clientId, server }) {
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
}

// No WABA connected for this disposable client — these templates save
// locally as 'pending' without ever calling Meta (routes/templates.js's own
// documented behavior for a client with no connected WABA yet), which is
// exactly what's needed here: the warning is checked independent of
// whether the Meta call itself happens.
test('POST /api/templates: OTP-shaped body under Utility still succeeds (201), with a non-blocking warning', async () => {
  const ctx = await setup();
  const { baseUrl, authToken, clientId, server, pool } = ctx;
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${SUITE_PREFIX}booking_otp`,
        category: 'Utility',
        language: 'en_US',
        body: 'Your Sirah Digital verification code is {{code}}. It expires in 10 minutes. For your security, do not share this code with anyone.',
        bodyParamExamples: { code: '483920' },
      }),
    });
    assert.equal(res.status, 201, 'the submission itself must never be blocked by this heuristic');
    const body = await res.json();
    assert.ok(Array.isArray(body.warnings) && body.warnings.length === 1, 'must carry exactly one warning');
    assert.match(body.warnings[0], /Authentication category/);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('POST /api/templates: ordinary Utility body has no warnings field at all', async () => {
  const ctx = await setup();
  const { baseUrl, authToken, clientId, server, pool } = ctx;
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${SUITE_PREFIX}shipping_update`,
        category: 'Utility',
        language: 'en_US',
        body: 'Hi {{customer_name}}, your order has shipped and is on its way!',
        bodyParamExamples: { customer_name: 'Priya' },
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.warnings, undefined);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('PUT /api/templates/:id: editing a draft\'s body into OTP-shaped content under Utility warns but still succeeds', async () => {
  const ctx = await setup();
  const { baseUrl, authToken, clientId, server, pool } = ctx;
  try {
    const created = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${SUITE_PREFIX}editable_draft`,
        category: 'Utility',
        language: 'en_US',
        body: 'Hi {{customer_name}}, your recent order has shipped and is now on its way to you.',
        bodyParamExamples: { customer_name: 'Priya' },
      }),
    }).then((r) => r.json());
    assert.ok(created.id, `draft creation must succeed first: ${JSON.stringify(created)}`);

    const res = await fetch(`${baseUrl}/api/templates/${created.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Long enough to clear the pre-existing, unrelated words-ratio rule
        // (7 words per param + 2, so 1 param needs >= 9 words) — this test
        // is about the category-mismatch warning, not that rule.
        body: 'Your one-time password to finish signing in today is {{code}}. Please enter it within the next few minutes.',
        bodyParamExamples: { code: '483920' },
        header: { type: 'NONE' },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.warnings) && body.warnings.length === 1);
  } finally {
    await teardown({ pool, clientId, server });
  }
});
