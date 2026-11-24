// Three fixes from a 2026-11-24 client session
// (build-docs/features/hub-api-template-media.md, messaging-limit-visibility.md,
// template-preview-crop.md):
//   1. POST /api/v1/templates accepts a media header (multipart file or
//      headerMediaUrl), uploads it to Meta and seeds the send-time cache.
//   2. The daily messaging limit is reported by GET /api/v1/account and the
//      client tier-status route, counting only first-contact sends.
//   3. The Create Template preview shows the whole image (static checks).
// Only graph.facebook.com is faked. Runs against TEST_DATABASE_URL (a local
// database), never the shared production one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const { encrypt } = require('../src/utils/encryption');

const SUITE_PREFIX = '__test_suite__apitplmedia_';
const WABA_ID = 'test_suite_apitplmedia_waba';
const PHONE_ID = 'test_suite_apitplmedia_phone';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let server;
let baseUrl;
let clientId;
let clientToken;
let apiKey;
let graphCalls = [];

// Fakes the four Graph calls a media-header template makes. Anything not
// graph.facebook.com goes to the real fetch with its options intact.
function installFakeGraph() {
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    graphCalls.push({ url: u, method: options.method || 'GET', body: options.body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (u.includes('/uploads')) return ok({ id: 'upload:FAKE_SESSION' });
    if (u.includes('upload:FAKE_SESSION')) return ok({ h: 'FAKE_HANDLE' });
    if (u.includes(`${PHONE_ID}/media`)) return ok({ id: 'FAKE_MEDIA_ID' });
    if (u.includes(`${WABA_ID}/message_templates`)) return ok({ id: 'FAKE_META_TEMPLATE_ID', status: 'PENDING', category: 'MARKETING' });
    return ok({});
  };
  return () => { global.fetch = realFetch; };
}

function templateJson(name, header) {
  return {
    name,
    category: 'Marketing',
    language: 'en_US',
    body: 'Our annual conference brings together leaders, trainers and coaches. Register before the early fee closes.',
    header,
    buttons: [{ type: 'URL', text: 'Register Now', url: 'https://example.com/register' }],
  };
}

function postMultipart(json, { file = PNG, type = 'image/png', field = 'file' } = {}) {
  const form = new FormData();
  form.append('data', JSON.stringify(json));
  form.append(field, new Blob([file], { type }), 'poster.png');
  return fetch(`${baseUrl}/api/v1/templates`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
}

function postJson(json) {
  return fetch(`${baseUrl}/api/v1/templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
}

before(async () => {
  process.env.META_APP_ID = process.env.META_APP_ID || 'test_app_id';
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: `test-suite-apitplmedia-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(clientId && clientToken, 'test client registration must succeed');

  await wabasRepo.upsertForClient(clientId, {
    waba_id: WABA_ID, phone_number_id: PHONE_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  await pool.query(`update wabas set messaging_tier = 'TIER_250', messaging_tier_checked_at = now(), quality_rating = 'GREEN' where client_id = $1`, [clientId]);
  apiKey = (await apiKeysRepo.create(pool, clientId, `${SUITE_PREFIX}key`)).rawKey;
});

after(async () => {
  if (clientId) {
    await pool.query('delete from audit_log where actor_id = $1 or target like $2', [clientId, `${clientId}%`]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// --- 1. Hub API media header ------------------------------------------------

test('AC1: multipart image header is uploaded to Meta, submitted with the handle, and cached for sending', async () => {
  graphCalls = [];
  const restore = installFakeGraph();
  try {
    const res = await postMultipart(templateJson(`${SUITE_PREFIX}img_ok`.toLowerCase(), { type: 'IMAGE' }));
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.meta_template_id, 'FAKE_META_TEMPLATE_ID');
    assert.equal(body.header_type, 'IMAGE');

    const create = graphCalls.find((c) => c.url.includes('/message_templates'));
    assert.ok(create, 'template must be submitted to Meta');
    assert.match(String(create.body), /FAKE_HANDLE/, 'Meta payload must carry the upload handle as the header example');

    const { rows } = await pool.query('select media_id, is_default from template_media_cache where template_id = $1', [body.id]);
    assert.deepEqual(rows.map((r) => [r.media_id, r.is_default]), [['FAKE_MEDIA_ID', true]]);
  } finally { restore(); }
});

test('AC2: media header with no file and no headerMediaUrl is a 400 before any Meta call', async () => {
  graphCalls = [];
  const restore = installFakeGraph();
  try {
    const res = await postJson(templateJson(`${SUITE_PREFIX}img_missing`.toLowerCase(), { type: 'IMAGE' }));
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'header_media_required');
    assert.equal(graphCalls.length, 0);
  } finally { restore(); }
});

test('AC3: wrong file type is rejected with the accepted types listed', async () => {
  const res = await postMultipart(templateJson(`${SUITE_PREFIX}img_badtype`.toLowerCase(), { type: 'IMAGE' }), { file: Buffer.from('hello'), type: 'text/plain' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_header_media');
  assert.match(body.error.message, /image\/jpeg/);
});

test('AC4: headerMediaUrl must be public https (SSRF guard) - http is rejected', async () => {
  const res = await postJson({ ...templateJson(`${SUITE_PREFIX}img_http`.toLowerCase(), { type: 'IMAGE' }), headerMediaUrl: 'http://127.0.0.1/poster.png' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_header_media');
});

test('AC5: a file sent with a non-media header is rejected, not silently dropped', async () => {
  const res = await postMultipart(templateJson(`${SUITE_PREFIX}text_with_file`.toLowerCase(), { type: 'TEXT', text: 'Annual conference' }));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'unexpected_header_media');
});

test('AC6: file under the wrong field name is a clear 400 (not a 500)', async () => {
  const res = await postMultipart(templateJson(`${SUITE_PREFIX}img_field`.toLowerCase(), { type: 'IMAGE' }), { field: 'headerFile' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'invalid_upload');
});

test('AC7: same name + language twice is a 409, not a second Meta submission', async () => {
  graphCalls = [];
  const restore = installFakeGraph();
  try {
    const res = await postMultipart(templateJson(`${SUITE_PREFIX}img_ok`.toLowerCase(), { type: 'IMAGE' }));
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.error.code, 'template_name_taken');
    assert.equal(graphCalls.length, 0);
  } finally { restore(); }
});

test('AC8: plain JSON text templates still work unchanged', async () => {
  const restore = installFakeGraph();
  try {
    const res = await postJson(templateJson(`${SUITE_PREFIX}plain`.toLowerCase(), undefined));
    assert.equal(res.status, 201);
  } finally { restore(); }
});

// --- 2. Messaging limit -----------------------------------------------------

async function seedSends() {
  const mk = (i) => chatsRepo.create(pool, clientId, { name: `${SUITE_PREFIX}chat_${i}`, phone: `91888880000${i}`, unread_count: 0 });
  // A: first-contact send -> counts.
  const a = await mk(1);
  await chatsRepo.insertOutboundPending(pool, clientId, a.id, 'hello');
  // B: customer wrote 1h earlier (open window) -> does not count.
  const b = await mk(2);
  await chatsRepo.insertInbound(pool, clientId, b.id, { metaMessageId: `${SUITE_PREFIX}in_b`, body: 'hi', sentAt: new Date(Date.now() - 3600 * 1000) });
  await chatsRepo.insertOutboundPending(pool, clientId, b.id, 'reply');
  // C: failed send -> does not count.
  const c = await mk(3);
  const failed = await chatsRepo.insertOutboundPending(pool, clientId, c.id, 'failed one');
  await pool.query(`update messages set status = 'failed' where id = $1`, [failed.id]);
  // D: customer wrote 30h earlier (window closed) -> counts.
  const d = await mk(4);
  await chatsRepo.insertInbound(pool, clientId, d.id, { metaMessageId: `${SUITE_PREFIX}in_d`, body: 'old', sentAt: new Date(Date.now() - 30 * 3600 * 1000) });
  await chatsRepo.insertOutboundPending(pool, clientId, d.id, 'later');
}

test('AC9: used-today counts only first-contact, non-failed sends (Meta\'s rule)', async () => {
  await seedSends();
  const res = await fetch(`${baseUrl}/api/broadcasts/tier-status`, { headers: { Authorization: `Bearer ${clientToken}` } });
  const s = await res.json();
  assert.equal(res.status, 200);
  assert.equal(s.tier, 'TIER_250');
  assert.equal(s.capNumber, 250);
  assert.equal(s.usedToday, 2, 'A and D count; B (open window) and C (failed) do not');
  assert.equal(s.remaining, 248);
  assert.equal(s.qualityRating, 'GREEN');
  assert.equal(s.connected, true);
});

test('AC10: GET /api/v1/account reports messaging_limit for API/n8n callers', async () => {
  const res = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.messaging_limit.tier, 'TIER_250');
  assert.equal(body.messaging_limit.limit_per_24h, 250);
  assert.equal(body.messaging_limit.used_last_24h, 2);
  assert.equal(body.messaging_limit.remaining, 248);
  assert.equal(body.messaging_limit.unlimited, false);
});

test('AC11: unknown tier never claims a number', async () => {
  await pool.query('update wabas set messaging_tier = null where client_id = $1', [clientId]);
  try {
    const res = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = await res.json();
    assert.equal(body.messaging_limit.tier, null);
    assert.equal(body.messaging_limit.limit_per_24h, null);
    assert.equal(body.messaging_limit.remaining, null);
  } finally {
    await pool.query(`update wabas set messaging_tier = 'TIER_250' where client_id = $1`, [clientId]);
  }
});

test('AC12: the limit card is wired into Campaigns and Settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  assert.match(html, /id="campaign-limit-card"/);
  assert.match(html, /id="settings-limit-card"/);
  assert.match(js, /renderMessagingLimitCard\(document\.getElementById\('campaign-limit-card'\)\)/);
  assert.match(js, /renderMessagingLimitCard\(document\.getElementById\('settings-limit-card'\)\)/);
});

// --- 3. Preview crop ---------------------------------------------------------

test('AC13: template preview shows the whole image (contain, not a cropped 140px strip)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'index.css'), 'utf8');
  const rule = css.match(/\n\.template-preview-media-thumb \{([^}]*)\}/);
  assert.ok(rule, 'base thumb rule exists');
  assert.match(rule[1], /object-fit:\s*contain/);
  assert.doesNotMatch(rule[1], /max-height:\s*140px/);
});
