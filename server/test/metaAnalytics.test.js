// Meta analytics (build-docs/features/meta-analytics.md): WhatsApp cost from
// pricing_analytics and template performance from template_analytics. Meta
// is faked via global.fetch; local test DB, disposable client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');

const PREFIX = '__test_suite__metaan_';
const EMAIL = `test-suite-metaan-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba_${Date.now()}`;
let server, base, token, clientId;
let metaCalls = [];
let metaReply = () => ({});
const realFetch = global.fetch;
const DAY1 = Date.UTC(2026, 10, 20) / 1000;
const DAY2 = Date.UTC(2026, 10, 21) / 1000;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const call = { url: decodeURIComponent(u), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    metaCalls.push(call);
    return new Response(JSON.stringify(metaReply(call)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  const reg = await realFetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, 'p1', 'connected', $3)`,
    [clientId, WABA_ID, encrypt('fake-token')]);
  for (let i = 1; i <= 12; i++) {
    await pool.query(`insert into message_templates (client_id, name, category, status, body, language, meta_template_id) values ($1, $2, 'UTILITY', 'approved', 'x', 'en', $3)`,
      [clientId, `tpl_${String(i).padStart(2, '0')}`, `90${i}`]);
  }
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; metaReply = () => ({}); });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

test('cost: asks Meta for daily pricing by category and adds it up correctly', async () => {
  metaReply = () => ({ pricing_analytics: { data: [{ data_points: [
    { start: DAY1, end: DAY1 + 86400, pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 10, cost: 7.85 },
    { start: DAY1, end: DAY1 + 86400, pricing_category: 'SERVICE', pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 40, cost: 0 },
    { start: DAY2, end: DAY2 + 86400, pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 5, cost: 3.925 },
    { start: DAY2, end: DAY2 + 86400, pricing_category: 'UTILITY', pricing_type: 'REGULAR', volume: 3, cost: 0.345 },
  ] }] } });
  const d = await api('/api/analytics/meta-cost?days=7').then((r) => r.json());
  assert.match(metaCalls[0].url, /pricing_analytics\.start\(\d+\)\.end\(\d+\)\.granularity\(DAILY\)\.dimensions\(PRICING_CATEGORY,PRICING_TYPE\)/);
  const [, start, end] = metaCalls[0].url.match(/start\((\d+)\)\.end\((\d+)\)/);
  assert.equal(Number(end) - Number(start), 7 * 86400);
  assert.deepEqual(d.totals, { volume: 58, cost: 12.12 });
  assert.deepEqual(d.byCategory.map((c) => [c.category, c.volume, c.freeVolume, c.cost]),
    [['MARKETING', 15, 0, 11.78], ['UTILITY', 3, 0, 0.35], ['SERVICE', 40, 40, 0]]);
  assert.deepEqual(d.byDay.map((x) => x.day), ['2026-11-21', '2026-11-20'], 'newest first');
});

test('cost: a bad period falls back to 30 days; Meta errors become a readable 502', async () => {
  metaReply = () => ({ pricing_analytics: { data: [] } });
  assert.equal((await api('/api/analytics/meta-cost?days=9999').then((r) => r.json())).days, 30);
  const stub = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('graph.facebook.com')
    ? new Response(JSON.stringify({ error: { message: 'Unsupported get request' } }), { status: 400 })
    : realFetch(url, opts));
  const res = await api('/api/analytics/meta-cost');
  assert.equal(res.status, 502);
  assert.match((await res.json()).detail, /Unsupported/);
  global.fetch = stub;
});

test('templates: off until explicitly confirmed; the switch is recorded', async () => {
  assert.deepEqual(await api('/api/analytics/template-insights').then((r) => r.json()), { enabled: false, templates: [] });
  assert.equal(metaCalls.length, 0);
  assert.equal((await api('/api/analytics/template-insights/enable', { method: 'POST', body: '{}' })).status, 400);
  assert.equal(metaCalls.length, 0, 'nothing switched on without confirm');
  metaReply = () => ({ success: true });
  assert.equal((await api('/api/analytics/template-insights/enable', { method: 'POST', body: JSON.stringify({ confirm: true }) })).status, 200);
  assert.equal(metaCalls[0].method, 'POST');
  assert.match(metaCalls[0].url, new RegExp(`/${WABA_ID}$`));
  assert.deepEqual(metaCalls[0].body, { is_enabled_for_insights: true });
  assert.ok((await pool.query('select template_insights_enabled_at from wabas where client_id = $1', [clientId])).rows[0].template_insights_enabled_at);
});

test('templates: 12 templates are fetched in batches of 10 and summed per template', async () => {
  metaReply = (call) => {
    const ids = JSON.parse(new URL(call.url).searchParams.get('template_ids'));
    return { data: [{ granularity: 'DAILY', data_points: ids.map((id) => ({
      template_id: id, start: DAY1, end: DAY1 + 86400, sent: id === '901' ? 5 : 1, delivered: 1, read: 1,
      clicked: id === '901' ? [{ type: 'quick_reply_button', button_content: 'Yes', count: 2 }, { type: 'url_button', count: 1 }] : [],
      cost: [{ type: 'amount_spent', value: 0.5 }, { type: 'cost_per_delivered', value: 0.5 }],
    })) }] };
  };
  const d = await api('/api/analytics/template-insights').then((r) => r.json());
  const calls = metaCalls.filter((c) => c.url.includes('/template_analytics'));
  assert.equal(calls.length, 2);
  const firstIds = JSON.parse(new URL(calls[0].url).searchParams.get('template_ids'));
  assert.equal(firstIds.length, 10);
  assert.equal(new URL(calls[0].url).searchParams.get('granularity'), 'daily');
  assert.equal(d.templates.length, 12);
  const top = d.templates[0];
  assert.deepEqual([top.name, top.sent, top.clicked, top.cost], ['tpl_01', 5, 3, 0.5], 'only amount_spent counts as cost');
});
