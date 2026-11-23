// Ad account metrics for Click-to-WhatsApp ads (build-docs/features/ctwa-ad-metrics.md).
// Meta faked via global.fetch; local test DB, disposable client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.APP_URL = 'https://wasi.test';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { decrypt } = require('../src/utils/encryption');
const ads = require('../src/routes/ads');

const PREFIX = '__test_suite__adsm_';
const EMAIL = `test-suite-adsm-${Date.now()}@wasi.local`;
let server, base, token, clientId;
let metaCalls = [];
let insightsFail = false;
let accounts = [{ id: 'act_111', name: 'Main ads', currency: 'INR' }];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push(decodeURIComponent(u));
    let body = {};
    if (u.includes('/oauth/access_token')) body = { access_token: u.includes('fb_exchange_token') ? 'LONG_TOKEN' : 'SHORT_TOKEN' };
    else if (u.includes('/me/adaccounts')) body = { data: accounts };
    else if (u.includes('/insights')) {
      if (insightsFail) return new Response(JSON.stringify({ error: { message: '(#200) Requires ads_read permission' } }), { status: 400 });
      body = { data: [{ ad_id: 'AD_A', ad_name: 'Summer', spend: '500.50', impressions: '10000', clicks: '250' }, { ad_id: 'AD_OTHER', spend: '99' }] };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  // Two chats from ad AD_A, one from an ad not in the account.
  for (const [phone, src] of [['919000000201', 'AD_A'], ['919000000202', 'AD_A'], ['919000000203', 'AD_ZZ']]) {
    const chat = (await pool.query('insert into chats (client_id, name, phone) values ($1, $2, $2) returning id', [clientId, phone])).rows[0].id;
    await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at, referral) values ($1, $2, 'in', 'hi', now() - interval '1 day', $3)`,
      [chat, clientId, JSON.stringify({ source_id: src, headline: src })]);
  }
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; insightsFail = false; });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

test('signed state: round-trips, rejects tampering', () => {
  const s = ads.signState(clientId);
  assert.equal(ads.readState(s), clientId);
  const [p] = s.split('.');
  assert.equal(ads.readState(`${p}.AAAA`), null);
  assert.equal(ads.readState('garbage'), null);
});

test('not configured: status says so and connect is refused', async () => {
  delete process.env.META_ADS_CONFIG_ID;
  assert.equal((await api('/api/ads/status').then((r) => r.json())).configured, false);
  assert.equal((await api('/api/ads/connect', { method: 'POST' })).status, 409);
});

test('connect returns Meta\'s Login for Business dialog with our config, redirect and signed state', async () => {
  process.env.META_ADS_CONFIG_ID = '9988776655';
  const { url } = await api('/api/ads/connect', { method: 'POST' }).then((r) => r.json());
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.equal(u.searchParams.get('config_id'), '9988776655');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://wasi.test/api/ads/callback');
  assert.equal(ads.readState(u.searchParams.get('state')), clientId);
});

test('callback: a bad state goes back with "expired" and stores nothing', async () => {
  const res = await realFetch(`${base}/api/ads/callback?code=abc&state=bad`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://wasi.test/app?ads=expired#ctwa');
  assert.equal((await pool.query('select count(*)::int n from ads_connections where client_id = $1', [clientId])).rows[0].n, 0);
});

test('callback: exchanges the code (with the same redirect_uri), keeps a long-lived token encrypted, picks the only account', async () => {
  const res = await realFetch(`${base}/api/ads/callback?code=THE_CODE&state=${encodeURIComponent(ads.signState(clientId))}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), 'https://wasi.test/app?ads=connected#ctwa');
  assert.ok(metaCalls.some((c) => c.includes('code=THE_CODE') && c.includes('redirect_uri=https://wasi.test/api/ads/callback')));
  const row = (await pool.query('select access_token_encrypted, ad_account_id from ads_connections where client_id = $1', [clientId])).rows[0];
  assert.equal(row.ad_account_id, 'act_111');
  assert.notEqual(row.access_token_encrypted, 'LONG_TOKEN');
  assert.equal(decrypt(row.access_token_encrypted), 'LONG_TOKEN');
  const st = await api('/api/ads/status').then((r) => r.text());
  assert.equal(st.includes('LONG_TOKEN'), false, 'token never returned');
});

test('Ad Leads: spend, clicks and cost per lead merged by ad id; unmatched ads show no money', async () => {
  const d = await api('/api/analytics/ctwa').then((r) => r.json());
  assert.match(metaCalls.find((c) => c.includes('/act_111/insights')), /level=ad/);
  const a = d.bySource.find((r) => r.sourceId === 'AD_A');
  assert.deepEqual([a.leadCount, a.spend, a.clicks, a.costPerLead], [2, 500.5, 250, 250.25]);
  const z = d.bySource.find((r) => r.sourceId === 'AD_ZZ');
  assert.equal(z.spend, undefined);
  assert.equal(d.totals.spend, 500.5);
  assert.equal(d.totals.costPerLead, 166.83, 'total spend / all ad leads (3)');
  assert.deepEqual(d.adsAccount, { connected: true, hasMetrics: true, error: null, currency: 'INR' });
});

test('Ad Leads: a Meta refusal keeps the leads and reports the reason', async () => {
  insightsFail = true;
  const d = await api('/api/analytics/ctwa').then((r) => r.json());
  assert.equal(d.totals.leads, 3);
  assert.equal(d.totals.spend, undefined);
  assert.match(d.adsAccount.error, /ads_read/);
});

test('account picker only accepts shared accounts; disconnect removes the connection', async () => {
  accounts = [{ id: 'act_111', name: 'Main ads', currency: 'INR' }, { id: 'act_222', name: 'Second', currency: 'INR' }];
  assert.equal((await api('/api/ads/account', { method: 'PUT', body: JSON.stringify({ adAccountId: 'act_999' }) })).status, 400);
  assert.equal((await api('/api/ads/account', { method: 'PUT', body: JSON.stringify({ adAccountId: 'act_222' }) }).then((r) => r.json())).adAccountId, 'act_222');
  assert.equal((await api('/api/ads', { method: 'DELETE' })).status, 204);
  assert.equal((await pool.query('select count(*)::int n from ads_connections where client_id = $1', [clientId])).rows[0].n, 0);
  delete process.env.META_ADS_CONFIG_ID;
});
