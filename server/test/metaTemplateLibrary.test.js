// Meta Official Template Library (wasi-master-plan.md §2b, build plan
// Phase 2b) — distinct from templateLibrary.test.js (Wasi's own curated
// library). Covers: the admin refresh pipeline actually calls Meta's real
// catalog endpoint shape and filters to UTILITY-only, the client-facing
// listing only ever exposes zero-variable entries (Phase 0 decision), the
// "use" flow submits via the SAME POST /{waba-id}/message_templates
// endpoint standard template creation uses (just a different payload),
// persists a real message_templates row, and a parameterized entry is
// rejected server-side even if directly targeted by id (defense in depth
// beyond what the listing endpoint happens to filter). Only
// graph.facebook.com is faked — everything else is the real code path
// against the real (shared dev/prod) database, dedicated disposable test
// client, deleted in after().
//
// RUN THIS FILE SEPARATELY from metaTemplateLibraryQA.test.js (never
// combined in one `node --test` invocation with it) — found live while
// fixing the Auditor/QA-reported "stale cache entries never pruned" bug:
// metaTemplateLibraryRepo.pruneMissing (called by every real admin refresh,
// including the ones both test files trigger) deletes any
// meta_template_library_cache row NOT in the fetch it just saw. Node's test
// runner isolates each file into its own process by default, but both
// processes still race against the SAME shared cache table — if this
// file's refresh (fake catalog: shipping_confirmation/low_balance_warning)
// runs concurrently with the QA file's refresh (fake catalog:
// entry_a/entry_b), each one's prune step deletes the OTHER's just-inserted
// rows, since neither fake catalog contains the other's entries. This
// mirrors CLAUDE.md's documented "live background workers racing test
// data" hazard class, but from two TEST processes colliding on a
// prune-on-refresh table, not a live production runner.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const metaTemplateLibraryRepo = require('../src/repositories/metaTemplateLibraryRepo');
const metaTemplateLibraryRefreshRunner = require('../src/services/metaTemplateLibraryRefreshRunner');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;

const SUITE_PREFIX = '__test_suite__metatemplatelib_';
const TEST_WABA_ID = 'test_suite_metatemplatelib_waba_id';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// A real Meta catalog response shape, verified against Meta's own
// documentation during Phase 0 (positional {{n}} params, category field,
// buttons array) — not a guessed/simplified fixture.
function fakeCatalogResponse() {
  return {
    data: [
      {
        id: `${SUITE_PREFIX}zero_var_1`,
        name: `${SUITE_PREFIX}shipping_confirmation`,
        language: 'en_US',
        category: 'UTILITY',
        topic: 'SHIPPING',
        usecase: 'SHIPPING_UPDATE',
        industry: ['RETAIL'],
        body: 'Your order has shipped and is on its way!',
        body_params: [],
        buttons: [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }],
      },
      {
        id: `${SUITE_PREFIX}param_1`,
        name: `${SUITE_PREFIX}low_balance_warning`,
        language: 'en_US',
        category: 'UTILITY',
        topic: 'PAYMENTS',
        usecase: 'LOW_BALANCE_WARNING',
        industry: ['FINANCIAL_SERVICES'],
        body: 'Hi {{1}}, your balance is below {{2}}.',
        body_params: ['Jim', '$75.00'],
        buttons: [],
      },
      {
        // Deliberately MARKETING — proves the refresh pipeline filters to
        // UTILITY only (Phase 0 finding: "Must be UTILITY for use with
        // Template Library"), not just relying on Meta to never return one.
        id: `${SUITE_PREFIX}marketing_1`,
        name: `${SUITE_PREFIX}promo_blast`,
        language: 'en_US',
        category: 'MARKETING',
        topic: 'PROMOTIONS',
        usecase: 'SALE',
        industry: ['RETAIL'],
        body: 'Big sale this weekend!',
        body_params: [],
        buttons: [],
      },
    ],
  };
}

let lastCreateRequestBody = null;

async function withFakeGraphFetch(fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);

    if (urlStr.includes('/message_template_library')) {
      return { ok: true, json: async () => fakeCatalogResponse() };
    }
    if (urlStr.includes('/message_templates') && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      lastCreateRequestBody = body; // inspected by the button-payload-shape test below
      if (!body.library_template_name) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'library_template_name is required' } }) };
      }
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}meta_created_id`, status: 'APPROVED', category: 'UTILITY' }) };
    }
    return originalFetch(url, options);
  };
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
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
      email: `test-suite-metatemplatelib-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(testClientId && clientToken, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: `${SUITE_PREFIX}phone`, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');
});

after(async () => {
  await pool.query(`delete from meta_template_library_cache where name like $1`, [`${SUITE_PREFIX}%`]);
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('admin refresh: fetches Meta\'s catalog, keeps only UTILITY category, stores positional body_params as-is', async () => {
  await withFakeGraphFetch(async () => {
    const res = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, {
      method: 'POST', headers: authed(adminToken),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  const { rows: cached } = await pool.query(
    `select * from meta_template_library_cache where name like $1 order by name`, [`${SUITE_PREFIX}%`]
  );
  assert.equal(cached.length, 2, 'exactly the 2 UTILITY entries must be cached — the MARKETING one must be filtered out');
  assert.ok(!cached.some((c) => c.name === `${SUITE_PREFIX}promo_blast`), 'the MARKETING entry must never reach the cache');

  const paramEntry = cached.find((c) => c.name === `${SUITE_PREFIX}low_balance_warning`);
  assert.deepEqual(paramEntry.body_params, ['Jim', '$75.00'], 'positional param example values must be stored as Meta returned them, not transformed');

  const zeroVarEntry = cached.find((c) => c.name === `${SUITE_PREFIX}shipping_confirmation`);
  assert.deepEqual(zeroVarEntry.buttons_json, [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }]);
});

test('admin status: reflects the real refresh result', async () => {
  const res = await fetch(`${baseUrl}/api/admin/template-library/meta/status`, { headers: authed(adminToken) });
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.ok(status.last_refreshed_at);
  assert.equal(status.last_refresh_error, null);
  assert.ok(status.cached_total_count >= 2);
});

test('GET /api/template-library/meta (client-facing) only returns zero-variable entries', async () => {
  const res = await fetch(`${baseUrl}/api/template-library/meta`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const entries = await res.json();
  assert.ok(entries.some((e) => e.name === `${SUITE_PREFIX}shipping_confirmation`), 'the zero-variable entry must be listed');
  assert.ok(!entries.some((e) => e.name === `${SUITE_PREFIX}low_balance_warning`), 'the parameterized entry must NOT be listed — Wasi\'s pipeline is named-params-only, positional isn\'t supported yet');
});

test('POST /api/template-library/meta/:id/use: real end-to-end, same message_templates endpoint standard creation uses', async () => {
  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}shipping_confirmation`]);
  const entry = cached.rows[0];
  assert.ok(entry);

  let template;
  await withFakeGraphFetch(async () => {
    const res = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({
        name: `${SUITE_PREFIX}my_shipping_template`,
        buttonInputs: [{ type: 'URL', base_url: 'https://my-real-store.example.com' }],
      }),
    });
    const responseText = await res.text();
    assert.equal(res.status, 201, responseText);
    template = JSON.parse(responseText);
  });

  assert.equal(template.client_id, testClientId);
  assert.equal(template.name, `${SUITE_PREFIX}my_shipping_template`);
  assert.equal(template.category, 'Utility');
  assert.equal(template.status, 'approved');
  assert.equal(template.meta_template_id, `${SUITE_PREFIX}meta_created_id`);
  assert.equal(template.body, entry.body, 'body must be Meta\'s own fixed content, unmodified');

  const { rows } = await pool.query('select * from message_templates where id = $1', [template.id]);
  assert.equal(rows.length, 1, 'a real message_templates row must exist, same table standard creation writes to');

  // Independent Auditor finding #1: the actual payload sent to Meta must
  // nest a URL button's destination under `url: { base_url }` (Meta's own
  // documented library_template_button_inputs shape) — an earlier version
  // sent it flat as `{ type: 'URL', base_url }`, which Meta would have
  // rejected or silently mishandled on every real submission.
  assert.deepEqual(
    lastCreateRequestBody.library_template_button_inputs,
    [{ type: 'URL', url: { base_url: 'https://my-real-store.example.com' } }],
    'the outgoing Graph API payload must use Meta\'s real nested url.base_url shape, not a flat base_url field'
  );

  // Independent Auditor finding #2: the LOCALLY stored button must reflect
  // what the client actually submitted to Meta (their real store URL), not
  // the cached catalog entry's own placeholder example
  // (https://example.com/track) — an earlier version stored the cached
  // entry's raw buttons_json unchanged, which would have silently reverted
  // to Meta's placeholder the next time this template was edited.
  assert.equal(rows[0].buttons[0].url, 'https://my-real-store.example.com', 'the persisted button URL must be the client\'s real submitted destination, not Meta\'s catalog placeholder');
  assert.notEqual(rows[0].buttons[0].url, 'https://example.com/track');
});

test('POST /api/template-library/meta/:id/use: a parameterized entry is rejected server-side, even targeted directly by id', async () => {
  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}low_balance_warning`]);
  const entry = cached.rows[0];
  assert.ok(entry);

  const res = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}should_not_be_created` }),
  });
  assert.equal(res.status, 400, 'a parameterized library entry must never be submittable, even bypassing the listing filter');

  const { rows } = await pool.query('select 1 from message_templates where name = $1', [`${SUITE_PREFIX}should_not_be_created`]);
  assert.equal(rows.length, 0);
});

test('POST /api/template-library/meta/:id/use: requires a connected WhatsApp number', async () => {
  const other = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_noWaba`,
      email: `test-suite-metatemplatelib-nowaba-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());

  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}shipping_confirmation`]);
  const entry = cached.rows[0];

  const res = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
    method: 'POST',
    headers: authed(other.token),
    body: JSON.stringify({ name: `${SUITE_PREFIX}no_waba_attempt` }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Connect WhatsApp/i);

  await pool.query('delete from clients where id = $1', [other.client.id]);
});

test('refreshNow throws a clear error when no WABA is connected anywhere', async () => {
  // Monkey-patches wabasRepo.findAnyConnected for this one call only,
  // rather than actually disconnecting any real client's WABA in this
  // shared dev/prod database — restored in finally regardless of outcome.
  const original = wabasRepo.findAnyConnected;
  wabasRepo.findAnyConnected = async () => null;
  try {
    await assert.rejects(
      () => metaTemplateLibraryRefreshRunner.refreshNow(),
      /No connected WABA available/i
    );
  } finally {
    wabasRepo.findAnyConnected = original;
  }
});
