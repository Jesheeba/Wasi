// WooCommerce integration (build-docs/features/woocommerce-integration.md).
// A fake store (https://shop.test) and a fake Meta are served by stubbing
// global.fetch; DNS for the fake host is stubbed via publicUrl.resolver.
// Local test database, disposable __test_suite__ client deleted in after().
//
// AC1 keys connect verifies + creates both webhooks; AC2 a signed order
// event sends the mapped template to the normalised phone and creates the
// contact; AC3 dedupe, STOP'd contact skipped, bad signature 401; AC4
// marketing templates refused for rules; AC5 private/loopback URLs refused.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.APP_URL = 'https://wasi.test';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt, decrypt } = require('../src/utils/encryption');
const publicUrl = require('../src/utils/publicUrl');
const woo = require('../src/utils/wooOrders');

const PREFIX = '__test_suite__woo_';
const EMAIL = `test-suite-woo-${Date.now()}@wasi.local`;
const KEY = `ck_${'a'.repeat(40)}`;
const SECRET = `cs_${'b'.repeat(40)}`;
let server, base, token, clientId;
let storeCalls = [];
let metaCalls = [];
let storeAuthOk = true;
let webhookSeq = 100;
const realFetch = global.fetch;
const realLookup = publicUrl.resolver.lookup;

before(async () => {
  publicUrl.resolver.lookup = async (host) => {
    if (host === 'shop.test') return [{ address: '93.184.216.34' }];
    if (host === 'evil.test') return [{ address: '10.0.0.5' }];
    return realLookup(host);
  };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://shop.test/')) {
      storeCalls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers, redirect: opts.redirect });
      if (!storeAuthOk) return new Response('{"code":"woocommerce_rest_cannot_view"}', { status: 401 });
      const body = (opts.method === 'POST') ? { id: ++webhookSeq } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('graph.facebook.com')) {
      metaCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.woo${metaCalls.length}` }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
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
  await pool.query(
    `insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, $3, 'connected', $4)`,
    [clientId, `${PREFIX}waba_${Date.now()}`, `${PREFIX}phone`, encrypt('fake-token')]
  );
  await pool.query(
    `insert into message_templates (client_id, name, category, status, body, language) values
      ($1, 'order_confirmed', 'UTILITY', 'approved', 'Hi {{customer_name}}, order {{order_number}} for {{order_total}} is confirmed.', 'en'),
      ($1, 'big_sale', 'MARKETING', 'approved', 'Sale for {{customer_name}}', 'en'),
      ($1, 'shipped_pending', 'Utility', 'pending', 'Shipped {{order_number}}', 'en')`,
    [clientId]
  );
});

after(async () => {
  global.fetch = realFetch;
  publicUrl.resolver.lookup = realLookup;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { storeCalls = []; metaCalls = []; storeAuthOk = true; });

const api = (p, opts = {}) => realFetch(`${base}${p}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
});

// ---------- pure helpers ----------

test('phone normalisation: Indian local formats, international, and refusals', () => {
  assert.equal(woo.normalizePhone('98765 43210', 'IN').phone, '919876543210');
  assert.equal(woo.normalizePhone('09876543210', 'IN').phone, '919876543210');
  assert.equal(woo.normalizePhone('919876543210', '').phone, '919876543210');
  assert.equal(woo.normalizePhone('+44 7700 900123', 'GB').phone, '447700900123');
  assert.equal(woo.normalizePhone('7700 900123', 'GB').phone, null, 'a local non-Indian number is not guessed');
  assert.match(woo.normalizePhone('', 'IN').reason, /no billing phone/);
});

test('triggers, fields and parameter mapping', () => {
  assert.deepEqual(woo.triggerFor('order.created', { id: 7 }), { trigger: 'order_created', dedupeKey: 'order:7:created' });
  assert.deepEqual(woo.triggerFor('order.updated', { id: 7, status: 'on-hold' }), { trigger: 'status_on-hold', dedupeKey: 'order:7:status:on-hold' });
  assert.equal(woo.triggerFor('order.deleted', { id: 7 }), null);
  const f = woo.fieldsFromOrder({ number: '1042', total: '1250.5', currency: 'INR', billing: { first_name: 'Asha', last_name: 'Rao' }, line_items: [{ quantity: 2, name: 'T-shirt' }] });
  assert.equal(f.customer_name, 'Asha Rao');
  assert.equal(f.order_total, '1,250.50');
  assert.equal(f.items, '2 x T-shirt');
  const built = woo.buildParamValues(['customer_name', 'x'], { customer_name: 'first_name', x: 'payment_method' }, f);
  assert.deepEqual(built.values, { customer_name: 'Asha', x: '-' }, 'empty values become "-" (Meta rejects empty params)');
  assert.deepEqual(woo.buildParamValues(['y'], {}, f).missing, ['y']);
});

test('AC5: store URL must be https and public', async () => {
  for (const [url, re] of [
    ['http://shop.test', /https/],
    ['https://localhost', /not reachable/],
    ['https://127.0.0.1', /not reachable/],
    ['https://169.254.169.254', /not reachable/],
    ['https://evil.test', /not reachable/],
    ['https://user:pw@shop.test', /username/],
    ['not a url', /full store address/],
  ]) {
    await assert.rejects(publicUrl.assertPublicHttpsUrl(url), re, url);
  }
  assert.equal(await publicUrl.assertPublicHttpsUrl('https://shop.test/'), 'https://shop.test');
  const res = await api('/api/ecommerce/woocommerce/keys', { method: 'POST', body: JSON.stringify({ storeUrl: 'https://evil.test', consumerKey: KEY, consumerSecret: SECRET }) });
  assert.equal(res.status, 400);
  assert.equal(storeCalls.length, 0, 'the server never called the private address');
});

// ---------- connecting ----------

test('AC1: wrong keys are reported and leave nothing half-connected', async () => {
  storeAuthOk = false;
  const res = await api('/api/ecommerce/woocommerce/keys', { method: 'POST', body: JSON.stringify({ storeUrl: 'https://shop.test', consumerKey: KEY, consumerSecret: SECRET }) });
  assert.equal(res.status, 502);
  assert.match((await res.json()).detail, /rejected the API keys/);
  const page = await api('/api/ecommerce/woocommerce').then((r) => r.json());
  assert.equal(page.store, null, 'the failed request is rolled back, so no keys are kept');
});

let storeId;
test('AC1: keys connect verifies access and creates both signed webhooks; nothing secret is returned', async () => {
  const res = await api('/api/ecommerce/woocommerce/keys', { method: 'POST', body: JSON.stringify({ storeUrl: 'https://shop.test', consumerKey: KEY, consumerSecret: SECRET }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  storeId = JSON.parse(text).store.id;
  assert.equal(JSON.parse(text).store.status, 'connected');
  for (const s of [KEY, SECRET, 'secret', 'consumer']) assert.equal(text.includes(s), false, s);
  assert.equal(storeCalls[0].method, 'GET');
  assert.equal(storeCalls[0].headers.Authorization, `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`);
  assert.ok(storeCalls.every((c) => c.redirect === 'error'), 'redirects are never followed');
  const hooks = storeCalls.filter((c) => c.method === 'POST');
  assert.deepEqual(hooks.map((h) => h.body.topic), ['order.created', 'order.updated']);
  for (const h of hooks) {
    assert.equal(h.body.delivery_url, `https://wasi.test/webhooks/woocommerce/${storeId}`);
    assert.ok(h.body.secret.length >= 32);
  }
  const row = (await pool.query('select consumer_key_encrypted, webhook_ids from ecommerce_stores where id = $1', [storeId])).rows[0];
  assert.notEqual(row.consumer_key_encrypted, KEY, 'stored encrypted');
  assert.equal(decrypt(row.consumer_key_encrypted), KEY);
  assert.equal(row.webhook_ids.length, 2);
});

test('a second store is refused while one is connected', async () => {
  const res = await api('/api/ecommerce/woocommerce/keys', { method: 'POST', body: JSON.stringify({ storeUrl: 'https://shop.test', consumerKey: KEY, consumerSecret: SECRET }) });
  assert.equal(res.status, 409);
});

// ---------- rules ----------

test('AC4: rules accept only approved Utility templates with every variable mapped', async () => {
  const put = (trigger, body) => api(`/api/ecommerce/woocommerce/rules/${trigger}`, { method: 'PUT', body: JSON.stringify(body) });
  assert.match((await (await put('order_created', { templateName: 'big_sale', paramMap: { customer_name: 'first_name' } })).json()).error, /Utility/);
  assert.match((await (await put('order_created', { templateName: 'shipped_pending', paramMap: { order_number: 'order_number' } })).json()).error, /not approved/);
  assert.match((await (await put('order_created', { templateName: 'order_confirmed', paramMap: { customer_name: 'first_name' } })).json()).error, /order_number, order_total/);
  assert.equal((await put('nonsense', { templateName: 'order_confirmed' })).status, 400);
  const vars = await api('/api/ecommerce/woocommerce/template-variables?name=order_confirmed').then((r) => r.json());
  assert.deepEqual(vars.variables, ['customer_name', 'order_number', 'order_total']);
  const ok = await put('order_created', { templateName: 'order_confirmed', paramMap: { customer_name: 'first_name', order_number: 'order_number', order_total: 'order_total', extra: 'currency' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).paramMap, { customer_name: 'first_name', order_number: 'order_number', order_total: 'order_total' }, 'unknown keys dropped');
});

// ---------- webhooks ----------

async function sendWebhook(topic, order, { signature } = {}) {
  const body = JSON.stringify(order);
  const secret = decrypt((await pool.query('select webhook_secret_encrypted from ecommerce_stores where id = $1', [storeId])).rows[0].webhook_secret_encrypted);
  const sig = signature ?? crypto.createHmac('sha256', secret).update(body).digest('base64');
  return realFetch(`${base}/webhooks/woocommerce/${storeId}`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': topic, 'X-WC-Webhook-Signature': sig },
  });
}
async function eventFor(dedupeKey) {
  for (let i = 0; i < 50; i++) {
    const row = (await pool.query(`select * from ecommerce_events where store_id = $1 and dedupe_key = $2 and status <> 'received'`, [storeId, dedupeKey])).rows[0];
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`event ${dedupeKey} never finished`);
}
const order = (id, extra = {}) => ({
  id, number: String(id), status: 'processing', total: '1250', currency: 'INR', date_created: '2026-11-23T10:00:00',
  billing: { first_name: 'Asha', last_name: 'Rao', phone: '98765 43210', country: 'IN' }, line_items: [{ quantity: 1, name: 'Mug' }], ...extra,
});

test('the creation ping is accepted; a bad signature is refused', async () => {
  const ping = await realFetch(`${base}/webhooks/woocommerce/${storeId}`, { method: 'POST', body: 'webhook_id=101', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(ping.status, 200);
  const bad = await sendWebhook('order.created', order(500), { signature: 'AAAA' });
  assert.equal(bad.status, 401);
  assert.equal((await pool.query('select count(*)::int n from ecommerce_events where store_id = $1', [storeId])).rows[0].n, 0);
});

test('AC2: order placed sends the mapped template to the normalised phone and creates the contact', async () => {
  assert.equal((await sendWebhook('order.created', order(501))).status, 200);
  const ev = await eventFor('order:501:created');
  assert.equal(ev.status, 'sent', ev.detail);
  const sent = metaCalls.find((c) => /\/messages$/.test(c.url)).body;
  assert.equal(sent.to, '919876543210');
  assert.equal(sent.template.name, 'order_confirmed');
  assert.deepEqual(sent.template.components[0].parameters.map((p) => [p.parameter_name, p.text]),
    [['customer_name', 'Asha'], ['order_number', '501'], ['order_total', '1,250.00']]);
  const contact = (await pool.query(`select name from contacts where client_id = $1 and phone = '919876543210'`, [clientId])).rows[0];
  assert.equal(contact.name, 'Asha Rao');
});

test('AC3: a repeated event sends once; an event with no rule is logged', async () => {
  await sendWebhook('order.created', order(501));
  await sendWebhook('order.updated', order(501));
  const ev = await eventFor('order:501:status:processing');
  assert.equal(ev.status, 'no_rule');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(metaCalls.length, 0, 'the duplicate order.created sent nothing');
  const n = (await pool.query(`select count(*)::int n from ecommerce_events where store_id = $1 and dedupe_key like 'order:501:%'`, [storeId])).rows[0].n;
  assert.equal(n, 2);
});

test('AC3: an unusable phone and a STOP\'d contact are skipped with a reason', async () => {
  await sendWebhook('order.created', order(502, { billing: { first_name: 'No', phone: '12345', country: 'IN' } }));
  assert.match((await eventFor('order:502:created')).detail, /international/);
  await pool.query(`update contacts set opt_in_status = 'opted_out' where client_id = $1 and phone = '919876543210'`, [clientId]);
  await sendWebhook('order.created', order(503));
  const ev = await eventFor('order:503:created');
  assert.equal(ev.status, 'skipped');
  assert.match(ev.detail, /opted out/);
  assert.equal(metaCalls.length, 0);
});

test('page data lists the events newest first, without secrets', async () => {
  const text = await api('/api/ecommerce/woocommerce').then((r) => r.text());
  const page = JSON.parse(text);
  assert.equal(page.events[0].orderNumber, '503');
  assert.ok(page.triggers.length >= 8 && page.fields.length >= 10);
  assert.equal(page.rules[0].templateName, 'order_confirmed');
  for (const s of [KEY, SECRET]) assert.equal(text.includes(s), false);
});

test('one-click: callback with the token connects; a reused token is refused', async () => {
  const del = await api('/api/ecommerce/woocommerce', { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal(storeCalls.filter((c) => c.method === 'DELETE').length, 2, 'both webhooks removed from the store');
  const connectRes = await api('/api/ecommerce/woocommerce/connect', { method: 'POST', body: JSON.stringify({ storeUrl: 'https://shop.test' }) }).then((r) => r.json());
  const { authorizeUrl } = connectRes;
  assert.ok(authorizeUrl, JSON.stringify(connectRes));
  const u = new URL(authorizeUrl);
  assert.equal(u.origin + u.pathname, 'https://shop.test/wc-auth/v1/authorize');
  assert.equal(u.searchParams.get('scope'), 'read_write');
  assert.equal(u.searchParams.get('callback_url'), 'https://wasi.test/webhooks/woocommerce/auth-callback');
  const cb = (tok) => realFetch(`${base}/webhooks/woocommerce/auth-callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key_id: 1, user_id: tok, consumer_key: KEY, consumer_secret: SECRET, key_permissions: 'read_write' }),
  });
  assert.equal((await cb(u.searchParams.get('user_id'))).status, 200);
  const page = await api('/api/ecommerce/woocommerce').then((r) => r.json());
  assert.equal(page.store.status, 'connected');
  assert.equal(page.rules.length, 0, 'rules belonged to the disconnected store');
  assert.equal((await cb(u.searchParams.get('user_id'))).status, 400, 'token is single-use');
});
