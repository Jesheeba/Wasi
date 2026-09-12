// Covers 3 fixes for the same underlying gap (a media-header template with
// no default template_media_cache row — e.g. one synced in from Meta via
// templateSyncService.createFromMetaSync, which has no way to backfill a
// media id — silently could not be sent by a plain broadcast/chat send with
// no way to fix it or even understand why):
//   1. mediaHeaderService.resolveMediaId's error message no longer claims
//      "was never uploaded through this app" when other assets DO exist.
//   2. templateMediaCacheRepo.listByTemplateId/setDefault + the two new
//      routes (GET/:id/header-media, POST /:id/header-media/:assetId/default)
//      that let an existing asset be listed and promoted to default.
//   3. templates.js's two media-upload 502 catch sites now use
//      describeMetaError + return metaError, matching create/edit/delete.
// Real DB writes through a disposable test client (same pattern as
// templateEdit.test.js); Meta calls faked by stubbing global.fetch for
// graph.facebook.com only — see CLAUDE.md's testing conventions.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const SUITE_PREFIX = '__test_suite__templatemediaassets_';

async function setup() {
  const { createApp } = require('../src/app');
  const { pool } = require('../src/db/pool');
  const wabasRepo = require('../src/repositories/wabasRepo');
  const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
  const templateMediaCacheRepo = require('../src/repositories/templateMediaCacheRepo');
  const mediaHeaderService = require('../src/services/mediaHeaderService');
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
      email: `test-suite-templatemediaassets-${Date.now()}-${Math.random().toString(36).slice(2)}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const clientId = registered.client?.id;
  const authToken = registered.token;
  assert.ok(clientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(clientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-test-token'),
  });
  const waba = await wabasRepo.findByClientId(clientId);

  return {
    pool, wabasRepo, messageTemplatesRepo, templateMediaCacheRepo, mediaHeaderService,
    server, baseUrl, clientId, authToken, waba,
  };
}

async function teardown({ pool, clientId, server }) {
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
}

test('resolveMediaId: no default and no other assets — "never uploaded" wording, unchanged', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, mediaHeaderService, clientId, waba, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc1`, category: 'Utility', status: 'approved',
      header: { type: 'DOCUMENT' },
    });

    await assert.rejects(
      () => mediaHeaderService.resolveMediaId(pool, clientId, waba, 'fake-token', template, undefined),
      (err) => {
        assert.ok(err instanceof mediaHeaderService.MediaResolutionError);
        assert.match(err.message, /was never uploaded through this app/);
        assert.doesNotMatch(err.message, /no default header media set/);
        return true;
      }
    );
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('resolveMediaId: no default but other assets exist — corrected wording, names the assets', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, mediaHeaderService, clientId, waba, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc2`, category: 'Utility', status: 'approved',
      header: { type: 'DOCUMENT' },
    });
    // Simulates a template synced in from Meta (createFromMetaSync — no
    // cache row at all) that later had media uploaded via POST
    // /:id/header-media (insertAsset — always non-default).
    await templateMediaCacheRepo.insertAsset(pool, clientId, template.id, { mediaId: 'media_1', filename: 'po_form.pdf' });

    await assert.rejects(
      () => mediaHeaderService.resolveMediaId(pool, clientId, waba, 'fake-token', template, undefined),
      (err) => {
        assert.ok(err instanceof mediaHeaderService.MediaResolutionError);
        assert.doesNotMatch(err.message, /was never uploaded through this app/);
        assert.match(err.message, /has no default header media set/);
        assert.match(err.message, /po_form\.pdf/);
        return true;
      }
    );
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('templateMediaCacheRepo.upsert: writes the default row on first call, updates it in place on a second (real bug, was raising "column ... does not exist")', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, clientId, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc9`, category: 'Utility', status: 'approved',
      header: { type: 'DOCUMENT' },
    });

    const first = await templateMediaCacheRepo.upsert(pool, clientId, template.id, { mediaId: 'media_v1', filename: 'v1.pdf' });
    assert.equal(first.is_default, true);
    assert.equal(first.media_id, 'media_v1');

    // A second upsert (the 30-day refresh path, or a re-run of creation)
    // must update the SAME row in place, not insert a duplicate — this is
    // exactly the case the broken ON CONFLICT target used to throw on.
    const second = await templateMediaCacheRepo.upsert(pool, clientId, template.id, { mediaId: 'media_v2', filename: 'v2.pdf' });
    assert.equal(second.id, first.id);
    assert.equal(second.media_id, 'media_v2');

    const rows = await templateMediaCacheRepo.listByTemplateId(pool, clientId, template.id);
    assert.equal(rows.length, 1, 'must still be exactly one row, not a duplicate');
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('templateMediaCacheRepo.setDefault: promotes a non-default asset and demotes the prior default', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, clientId, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc3`, category: 'Utility', status: 'approved',
      header: { type: 'DOCUMENT' },
    });
    const original = await templateMediaCacheRepo.upsert(pool, clientId, template.id, { mediaId: 'media_default', filename: 'original.pdf' });
    const asset = await templateMediaCacheRepo.insertAsset(pool, clientId, template.id, { mediaId: 'media_asset', filename: 'new.pdf' });

    const promoted = await templateMediaCacheRepo.setDefault(pool, clientId, template.id, asset.id);
    assert.equal(promoted.id, asset.id);
    assert.equal(promoted.is_default, true);

    const rows = await templateMediaCacheRepo.listByTemplateId(pool, clientId, template.id);
    const originalRow = rows.find((r) => r.id === original.id);
    const assetRow = rows.find((r) => r.id === asset.id);
    assert.equal(originalRow.is_default, false, 'the prior default must be demoted');
    assert.equal(assetRow.is_default, true);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('templateMediaCacheRepo.setDefault: an assetId from a different template is a no-op, returns null', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, clientId, server } = ctx;
  try {
    const templateA = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc4a`, category: 'Utility', status: 'approved', header: { type: 'DOCUMENT' },
    });
    const templateB = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc4b`, category: 'Utility', status: 'approved', header: { type: 'DOCUMENT' },
    });
    const defaultA = await templateMediaCacheRepo.upsert(pool, clientId, templateA.id, { mediaId: 'media_a', filename: 'a.pdf' });
    const assetB = await templateMediaCacheRepo.insertAsset(pool, clientId, templateB.id, { mediaId: 'media_b', filename: 'b.pdf' });

    const result = await templateMediaCacheRepo.setDefault(pool, clientId, templateA.id, assetB.id);
    assert.equal(result, null);

    // Template A's real default must be untouched, not demoted along the way.
    const rowsA = await templateMediaCacheRepo.listByTemplateId(pool, clientId, templateA.id);
    assert.equal(rowsA.find((r) => r.id === defaultA.id).is_default, true);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('GET /api/templates/:id/header-media: lists default-first, then other assets', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, baseUrl, authToken, clientId, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc5`, category: 'Utility', status: 'approved', header: { type: 'DOCUMENT' },
    });
    await templateMediaCacheRepo.upsert(pool, clientId, template.id, { mediaId: 'media_default5', filename: 'default.pdf' });
    await templateMediaCacheRepo.insertAsset(pool, clientId, template.id, { mediaId: 'media_asset5', filename: 'extra.pdf' });

    const res = await fetch(`${baseUrl}/api/templates/${template.id}/header-media`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 2);
    assert.equal(list[0].isDefault, true);
    assert.equal(list[0].filename, 'default.pdf');
    assert.equal(list[1].isDefault, false);
    assert.equal(list[1].filename, 'extra.pdf');
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('POST /api/templates/:id/header-media/:assetId/default: promotes via the route, 404s for an unknown asset', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, templateMediaCacheRepo, baseUrl, authToken, clientId, server } = ctx;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc6`, category: 'Utility', status: 'approved', header: { type: 'DOCUMENT' },
    });
    const asset = await templateMediaCacheRepo.insertAsset(pool, clientId, template.id, { mediaId: 'media_asset6', filename: 'promote_me.pdf' });

    const res = await fetch(`${baseUrl}/api/templates/${template.id}/header-media/${asset.id}/default`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.isDefault, true);

    const missingRes = await fetch(`${baseUrl}/api/templates/${template.id}/header-media/${crypto.randomUUID()}/default`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(missingRes.status, 404);
  } finally {
    await teardown({ pool, clientId, server });
  }
});

test('POST /api/templates (media header) 502: a real Meta upload rejection surfaces error_user_msg via detail + metaError, not just err.message', async () => {
  const ctx = await setup();
  const { pool, baseUrl, authToken, clientId, server } = ctx;
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.includes('/uploads')) {
        // Resumable Upload API session + byte upload — let creation get far
        // enough to reach the standard Media API upload call below.
        if (options?.method === 'POST' && !urlStr.includes('/media')) {
          return { ok: true, json: async () => ({ id: 'upload_session_1' }) };
        }
      }
      if (urlStr.includes('graph.facebook.com') && urlStr.includes('upload_session_1')) {
        return { ok: true, json: async () => ({ h: 'HANDLE123' }) };
      }
      if (urlStr.includes('graph.facebook.com') && urlStr.endsWith('/media')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              message: 'Invalid parameter',
              error_user_title: 'Media Upload Failed',
              error_user_msg: 'The file you uploaded could not be processed by WhatsApp.',
            },
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: (() => {
        const form = new FormData();
        form.append('data', JSON.stringify({
          name: `${SUITE_PREFIX}doc7`, category: 'Utility', language: 'en_US',
          header: { type: 'DOCUMENT' }, body: 'Here is your document.',
        }));
        form.append('headerFile', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'doc.pdf');
        return form;
      })(),
    });

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'Could not upload header media to Meta');
    assert.equal(body.detail, 'Media Upload Failed — The file you uploaded could not be processed by WhatsApp.');
    assert.equal(body.metaError.error_user_msg, 'The file you uploaded could not be processed by WhatsApp.');
  } finally {
    global.fetch = originalFetch;
    await teardown({ pool, clientId, server });
  }
});

test('POST /:id/header-media 502: same describeMetaError/metaError wiring for the asset-upload route', async () => {
  const ctx = await setup();
  const { pool, messageTemplatesRepo, baseUrl, authToken, clientId, server } = ctx;
  const originalFetch = global.fetch;
  try {
    const template = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}doc8`, category: 'Utility', status: 'approved', header: { type: 'DOCUMENT' },
    });

    global.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('graph.facebook.com') && urlStr.endsWith('/media')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              message: 'Invalid parameter',
              error_user_title: 'Media Upload Failed',
              error_user_msg: 'The file is too large for this header type.',
            },
          }),
        };
      }
      return originalFetch(url, options);
    };

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'doc.pdf');
    const res = await fetch(`${baseUrl}/api/templates/${template.id}/header-media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'Could not upload media to Meta');
    assert.equal(body.detail, 'Media Upload Failed — The file is too large for this header type.');
    assert.equal(body.metaError.error_user_msg, 'The file is too large for this header type.');
  } finally {
    global.fetch = originalFetch;
    await teardown({ pool, clientId, server });
  }
});
