// Template sync (server/src/services/templateSyncService.js). Most of this
// is pure-function testing (reconcileTemplates, metaClient.js's
// parseTemplateComponents) — no DB, no network, same reasoning
// templateParams.test.js documents for keeping that logic separate from
// metaClient.js's actual fetch calls. Two exceptions: the pagination test
// stubs global.fetch directly (no real Meta App needed to prove the
// paging.next walk works), and the end-to-end test stubs
// metaClient.listTemplates and runs the real reconcile + real DB writes
// through a dedicated test client, proving insert/update/orphan/
// idempotency together, not just in isolation.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileTemplates } = require('../src/services/templateSyncService');
const metaClient = require('../src/utils/metaClient');

const SUITE_PREFIX = '__test_suite__templatesync_';

// --- reconcileTemplates: pure, no DB/network ---

test('reconcileTemplates: a template on Meta with no local row is inserted', () => {
  const meta = [{
    id: 'meta_1', name: 'shipping_update', status: 'APPROVED', category: 'UTILITY', language: 'en_US',
    components: [{ type: 'BODY', text: 'Your order has shipped.' }],
  }];
  const { toInsert, toUpdate, toOrphan } = reconcileTemplates(meta, []);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].meta_template_id, 'meta_1');
  assert.equal(toInsert[0].name, 'shipping_update');
  assert.equal(toInsert[0].status, 'approved');
  assert.equal(toInsert[0].category, 'Utility');
  assert.equal(toInsert[0].body, 'Your order has shipped.');
  assert.equal(toUpdate.length, 0);
  assert.equal(toOrphan.length, 0);
});

test('reconcileTemplates: Meta\'s literal "NONE" rejected_reason sentinel is treated as no reason, not stored as text', () => {
  // Confirmed live against the real WABA: a non-rejected template's
  // rejected_reason field isn't absent or null, it's the string "NONE".
  const meta = [{
    id: 'meta_2', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US',
    rejected_reason: 'NONE', components: [{ type: 'BODY', text: 'Hello World' }],
  }];
  const { toInsert } = reconcileTemplates(meta, []);
  assert.equal(toInsert[0].rejection_reason, null);
});

test('reconcileTemplates: a template matched by meta_template_id updates status/category/rejection_reason only', () => {
  const meta = [{
    id: 'meta_1', name: 'shipping_update', status: 'REJECTED', category: 'MARKETING', language: 'en_US',
    rejected_reason: 'Promotional content', components: [{ type: 'BODY', text: 'x' }],
  }];
  const local = [{ id: 'local-uuid-1', meta_template_id: 'meta_1', name: 'shipping_update', status: 'pending', category: 'Utility' }];
  const { toInsert, toUpdate, toOrphan } = reconcileTemplates(meta, local);
  assert.equal(toInsert.length, 0);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].localId, 'local-uuid-1');
  assert.equal(toUpdate[0].status, 'rejected');
  assert.equal(toUpdate[0].category, 'Marketing');
  assert.equal(toUpdate[0].rejection_reason, 'Promotional content');
  assert.equal(toOrphan.length, 0);
});

test('reconcileTemplates: a template matched by name (no meta_template_id stored yet) still updates and backfills the id', () => {
  const meta = [{ id: 'meta_9', name: 'legacy_template', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }];
  const local = [{ id: 'local-uuid-2', meta_template_id: null, name: 'legacy_template', status: 'pending', category: 'Utility' }];
  const { toUpdate } = reconcileTemplates(meta, local);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].meta_template_id, 'meta_9');
});

test('reconcileTemplates: a local row with a meta_template_id no longer on Meta is orphaned', () => {
  const local = [{ id: 'local-uuid-3', meta_template_id: 'meta_gone', name: 'deleted_on_meta', status: 'approved', orphaned_at: null }];
  const { toOrphan } = reconcileTemplates([], local);
  assert.deepEqual(toOrphan, ['local-uuid-3']);
});

test('reconcileTemplates: a local draft never submitted (no meta_template_id) is never orphaned, inserted, or updated', () => {
  const local = [{ id: 'local-uuid-4', meta_template_id: null, name: 'my_draft', status: 'pending', orphaned_at: null }];
  const { toOrphan, toInsert, toUpdate } = reconcileTemplates([], local);
  assert.deepEqual(toOrphan, []);
  assert.equal(toInsert.length, 0);
  assert.equal(toUpdate.length, 0);
});

test('reconcileTemplates: an already-orphaned row is not re-flagged', () => {
  const local = [{ id: 'local-uuid-5', meta_template_id: 'meta_gone', name: 'x', status: 'approved', orphaned_at: '2026-01-01T00:00:00Z' }];
  const { toOrphan } = reconcileTemplates([], local);
  assert.deepEqual(toOrphan, []);
});

test('reconcileTemplates: idempotent — running twice with identical input produces identical output', () => {
  const meta = [{ id: 'meta_1', name: 'a', status: 'APPROVED', category: 'UTILITY', components: [] }];
  const local = [];
  const first = reconcileTemplates(meta, local);
  const second = reconcileTemplates(meta, local);
  assert.deepEqual(first, second);
});

// --- parseTemplateComponents: pure, no DB/network ---

test('parseTemplateComponents: a variable-less template has no example, no throw', () => {
  const result = metaClient.parseTemplateComponents([{ type: 'BODY', text: 'Your order has shipped.' }]);
  assert.equal(result.body, 'Your order has shipped.');
  assert.equal(result.bodyParamExamples, null);
});

test('parseTemplateComponents: no components array at all does not throw', () => {
  const result = metaClient.parseTemplateComponents(undefined);
  assert.equal(result.body, null);
  assert.equal(result.bodyParamExamples, null);
});

test('parseTemplateComponents: a numbered {{1}}/{{2}} template is parsed and stored as-is, not rejected', () => {
  const result = metaClient.parseTemplateComponents([{
    type: 'BODY',
    text: 'Hi {{1}}, your order {{2}} has shipped.',
    example: { body_text: [['Riyaz', 'WASI-1234']] },
  }]);
  assert.equal(result.body, 'Hi {{1}}, your order {{2}} has shipped.');
  assert.deepEqual(result.bodyParamExamples, { 1: 'Riyaz', 2: 'WASI-1234' });
});

test('parseTemplateComponents: named parameters, header, footer, and buttons are all extracted', () => {
  const result = metaClient.parseTemplateComponents([
    { type: 'HEADER', format: 'TEXT', text: 'Shipping Update' },
    { type: 'BODY', text: 'Hi {{customer_name}}, your order has shipped.', example: { body_text_named_params: [{ param_name: 'customer_name', example: 'Riyaz' }] } },
    { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://example.com' }] },
  ]);
  assert.equal(result.headerType, 'TEXT');
  assert.equal(result.headerContent, 'Shipping Update');
  assert.deepEqual(result.bodyParamExamples, { customer_name: 'Riyaz' });
  assert.equal(result.footerText, 'Reply STOP to unsubscribe');
  assert.deepEqual(result.buttons, [{ type: 'URL', text: 'Track', url: 'https://example.com', phone_number: null }]);
});

// --- listTemplates: real pagination-walking logic, fetch mocked ---

test('listTemplates: walks paging.next until exhausted, concatenating every page, re-appending access_token', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async (url) => {
    callCount++;
    const urlStr = url.toString();
    if (callCount === 1) {
      assert.match(urlStr, /\/waba_pagination_test\/message_templates/);
      assert.match(urlStr, /access_token=fake-token/);
      return {
        ok: true,
        json: async () => ({
          data: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }],
          paging: { next: 'https://graph.facebook.com/v21.0/waba_pagination_test/message_templates?after=CURSOR1' },
        }),
      };
    }
    if (callCount === 2) {
      // paging.next as actually returned by Meta carries no access_token —
      // confirmed against a real response earlier this session — so this
      // proves listTemplates re-appends it rather than dropping auth on
      // page 2+.
      assert.match(urlStr, /after=CURSOR1/);
      assert.match(urlStr, /access_token=fake-token/);
      return {
        ok: true,
        json: async () => ({
          data: [{ id: '3', name: 'c' }],
          paging: {},
        }),
      };
    }
    throw new Error('unexpected extra fetch call — pagination did not stop when paging.next was absent');
  };

  try {
    const result = await metaClient.listTemplates('waba_pagination_test', 'fake-token');
    assert.equal(callCount, 2);
    assert.deepEqual(result.map((t) => t.id), ['1', '2', '3']);
  } finally {
    global.fetch = originalFetch;
  }
});

// --- syncTemplates end-to-end: real DB writes, real HTTP client, metaClient.listTemplates stubbed ---

test('syncTemplates end-to-end: insert, update, orphan, drafts-untouched, and idempotency across two real runs', async () => {
  const { createApp } = require('../src/app');
  const { pool } = require('../src/db/pool');
  const wabasRepo = require('../src/repositories/wabasRepo');
  const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
  const { encrypt } = require('../src/utils/encryption');
  const templateSyncService = require('../src/services/templateSyncService');

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://localhost:${server.address().port}`;

  let clientId;
  const originalListTemplates = metaClient.listTemplates;
  try {
    const registered = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: `${SUITE_PREFIX}client`,
        email: `test-suite-templatesync-${Date.now()}@wasi.local`,
        password: 'test-suite-password-12345',
      }),
    }).then((r) => r.json());
    clientId = registered.client?.id;
    assert.ok(clientId, 'dedicated test client registration must succeed');

    await wabasRepo.upsertForClient(clientId, {
      waba_id: `${SUITE_PREFIX}waba`,
      phone_number_id: `${SUITE_PREFIX}phone`,
      status: 'connected',
      access_token_encrypted: encrypt('fake-test-token'),
    });

    // Pre-seed: one row that will be matched+updated, one that will be
    // orphaned, and one genuine draft that sync must never touch.
    const toBeUpdated = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}will_be_updated`, category: 'Utility', status: 'pending', body: 'Hi {{customer_name}}, thanks.',
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_existing', toBeUpdated.id]);

    const toBeOrphaned = await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}will_be_orphaned`, category: 'Utility', status: 'approved', body: 'x {{a}}',
    });
    await pool.query('update message_templates set meta_template_id = $1 where id = $2', ['meta_gone', toBeOrphaned.id]);

    await messageTemplatesRepo.create(pool, {
      client_id: clientId, name: `${SUITE_PREFIX}my_draft`, category: 'Utility', status: 'pending', body: 'Draft {{x}}',
    });

    const canned = [
      { id: 'meta_existing', name: `${SUITE_PREFIX}will_be_updated`, status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hi {{customer_name}}, thanks.' }] },
      { id: 'meta_new', name: `${SUITE_PREFIX}brand_new_on_meta`, status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'New template body here.' }] },
    ];
    metaClient.listTemplates = async () => canned;

    const first = await templateSyncService.syncTemplates(pool, clientId);
    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 1);
    assert.equal(first.orphaned, 1);

    const afterFirst = await messageTemplatesRepo.listByClientId(pool, clientId);
    const updated = afterFirst.find((t) => t.name === `${SUITE_PREFIX}will_be_updated`);
    assert.equal(updated.status, 'approved');

    const orphaned = afterFirst.find((t) => t.name === `${SUITE_PREFIX}will_be_orphaned`);
    assert.ok(orphaned.orphaned_at, 'orphaned row must have orphaned_at set');
    assert.equal(orphaned.status, 'approved', 'orphaning never changes status, and never deletes the row');

    const draft = afterFirst.find((t) => t.name === `${SUITE_PREFIX}my_draft`);
    assert.equal(draft.orphaned_at, null, 'a local draft never submitted must never be touched by sync');

    const inserted = afterFirst.find((t) => t.name === `${SUITE_PREFIX}brand_new_on_meta`);
    assert.ok(inserted, 'a template that exists only on Meta must be inserted');
    assert.equal(inserted.meta_template_id, 'meta_new');

    // Idempotency: identical Meta response, run again.
    const second = await templateSyncService.syncTemplates(pool, clientId);
    assert.equal(second.inserted, 0, 'no duplicate insert on a second run');
    assert.equal(second.orphaned, 0, 'an already-orphaned row is not re-counted');

    const afterSecond = await messageTemplatesRepo.listByClientId(pool, clientId);
    assert.equal(afterSecond.length, afterFirst.length, 'no duplicate rows created by running sync twice');
  } finally {
    metaClient.listTemplates = originalListTemplates;
    if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
    await new Promise((resolve) => server.close(resolve));
  }
});
