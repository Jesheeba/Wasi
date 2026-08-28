// DELETE /api/templates/:id (server/src/routes/templates.js) — deletes a
// template on Meta (when it was ever submitted there) before removing the
// local row, so the two never diverge. Real DB writes through a disposable
// test client (same pattern as templateSync.test.js); Meta calls faked by
// stubbing global.fetch for graph.facebook.com only, never the app's own
// local-server fetches — see CLAUDE.md's testing conventions.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SUITE_PREFIX = '__test_suite__templatedelete_';

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
      email: `test-suite-templatedelete-${Date.now()}-${Math.random().toString(36).slice(2)}@wasi.local`,
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

test('DELETE /api/templates/:id: a draft never submitted to Meta (no meta_template_id) is deleted locally, no Meta call made', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, baseUrl, clientId, authToken } = ctx;
  const originalFetch = global.fetch;
  try {
    const draft = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}draft`, category: 'Utility', status: 'pending', body: 'Hi {{name}}.',
    });

    global.fetch = async (url, options) => {
      if (url.toString().includes('graph.facebook.com')) {
        throw new Error('must not call Meta for a template never submitted there');
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${draft.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 204);

    const remaining = await messageTemplatesRepo.findById(pool, clientId, draft.id);
    assert.equal(remaining, null);
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('DELETE /api/templates/:id: a template on Meta is deleted there (scoped by name + hsm_id) then locally', async () => {
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

    const submitted = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}submitted`, category: 'Utility', status: 'approved', body: 'Hi {{name}}.',
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_submitted_1', submitted.id]);

    let deleteCall = null;
    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.includes('message_templates')) {
        deleteCall = urlStr;
        return { ok: true, json: async () => ({ success: true }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${submitted.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 204);

    assert.ok(deleteCall, 'must call Meta to delete the template');
    assert.match(deleteCall, new RegExp(`name=${SUITE_PREFIX}submitted`));
    assert.match(deleteCall, /hsm_id=meta_submitted_1/);
    assert.match(deleteCall, /access_token=fake-test-token/);

    const remaining = await messageTemplatesRepo.findById(pool, clientId, submitted.id);
    assert.equal(remaining, null);
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('DELETE /api/templates/:id: an orphaned row (already gone from Meta per a prior sync) skips the Meta call', async () => {
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

    const orphaned = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}orphaned`, category: 'Utility', status: 'approved', body: 'x',
    });
    await pool.query(
      `update message_templates set meta_template_id = $1, orphaned_at = now() where id = $2`,
      ['meta_gone', orphaned.id]
    );

    global.fetch = async (url, options) => {
      if (url.toString().includes('graph.facebook.com')) {
        throw new Error('must not call Meta for an already-orphaned template');
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${orphaned.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 204);

    const remaining = await messageTemplatesRepo.findById(pool, clientId, orphaned.id);
    assert.equal(remaining, null);
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('DELETE /api/templates/:id: a real Meta rejection (not an "already gone" case) blocks the local delete, returns 502', async () => {
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

    const submitted = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}blocked`, category: 'Utility', status: 'approved', body: 'x',
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_blocked_1', submitted.id]);

    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.includes('message_templates')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'Unknown error from Meta' } }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates/${submitted.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 502);

    const remaining = await messageTemplatesRepo.findById(pool, clientId, submitted.id);
    assert.ok(remaining, 'local row must survive when the Meta delete genuinely fails');
  } finally {
    global.fetch = originalFetch;
    await teardown(ctx);
  }
});

test('DELETE /api/templates/:id: unknown id returns 404', async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.baseUrl}/api/templates/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await teardown(ctx);
  }
});
