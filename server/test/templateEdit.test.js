// PUT /api/templates/:id (server/src/routes/templates.js) — edits an
// existing template's content (body/header[NONE|TEXT]/footer/buttons/
// samples) in place. Real DB writes through a disposable test client (same
// pattern as templateDelete.test.js/templateSync.test.js); Meta calls faked
// by stubbing global.fetch for graph.facebook.com only, never the app's own
// local-server fetches — see CLAUDE.md's testing conventions.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SUITE_PREFIX = '__test_suite__templateedit_';

async function setup() {
  const { createApp } = require('../src/app');
  const { pool } = require('../src/db/pool');
  const wabasRepo = require('../src/repositories/wabasRepo');
  const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
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
      email: `test-suite-templateedit-${Date.now()}-${Math.random().toString(36).slice(2)}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const clientId = registered.client?.id;
  const authToken = registered.token;
  assert.ok(clientId, 'dedicated test client registration must succeed');

  return { pool, wabasRepo, messageTemplatesRepo, encrypt, server, baseUrl, clientId, authToken };
}

async function teardown({ pool, clientId, server }) {
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
}

test('PUT /api/templates/:id: a template live on Meta is edited there (name+language unchanged, body/buttons updated), then locally, and goes back to pending', async () => {
  const ctx = await setup();
  const { pool, wabasRepo, messageTemplatesRepo, encrypt, baseUrl, clientId, authToken } = ctx;
  const originalFetch = global.fetch;
  try {
    await wabasRepo.upsertForClient(clientId, {
      waba_id: `${SUITE_PREFIX}waba`,
      phone_number_id: `${SUITE_PREFIX}phone`,
      status: 'connected',
      access_token_encrypted: encrypt('fake-test-token'),
    });

    const original = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}welcome`, category: 'Utility', status: 'approved', body: 'Hi {{name}}, welcome!',
      bodyParamExamples: { name: 'Priya' },
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_edit_1', original.id]);

    let editCall = null;
    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.includes(`/meta_edit_1`)) {
        editCall = { url: urlStr, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ success: true }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${original.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Hi {{name}}, we are so excited to welcome you aboard today!',
        bodyParamExamples: { name: 'Priya' },
        header: { type: 'NONE' },
        buttons: [{ type: 'QUICK_REPLY', text: 'Yes, book demo' }],
      }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();

    assert.ok(editCall, 'must call Meta to edit the template');
    // No name/language in the edit payload — the template id already
    // identifies both, and Meta's edit endpoint doesn't accept them.
    assert.equal(editCall.body.name, undefined);
    assert.equal(editCall.body.language, undefined);
    assert.equal(editCall.body.category, 'UTILITY');
    const bodyComponent = editCall.body.components.find((c) => c.type === 'BODY');
    assert.equal(bodyComponent.text, 'Hi {{name}}, we are so excited to welcome you aboard today!');
    const buttonsComponent = editCall.body.components.find((c) => c.type === 'BUTTONS');
    assert.deepEqual(buttonsComponent.buttons, [{ type: 'QUICK_REPLY', text: 'Yes, book demo' }]);

    assert.equal(updated.body, 'Hi {{name}}, we are so excited to welcome you aboard today!');
    assert.equal(updated.status, 'pending', 'an edit puts the template back into Meta review');
    assert.equal(updated.name, `${SUITE_PREFIX}welcome`, 'name must never change via edit');
    assert.equal(updated.meta_template_id, 'meta_edit_1', 'meta_template_id must be untouched by edit');

    const fromDb = await messageTemplatesRepo.findById(pool, clientId, original.id);
    assert.equal(fromDb.status, 'pending');
    assert.deepEqual(fromDb.buttons, [{ type: 'QUICK_REPLY', text: 'Yes, book demo' }]);
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('PUT /api/templates/:id: a draft never submitted to Meta (no meta_template_id) is edited locally only, no Meta call made', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, baseUrl, clientId, authToken } = ctx;
  const originalFetch = global.fetch;
  try {
    const draft = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}draft`, category: 'Utility', status: 'pending', body: 'Hi {{name}}.',
      bodyParamExamples: { name: 'Priya' },
    });

    global.fetch = async (url, options) => {
      if (url.toString().includes('graph.facebook.com')) {
        throw new Error('must not call Meta for a template never submitted there');
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${draft.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Hi {{name}}, this message has now been updated for you.',
        bodyParamExamples: { name: 'Priya' },
        header: { type: 'NONE' },
      }),
    });
    assert.equal(res.status, 200);

    const fromDb = await messageTemplatesRepo.findById(pool, clientId, draft.id);
    assert.equal(fromDb.body, 'Hi {{name}}, this message has now been updated for you.');
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('PUT /api/templates/:id: an orphaned row (already gone from Meta) is rejected with 400', async () => {
  const ctx = await setup();
  const { pool, wabasRepo, messageTemplatesRepo, encrypt, baseUrl, clientId, authToken } = ctx;
  try {
    await wabasRepo.upsertForClient(clientId, {
      waba_id: `${SUITE_PREFIX}waba`,
      phone_number_id: `${SUITE_PREFIX}phone`,
      status: 'connected',
      access_token_encrypted: encrypt('fake-test-token'),
    });

    const orphaned = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}orphaned`, category: 'Utility', status: 'approved', body: 'x',
    });
    await pool.query(
      `update message_templates set meta_template_id = $1, orphaned_at = now() where id = $2`,
      ['meta_gone', orphaned.id]
    );

    const res = await fetch(`${ctx.baseUrl}/api/templates/${orphaned.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x updated', header: { type: 'NONE' } }),
    });
    assert.equal(res.status, 400);
  } finally {
    await teardown(ctx);
  }
});

test('PUT /api/templates/:id: an Authentication template rejects a body/header/footer/buttons edit attempt', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, baseUrl, clientId, authToken } = ctx;
  try {
    const authTemplate = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}otp`, category: 'Authentication', status: 'approved',
      codeExpirationMinutes: 10, addSecurityDisclaimer: true, otpButtonType: 'COPY_CODE',
    });

    const res = await fetch(`${baseUrl}/api/templates/${authTemplate.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'not allowed' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await teardown(ctx);
  }
});

test('PUT /api/templates/:id: a real Meta rejection (edit call fails) returns 502 and leaves the local row unchanged', async () => {
  const ctx = await setup();
  const { pool, wabasRepo, messageTemplatesRepo, encrypt, baseUrl, clientId, authToken } = ctx;
  const originalFetch = global.fetch;
  try {
    await wabasRepo.upsertForClient(clientId, {
      waba_id: `${SUITE_PREFIX}waba`,
      phone_number_id: `${SUITE_PREFIX}phone`,
      status: 'connected',
      access_token_encrypted: encrypt('fake-test-token'),
    });

    const original = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}blocked`, category: 'Utility', status: 'approved', body: 'original body',
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_blocked_1', original.id]);

    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.includes('meta_blocked_1')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'Unknown error from Meta' } }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${original.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'edited body', header: { type: 'NONE' } }),
    });
    assert.equal(res.status, 502);

    const fromDb = await messageTemplatesRepo.findById(pool, clientId, original.id);
    assert.equal(fromDb.body, 'original body', 'local content must survive when the Meta edit genuinely fails');
    assert.equal(fromDb.status, 'approved', 'status must not flip to pending when the edit never actually reached Meta successfully');
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('PUT /api/templates/:id: unknown id returns 404', async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.baseUrl}/api/templates/00000000-0000-0000-0000-000000000000`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ctx.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', header: { type: 'NONE' } }),
    });
    assert.equal(res.status, 404);
  } finally {
    await teardown(ctx);
  }
});
