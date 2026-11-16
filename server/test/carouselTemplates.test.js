// Carousel templates (build-docs/features/carousel-templates.md) - the
// multi-card swipeable layout from the user's original competitor
// screenshot. Missing from this app entirely before this feature
// (confirmed by grep: zero CAROUSEL references anywhere in metaClient.js/
// validate.js). Own dedicated disposable test client (same pattern as
// limitedTimeOfferTemplates.test.js); every Meta call stubbed - no real
// send, no real upload.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const templateMediaCacheRepo = require('../src/repositories/templateMediaCacheRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const consentRepo = require('../src/repositories/consentRepo');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, adminToken, apiKey;

const SUITE_PREFIX = '__test_suite__carouseltemplates_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-carouseltemplates-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: require('./helpers/adminCredentials').ADMIN_PASSWORD }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed - run `npm run db:seed` first');

  const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}app` }),
  }).then((r) => r.json());
  apiKey = created.key;
  assert.ok(apiKey, 'api key creation via the admin route must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function twoValidCards() {
  return [
    { headerType: 'IMAGE', bodyText: 'Card one text', buttons: [{ type: 'URL', text: 'Read more', url: 'https://example.com/1' }] },
    { headerType: 'IMAGE', bodyText: 'Card two text', buttons: [{ type: 'URL', text: 'Read more', url: 'https://example.com/2' }] },
  ];
}

function cardFilesForm(data, count) {
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  for (let i = 0; i < count; i++) {
    form.append('cardFiles', new Blob([Buffer.from(`fake-image-${i}`)], { type: 'image/jpeg' }), `card${i}.jpg`);
  }
  return form;
}

// --- Creation: local rejections, no Meta call ---

test('POST /api/templates: a carousel with only 1 card is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}one_card`, category: 'Marketing', language: 'en_US',
      body: 'Check these out!', cards: [{ headerType: 'IMAGE' }],
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: a carousel with mismatched card button shapes is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}mismatched_buttons`, category: 'Marketing', language: 'en_US',
      body: 'Check these out!',
      cards: [
        { headerType: 'IMAGE', buttons: [{ type: 'URL', text: 'Read more', url: 'https://example.com/1' }] },
        { headerType: 'IMAGE' }, // no buttons - mismatched with card 1
      ],
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: a carousel on a non-Marketing category is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}wrong_category`, category: 'Utility', language: 'en_US',
      body: 'Check these out!', cards: twoValidCards(),
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: a carousel with a header alongside it is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}with_header`, category: 'Marketing', language: 'en_US',
      body: 'Check these out!', header: { type: 'TEXT', text: 'Hi' }, cards: twoValidCards(),
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: card file count must match card count, no Meta call made', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('graph.facebook.com')) throw new Error('must not call Meta - rejected before that point');
    return originalFetch(url, options);
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
      body: cardFilesForm({ name: `${SUITE_PREFIX}wrong_file_count`, category: 'Marketing', language: 'en_US', body: 'Check these out!', cards: twoValidCards() }, 1),
    });
    assert.equal(res.status, 400);
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Creation: real success path ---

test('POST /api/templates: a valid 2-card carousel submits to Meta with the documented lowercase carousel shape', async () => {
  const originalFetch = global.fetch;
  let createRequestBody = null;
  let mediaUploadCount = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (urlStr.includes('/uploads') && options?.method === 'POST' && !urlStr.includes('/media')) {
      return { ok: true, json: async () => ({ id: `upload_session_${mediaUploadCount}` }) };
    }
    if (urlStr.includes('upload_session_')) {
      return { ok: true, json: async () => ({ h: `HANDLE_${urlStr.split('upload_session_')[1]}` }) };
    }
    if (urlStr.endsWith('/media')) {
      mediaUploadCount++;
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}media_${mediaUploadCount}` }) };
    }
    createRequestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'PENDING', category: 'MARKETING' }) };
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
      body: cardFilesForm({
        name: `${SUITE_PREFIX}flash_sale_carousel`, category: 'Marketing', language: 'en_US',
        body: 'Check out our top picks this week!', cards: twoValidCards(),
      }, 2),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const template = await res.json();

    // Documented shape: lowercase "body"/"carousel" at the top level,
    // lowercase "header"/"body"/"buttons" per card (unlike this app's
    // existing uppercase convention for every other template type).
    assert.equal(createRequestBody.components[0].type, 'body');
    assert.equal(createRequestBody.components[0].text, 'Check out our top picks this week!');
    const carousel = createRequestBody.components[1];
    assert.equal(carousel.type, 'carousel');
    assert.equal(carousel.cards.length, 2);
    assert.deepEqual(carousel.cards[0].components[0], { type: 'header', format: 'IMAGE', example: { header_handle: ['HANDLE_0'] } });
    assert.deepEqual(carousel.cards[0].components[1], { type: 'body', text: 'Card one text' });
    assert.deepEqual(carousel.cards[0].components[2], { type: 'buttons', buttons: [{ type: 'url', text: 'Read more', url: 'https://example.com/1' }] });
    assert.deepEqual(carousel.cards[1].components[0], { type: 'header', format: 'IMAGE', example: { header_handle: ['HANDLE_1'] } });

    const fromDb = await messageTemplatesRepo.findById(pool, testClientId, template.id);
    assert.equal(fromDb.cards.length, 2);
    assert.equal(fromDb.cards[0].bodyText, 'Card one text');
    assert.equal(fromDb.cards[0].headerHandle, undefined, 'the transient upload handle must never be persisted');

    // One default media_id cached per card, keyed by card_index.
    const assets = await templateMediaCacheRepo.listByTemplateId(pool, testClientId, template.id);
    assert.equal(assets.length, 2);
    assert.ok(assets.find((a) => a.card_index === 0 && a.media_id === `${SUITE_PREFIX}media_1`));
    assert.ok(assets.find((a) => a.card_index === 1 && a.media_id === `${SUITE_PREFIX}media_2`));
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Send time ---

test('sending an approved carousel template resolves one media id per card and sends a correctly-shaped carousel component', async () => {
  const originalFetch = global.fetch;
  const sendRequests = [];
  let mediaUploadCount = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      sendRequests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent_${sendRequests.length}` }] }) };
    }
    if (urlStr.includes('/uploads') && options?.method === 'POST' && !urlStr.includes('/media')) {
      return { ok: true, json: async () => ({ id: `upload_session_${mediaUploadCount}` }) };
    }
    if (urlStr.includes('upload_session_')) {
      return { ok: true, json: async () => ({ h: `HANDLE_${urlStr.split('upload_session_')[1]}` }) };
    }
    if (urlStr.endsWith('/media')) {
      mediaUploadCount++;
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}send_media_${mediaUploadCount}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id_2`, status: 'APPROVED', category: 'MARKETING' }) };
  };
  try {
    const templateName = `${SUITE_PREFIX}send_carousel_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
      body: cardFilesForm({ name: templateName, category: 'Marketing', language: 'en_US', body: 'Top picks!', cards: twoValidCards() }, 2),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    const phone = `9169${Date.now()}`.slice(0, 12);
    const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Carousel Test Contact', wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
    await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });

    const res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: authed(apiKey),
      body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName }),
    });
    const data = await res.json();
    assert.equal(res.status, 201, JSON.stringify(data));
    assert.equal(sendRequests.length, 1);

    const carouselComponent = sendRequests[0].template.components.find((c) => c.type === 'carousel');
    assert.ok(carouselComponent);
    assert.equal(carouselComponent.cards.length, 2);
    assert.equal(carouselComponent.cards[0].card_index, 0);
    assert.deepEqual(carouselComponent.cards[0].components, [{ type: 'header', parameters: [{ type: 'image', image: { id: `${SUITE_PREFIX}send_media_1` } }] }]);
    assert.equal(carouselComponent.cards[1].card_index, 1);
    assert.deepEqual(carouselComponent.cards[1].components, [{ type: 'header', parameters: [{ type: 'image', image: { id: `${SUITE_PREFIX}send_media_2` } }] }]);

    void chat;
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Replacing a card's media without re-approval ---
// (build-docs/features/carousel-templates.md's "swap a carousel card's
// image without re-approval" gap - Meta's own send-time shape for a
// card's media is a reference, never baked into the approval.)

test('POST /:id/header-media: with a valid cardIndex uploads against that specific card, not the (non-existent) template-level header', async () => {
  const originalFetch = global.fetch;
  let mediaUploadCount = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (urlStr.includes('/uploads') && options?.method === 'POST' && !urlStr.includes('/media')) {
      return { ok: true, json: async () => ({ id: `upload_session_${mediaUploadCount}` }) };
    }
    if (urlStr.includes('upload_session_')) return { ok: true, json: async () => ({ h: 'HANDLE_X' }) };
    if (urlStr.endsWith('/media')) {
      mediaUploadCount++;
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}replace_media_${mediaUploadCount}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id_3`, status: 'APPROVED', category: 'MARKETING' }) };
  };
  try {
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
      body: cardFilesForm({ name: `${SUITE_PREFIX}replace_test`, category: 'Marketing', language: 'en_US', body: 'Top picks!', cards: twoValidCards() }, 2),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));
    const template = await templateRes.json();

    // Captured before the replace call below, rather than hardcoded - this
    // stub's media ids are numbered sequentially across BOTH the creation
    // upload (2 calls) and the replace upload (1 more), so card 1's real
    // seeded value isn't a fixed string.
    const assetsBeforeReplace = await templateMediaCacheRepo.listByTemplateId(pool, testClientId, template.id);
    const card1MediaIdBeforeReplace = assetsBeforeReplace.find((a) => a.card_index === 1 && a.is_default).media_id;

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('new-image-for-card-0')], { type: 'image/jpeg' }), 'new.jpg');
    form.append('cardIndex', '0');
    const uploadRes = await fetch(`${baseUrl}/api/templates/${template.id}/header-media`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` }, body: form,
    });
    assert.equal(uploadRes.status, 201, JSON.stringify(await uploadRes.clone().json()));
    const asset = await uploadRes.json();
    assert.equal(asset.cardIndex, 0);

    const defaultRes = await fetch(`${baseUrl}/api/templates/${template.id}/header-media/${asset.id}/default`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(defaultRes.status, 200);

    // Card 0's default changed; card 1's own default (seeded at creation)
    // must be completely untouched - these are independent slots.
    const assetsAfter = await templateMediaCacheRepo.listByTemplateId(pool, testClientId, template.id);
    const card0Default = assetsAfter.find((a) => a.card_index === 0 && a.is_default);
    const card1Default = assetsAfter.find((a) => a.card_index === 1 && a.is_default);
    assert.equal(card0Default.id, asset.id, 'card 0\'s default must now be the newly uploaded asset');
    assert.equal(card1Default.media_id, card1MediaIdBeforeReplace, 'card 1\'s own default must be completely untouched by card 0\'s replace');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /:id/header-media: an out-of-range cardIndex is rejected (400), no Meta call made', async () => {
  const originalFetch = global.fetch;
  let mediaUploadCount = 0;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (urlStr.includes('/uploads') && options?.method === 'POST' && !urlStr.includes('/media')) {
      return { ok: true, json: async () => ({ id: `upload_session_${mediaUploadCount}` }) };
    }
    if (urlStr.includes('upload_session_')) return { ok: true, json: async () => ({ h: 'HANDLE_X' }) };
    if (urlStr.endsWith('/media')) {
      mediaUploadCount++;
      return { ok: true, json: async () => ({ id: `${SUITE_PREFIX}oor_media_${mediaUploadCount}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id_4`, status: 'APPROVED', category: 'MARKETING' }) };
  };
  try {
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` },
      body: cardFilesForm({ name: `${SUITE_PREFIX}oor_test`, category: 'Marketing', language: 'en_US', body: 'Top picks!', cards: twoValidCards() }, 2),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));
    const template = await templateRes.json();

    const originalFetch2 = global.fetch;
    global.fetch = async (url, options) => {
      if (String(url).includes('graph.facebook.com')) throw new Error('must not call Meta - rejected before that point');
      return originalFetch2(url, options);
    };
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('x')], { type: 'image/jpeg' }), 'x.jpg');
    form.append('cardIndex', '5'); // only cards 0 and 1 exist
    const uploadRes = await fetch(`${baseUrl}/api/templates/${template.id}/header-media`, {
      method: 'POST', headers: { Authorization: `Bearer ${clientToken}` }, body: form,
    });
    assert.equal(uploadRes.status, 400);
  } finally {
    global.fetch = originalFetch;
  }
});
