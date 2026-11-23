// Product messages from a Meta catalog (build-docs/features/catalog-product-messages.md).
// Meta faked via global.fetch; local test DB, disposable client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');
const pm = require('../src/utils/productMessages');

const PREFIX = '__test_suite__pm_';
const EMAIL = `test-suite-pm-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba_${Date.now()}`;
const PHONE_ID = `${PREFIX}phone`;
let server, base, token, clientId, chatId;
let metaCalls = [];
let metaReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.pm' }] } });
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const call = { url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    metaCalls.push(call);
    const { status, body } = metaReply(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, $3, 'connected', $4)`,
    [clientId, WABA_ID, PHONE_ID, encrypt('fake-token')]);
  chatId = (await pool.query(`insert into chats (client_id, name, phone) values ($1, 'Shopper', '919092766740') returning id`, [clientId])).rows[0].id;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; metaReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.pm' }] } }); });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

test('builder: the three Meta shapes, and the limits', () => {
  assert.match(pm.buildProductInteractive({ kind: 'product', sku: 'A' }, null).error, /catalog ID/);
  assert.deepEqual(pm.buildProductInteractive({ kind: 'product', sku: 'TS-01', body: 'Our bestseller' }, '123456').interactive,
    { type: 'product', action: { catalog_id: '123456', product_retailer_id: 'TS-01' }, body: { text: 'Our bestseller' } });
  const list = pm.buildProductInteractive({ kind: 'product_list', header: 'New in', body: 'Take a look', sections: [{ skus: 'A\nB, C\nA' }] }, '123456');
  assert.deepEqual(list.interactive.action.sections, [{ title: 'New in', product_items: [{ product_retailer_id: 'A' }, { product_retailer_id: 'B' }, { product_retailer_id: 'C' }] }]);
  assert.equal(list.summary, '3 products', 'duplicates removed');
  assert.match(pm.buildProductInteractive({ kind: 'product_list', header: 'x', body: 'y', sections: [{ skus: Array.from({ length: 31 }, (_, i) => `S${i}`) }] }, '1').error, /Up to 30/);
  assert.match(pm.buildProductInteractive({ kind: 'product_list', body: 'y', sections: [{ skus: 'A' }] }, '1').error, /heading/);
  assert.match(pm.buildProductInteractive({ kind: 'product_list', header: 'h', body: 'y', sections: [{ skus: 'A' }, { skus: 'B' }] }, '1').error, /title/);
  assert.deepEqual(pm.buildProductInteractive({ kind: 'catalog', body: 'Browse', thumbnailSku: 'A' }, '1').interactive,
    { type: 'catalog_message', action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: 'A' } }, body: { text: 'Browse' } });
  assert.equal(pm.describeOrder({ text: 'Fast please', product_items: [{ product_retailer_id: 'A', quantity: 2, item_price: 30, currency: 'INR' }] }),
    'Cart sent\n2 x A @ 30 INR\nTotal: 60 INR\nNote: Fast please');
});

test('catalog: refuses a non-numeric id; saves; "find" explains when Meta refuses', async () => {
  assert.equal((await api('/api/ecommerce/catalog', { method: 'PUT', body: JSON.stringify({ catalogId: 'abc' }) })).status, 400);
  assert.equal((await api('/api/ecommerce/catalog', { method: 'PUT', body: JSON.stringify({ catalogId: '194836987003835' }) })).status, 200);
  assert.equal((await api('/api/ecommerce/catalog').then((r) => r.json())).catalogId, '194836987003835');
  metaReply = () => ({ status: 403, body: { error: { message: '(#10) Requires catalog_management' } } });
  const res = await api('/api/ecommerce/catalog/find', { method: 'POST' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /paste it instead/);
  metaReply = () => ({ status: 200, body: { data: [{ id: '555', name: 'Main shop' }] } });
  assert.deepEqual(await api('/api/ecommerce/catalog/find', { method: 'POST' }).then((r) => r.json()), { catalogs: [{ id: '555', name: 'Main shop' }] });
  assert.match(decodeURIComponent(metaCalls[0].url), new RegExp(`/${WABA_ID}/product_catalogs\\?fields=id,name`));
});

test('send: refused outside the 24h window with no Meta call', async () => {
  const res = await api(`/api/chats/${chatId}/products`, { method: 'POST', body: JSON.stringify({ kind: 'product', sku: 'TS-01' }) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'session_window_closed');
  assert.equal(metaCalls.length, 0);
});

test('send: a product list goes out with the saved catalog; shows in the chat; human reply recorded', async () => {
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', now() - interval '5 minutes')`, [chatId, clientId]);
  const res = await api(`/api/chats/${chatId}/products`, { method: 'POST', body: JSON.stringify({ kind: 'product_list', header: 'New in', body: 'Take a look', sections: [{ skus: 'A\nB' }] }) });
  assert.equal(res.status, 201);
  const sent = metaCalls[0].body;
  assert.equal(sent.type, 'interactive');
  assert.equal(sent.interactive.type, 'product_list');
  assert.equal(sent.interactive.action.catalog_id, '194836987003835');
  const row = (await pool.query('select body from messages where chat_id = $1 order by sent_at desc limit 1', [chatId])).rows[0];
  assert.equal(row.body, '[products: 2 products] Take a look');
  assert.ok((await pool.query('select last_agent_reply_at from chats where id = $1', [chatId])).rows[0].last_agent_reply_at);
});

test('send: bad input is a 400 before Meta; a failed product send is never retried as text', async () => {
  assert.equal((await api(`/api/chats/${chatId}/products`, { method: 'POST', body: JSON.stringify({ kind: 'product' }) })).status, 400);
  assert.equal(metaCalls.length, 0);
  metaReply = () => ({ status: 400, body: { error: { message: 'Product not found in catalog', code: 131009 } } });
  assert.equal((await api(`/api/chats/${chatId}/products`, { method: 'POST', body: JSON.stringify({ kind: 'product', sku: 'NOPE' }) })).status, 502);
  const failed = (await pool.query(`select id from messages where chat_id = $1 and status = 'failed' order by sent_at desc limit 1`, [chatId])).rows[0];
  metaCalls = [];
  const retry = await api(`/api/chats/${chatId}/messages/${failed.id}/retry`, { method: 'POST' });
  assert.equal((await retry.json()).code, 'cannot_retry_form');
  assert.equal(metaCalls.length, 0);
});

test('incoming cart (type "order") is stored as readable text', async () => {
  const wamid = `wamid.${PREFIX}order_${Date.now()}`;
  const payload = { object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID },
    contacts: [{ wa_id: '919092766740', profile: { name: 'Shopper' } }],
    messages: [{ from: '919092766740', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'order',
      order: { catalog_id: '194836987003835', product_items: [{ product_retailer_id: 'A', quantity: 1, item_price: 499, currency: 'INR' }] } }],
  } }] }] };
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  assert.equal((await realFetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body })).status, 200);
  assert.equal((await pool.query('select body from messages where meta_message_id = $1', [wamid])).rows[0].body, 'Cart sent\n1 x A @ 499 INR\nTotal: 499 INR');
});
