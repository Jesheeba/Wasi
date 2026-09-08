// Independent QA pass, Phase 2b (Meta Official Template Library) — targets
// blind spots NOT covered by metaTemplateLibrary.test.js: stale-entry
// removal on re-refresh, duplicate (name,language) submission, missing
// button inputs for a button-bearing entry, unvalidated/garbage button
// inputs, 404 on a bogus id, admin-route auth enforcement, and the
// empty-cache case. Only graph.facebook.com is faked; everything else is
// the real code path against the real (shared dev/prod) database, using a
// dedicated disposable test client cleaned up in after().
//
// Originally written to PASS while proving each defect existed
// ("FINDING:"/"BUG CONFIRMED" — same convention as this project's other
// GAP-proving test suites). 3 of the 4 real defects this file found were
// fixed the same session (stale-entry pruning — metaTemplateLibraryRepo.js's
// pruneMissing, wired into metaTemplateLibraryRefreshRunner.js; the
// duplicate (name,language) pre-check and the buttonInputs-vs-buttons_json
// cross-validation — both in routes/templateLibrary.js) — assertions below
// are flipped to prove the fixes instead. The "no buttonInputs at all"
// case is now caught by the new cross-validation check BEFORE it ever
// reaches Meta, so that test's expected outcome changed from a 502
// (simulated Meta rejection) to a 400 (this app's own validation) — an
// earlier, clearer failure, not a regression.
//
// RUN THIS FILE SEPARATELY from metaTemplateLibrary.test.js — see that
// file's own header comment for why: both trigger real admin refreshes
// (metaTemplateLibraryRepo.pruneMissing) against fake, mutually-exclusive
// partial catalogs on the SAME shared cache table; run concurrently, each
// one's prune step deletes the other's rows. Confirmed live while fixing
// the "stale entries never pruned" defect this file itself found.
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

const SUITE_PREFIX = '__test_suite__metatemplatelibqa_';
const TEST_WABA_ID = 'test_suite_metatemplatelibqa_waba_id';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function catalogWithTwoEntries() {
  return {
    data: [
      {
        id: `${SUITE_PREFIX}a`,
        name: `${SUITE_PREFIX}entry_a`,
        language: 'en_US',
        category: 'UTILITY',
        topic: 'SHIPPING',
        usecase: 'SHIPPING_UPDATE',
        industry: ['RETAIL'],
        body: 'Entry A body, no variables.',
        body_params: [],
        buttons: [],
      },
      {
        id: `${SUITE_PREFIX}b`,
        name: `${SUITE_PREFIX}entry_b`,
        language: 'en_US',
        category: 'UTILITY',
        topic: 'SHIPPING',
        usecase: 'SHIPPING_UPDATE',
        industry: ['RETAIL'],
        body: 'Entry B body, no variables.',
        body_params: [],
        buttons: [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }],
      },
    ],
  };
}

function catalogWithOnlyEntryA() {
  return { data: [catalogWithTwoEntries().data[0]] };
}

let graphCreateBehavior = 'always-succeed'; // 'always-succeed' | 'reject-missing-button-inputs' | 'reject-duplicate'
const createdMetaNames = new Set();

async function withFakeGraphFetch(catalogFn, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);

    if (urlStr.includes('/message_template_library')) {
      return { ok: true, json: async () => catalogFn() };
    }
    if (urlStr.includes('/message_templates') && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (!body.library_template_name) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'library_template_name is required' } }) };
      }
      if (graphCreateBehavior === 'reject-missing-button-inputs' && !body.library_template_button_inputs) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'library_template_button_inputs is required for this library template' } }) };
      }
      if (graphCreateBehavior === 'reject-duplicate' && createdMetaNames.has(body.name)) {
        return { ok: false, status: 400, json: async () => ({ error: { message: `(#100) Template name '${body.name}' already exists`, code: 100 } }) };
      }
      createdMetaNames.add(body.name);
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}meta_id_${createdMetaNames.size}`, status: 'APPROVED', category: 'UTILITY' }) };
    }
    return originalFetch(url, options);
  };
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
    graphCreateBehavior = 'always-succeed';
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
      email: `test-suite-metatemplatelibqa-${Date.now()}@wasi.local`,
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
  await pool.query(`delete from message_templates where client_id = $1`, [testClientId]);
  await pool.query(`delete from meta_template_library_cache where name like $1`, [`${SUITE_PREFIX}%`]);
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('FIXED: a cache entry dropped from Meta\'s catalog on re-refresh is now actually removed, not visible to clients forever', async () => {
  // Refresh #1: two entries.
  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    const res = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
  });
  let cached = await pool.query(`select * from meta_template_library_cache where name like $1 order by name`, [`${SUITE_PREFIX}%`]);
  assert.equal(cached.rows.length, 2, 'sanity: both entries cached after refresh #1');

  // Refresh #2: Meta's catalog now only has entry A (entry B "removed" upstream).
  await withFakeGraphFetch(catalogWithOnlyEntryA, async () => {
    const res = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entry_count, 1, 'refresh #2 only fetched/upserted 1 entry from Meta');
  });

  cached = await pool.query(`select * from meta_template_library_cache where name like $1 order by name`, [`${SUITE_PREFIX}%`]);
  assert.equal(cached.rows.length, 1, 'FIX PROOF: entry_b must be pruned from the cache once Meta stops returning it — metaTemplateLibraryRepo.pruneMissing now removes any row not in the latest fetch');
  assert.equal(cached.rows[0].name, `${SUITE_PREFIX}entry_a`);

  const clientRes = await fetch(`${baseUrl}/api/template-library/meta`, { headers: authed(clientToken) });
  const clientEntries = await clientRes.json();
  assert.ok(
    !clientEntries.some((e) => e.name === `${SUITE_PREFIX}entry_b`),
    'FIX PROOF: the client-facing GET /api/template-library/meta must no longer offer entry_b, which Meta itself no longer lists'
  );
});

test('FIXED: submitting the same Meta library entry twice with the same name is now pre-checked locally, same as routes/templates.js POST /', async () => {
  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}entry_a`]);
  const entry = cached.rows[0];
  assert.ok(entry, 'entry_a must still be cached from the previous test');

  const dupName = `${SUITE_PREFIX}dup_name_test`;

  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    // First submission: succeeds.
    const res1 = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({ name: dupName }),
    });
    assert.equal(res1.status, 201, await res1.text());

    // Second submission, same client, same (name, language) — now rejected
    // BEFORE ever reaching Meta (routes/templateLibrary.js now calls
    // messageTemplatesRepo.findActiveByNameAndLanguage, same guard
    // routes/templates.js's POST / already had).
    const res2 = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({ name: dupName }),
    });
    const body2 = await res2.json();
    assert.equal(res2.status, 409, `FIX PROOF: a duplicate (name, language) must now be rejected with 409 before reaching Meta. Got ${res2.status}: ${JSON.stringify(body2)}`);
    assert.match(body2.error, /already exists/i);

    const rows = await pool.query(
      `select id from message_templates where client_id = $1 and name = $2 and language = $3`,
      [testClientId, dupName, entry.language]
    );
    assert.equal(rows.rows.length, 1, 'FIX PROOF: exactly one local row must exist, not two — the second submission never reached messageTemplatesRepo.create');
  });
});

test('FIXED (caught earlier than before): button-bearing entry submitted with NO buttonInputs is now rejected by this app\'s own cross-validation, never reaching Meta at all', async () => {
  // entry_b was deliberately pruned from the cache by the FIRST test in
  // this file (proving stale-entry removal now works) — re-refresh with
  // both entries present before this test needs entry_b again, rather
  // than relying on cross-test leftover state.
  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    const res = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
  });

  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}entry_b`]);
  const entry = cached.rows[0];
  assert.ok(entry, 'entry_b (has a URL button) must be cached again after the re-refresh above');
  assert.ok(entry.buttons_json && entry.buttons_json.length > 0, 'sanity: entry_b really does have a button');

  // graphCreateBehavior stays 'always-succeed' here on purpose — the whole
  // point is proving this never reaches the fake Meta call at all anymore.
  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    const res = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({ name: `${SUITE_PREFIX}no_button_inputs_attempt` }), // no buttonInputs at all
    });
    const body = await res.json();
    assert.equal(res.status, 400, `FIX PROOF: validateButtonInputsMatchEntry must reject this before ever calling Meta. Got ${res.status}: ${JSON.stringify(body)}`);
    assert.match(body.detail, /1 button destination/i);

    const rows = await pool.query('select 1 from message_templates where name = $1', [`${SUITE_PREFIX}no_button_inputs_attempt`]);
    assert.equal(rows.rows.length, 0, 'no local row should be created when the request is rejected pre-flight');
  });
});

test('FIXED: buttonInputs count/type is now cross-checked against the entry\'s real buttons_json — garbage is rejected, not forwarded to Meta', async () => {
  const cached = await pool.query(`select * from meta_template_library_cache where name = $1`, [`${SUITE_PREFIX}entry_a`]);
  const entry = cached.rows[0];
  assert.ok(entry, 'entry_a (ZERO buttons) must still be cached');
  assert.equal((entry.buttons_json || []).length, 0, 'sanity: entry_a has no buttons at all');

  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    // Submit 3 bogus PHONE_NUMBER button inputs against an entry with ZERO
    // buttons — validateButtonInputsMatchEntry (routes/templateLibrary.js)
    // must now reject this before it ever reaches metaClient.createTemplateFromLibrary.
    const res = await fetch(`${baseUrl}/api/template-library/meta/${entry.id}/use`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: `${SUITE_PREFIX}garbage_buttons_attempt`,
        buttonInputs: [
          { type: 'PHONE_NUMBER', phone_number: '+10000000000' },
          { type: 'PHONE_NUMBER', phone_number: '+10000000001' },
          { type: 'PHONE_NUMBER', phone_number: '+10000000002' },
        ],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 400, `FIX PROOF: a 3-input submission against a 0-button entry must be rejected. Got ${res.status}: ${JSON.stringify(body)}`);
    assert.match(body.detail, /0 button destination/i);

    const rows = await pool.query('select 1 from message_templates where name = $1', [`${SUITE_PREFIX}garbage_buttons_attempt`]);
    assert.equal(rows.rows.length, 0);
  });
});

test('POST /meta/:id/use with a random non-existent uuid: clean 404, not a crash', async () => {
  const res = await fetch(`${baseUrl}/api/template-library/meta/00000000-0000-0000-0000-000000000000/use`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}nonexistent_id_attempt` }),
  });
  assert.equal(res.status, 404);
});

// ROOT CAUSE (2026-08-28), precisely, not just "self-reported": an earlier
// draft of this test's restore step passed pg's own SELECT * result
// straight back into the restore INSERT's parameters — but `pool.query`
// auto-parses jsonb columns (industry/buttons_json/body_params) into native
// JS arrays/objects, and node-postgres does NOT serialize a raw JS array
// back to JSON text for a jsonb column parameter; it applies its own
// Postgres-array-literal serialization instead (e.g. `{RETAIL}`, not
// `["RETAIL"]`). Postgres then rejected that as invalid JSON syntax
// (error 22P02) on the very first restore row. Since the DELETE above had
// already committed (no transaction wraps it — see the note below on why
// one can't be used here) and this failure happened inside the `finally`
// block's own loop with no per-row guard, the exception propagated out of
// `finally` immediately, aborting the restore after row 1 and leaving the
// real production cache empty. This exact class of bug can't recur here
// now: (1) every jsonb column is explicitly `JSON.stringify()`-ed before
// the parameter is sent (the direct fix), (2) each row's insert is now
// individually try/caught so ONE malformed row can never abort every row
// after it, and (3) if the restore loses ANY rows for ANY reason, an
// automatic fallback below calls the real refresh runner so the cache is
// self-healing rather than silently left empty for someone to notice later.
//
// A transaction-wrapped delete+restore (BEGIN...ROLLBACK) was considered
// and rejected: the assertions below need the SERVER's own connection
// (routes/templateLibrary.js's `req.db`, a completely separate connection
// from this test) to see the DELETE — which requires it to actually COMMIT,
// not stay inside an uncommitted transaction only this test's own
// connection can see. A rollback-based approach literally cannot produce
// the "empty cache, from another connection's point of view" state this
// test needs to exercise.
test('GET /api/template-library/meta with an entirely empty cache degrades to an empty array, not an error', async () => {
  // Blow away any real cached rows (there may be genuine production content
  // from the live weekly refresh, or other test suites' rows) so this is a
  // true "before any refresh has ever run" simulation, then restore in
  // finally.
  const backup = await pool.query('select * from meta_template_library_cache');
  const backupMeta = await pool.query('select * from meta_template_library_refresh_meta');
  try {
    await pool.query('delete from meta_template_library_cache');
    await pool.query(`update meta_template_library_refresh_meta set last_refreshed_at = null, last_refresh_entry_count = null, last_refresh_error = null where id = true`);

    const res = await fetch(`${baseUrl}/api/template-library/meta`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const entries = await res.json();
    assert.deepEqual(entries, [], 'empty cache must degrade to an empty array, not throw');

    const statusRes = await fetch(`${baseUrl}/api/admin/template-library/meta/status`, { headers: authed(adminToken) });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.last_refreshed_at, null);
    assert.equal(status.cached_total_count, 0);
  } finally {
    // Restore whatever was really there before this test touched it.
    // Per-row try/catch (guard #2 above) — one bad row must never abort
    // every row after it the way it did the first time this test existed.
    await pool.query('delete from meta_template_library_cache');
    let restoredCount = 0;
    for (const row of backup.rows) {
      try {
        await pool.query(
          `insert into meta_template_library_cache (id, meta_library_id, name, category, language, topic, usecase, industry, header_text, body, footer_text, buttons_json, body_params, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            row.id, row.meta_library_id, row.name, row.category, row.language, row.topic, row.usecase,
            row.industry != null ? JSON.stringify(row.industry) : null,
            row.header_text, row.body, row.footer_text,
            row.buttons_json != null ? JSON.stringify(row.buttons_json) : null,
            row.body_params != null ? JSON.stringify(row.body_params) : null,
            row.created_at, row.updated_at,
          ]
        );
        restoredCount++;
      } catch (err) {
        console.error(`metaTemplateLibraryQA.test.js: failed to restore cache row ${row.meta_library_id} (continuing with remaining rows):`, err.message);
      }
    }
    if (backupMeta.rows[0]) {
      const m = backupMeta.rows[0];
      await pool.query(
        `update meta_template_library_refresh_meta set last_refreshed_at = $1, last_refresh_entry_count = $2, last_refresh_error = $3 where id = true`,
        [m.last_refreshed_at, m.last_refresh_entry_count, m.last_refresh_error]
      );
    }
    // Self-healing fallback (guard #3 above): if the backup existed but the
    // restore couldn't put everything back, trigger a real refresh rather
    // than leave production quietly short some entries until someone
    // notices. Never fires when backup.rows was legitimately empty (nothing
    // to restore is not a failure).
    if (backup.rows.length > 0 && restoredCount < backup.rows.length) {
      console.error(`metaTemplateLibraryQA.test.js: restored ${restoredCount}/${backup.rows.length} cache rows — triggering a real refresh to self-heal the rest.`);
      try {
        await metaTemplateLibraryRefreshRunner.refreshNow();
      } catch (err) {
        console.error('metaTemplateLibraryQA.test.js: self-heal refresh also failed — cache may still be incomplete:', err.message);
      }
    }
  }
});

test('admin refresh/status routes reject a CLIENT token (not silently accepted, not a 500)', async () => {
  const res1 = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(clientToken) });
  assert.notEqual(res1.status, 200, 'a client token must not be able to trigger the admin refresh');
  assert.ok([401, 403].includes(res1.status), `expected 401/403, got ${res1.status}`);

  const res2 = await fetch(`${baseUrl}/api/admin/template-library/meta/status`, { headers: authed(clientToken) });
  assert.notEqual(res2.status, 200, 'a client token must not be able to read admin refresh status');
  assert.ok([401, 403].includes(res2.status), `expected 401/403, got ${res2.status}`);

  const res3 = await fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST' });
  assert.ok([401, 403].includes(res3.status), `expected 401/403 with no token at all, got ${res3.status}`);
});

test('two concurrent admin refreshes against the same catalog: both succeed, no unique-constraint crash, exactly the right row count at the end', async () => {
  await withFakeGraphFetch(catalogWithTwoEntries, async () => {
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(adminToken) }),
      fetch(`${baseUrl}/api/admin/template-library/meta/refresh`, { method: 'POST', headers: authed(adminToken) }),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    assert.equal(res1.status, 200, JSON.stringify(body1));
    assert.equal(res2.status, 200, JSON.stringify(body2));
  });

  const cached = await pool.query(`select * from meta_template_library_cache where name like $1`, [`${SUITE_PREFIX}%`]);
  const names = cached.rows.map((r) => r.name);
  const uniqueNames = new Set(names);
  assert.equal(names.length, uniqueNames.size, 'no duplicate rows for the same meta_library_id after concurrent refreshes (on conflict upsert held)');
});
