// Instagram DM Automation, Phase 1 — discoverInstagramAccount and
// completeInstagramConnection. Stubs only, per this project's current
// dbSafety.js hard rule (a test under NODE_TEST_CONTEXT with no
// TEST_DATABASE_URL set must never call pool.query()/pool.connect() at all)
// — same pattern as coexistenceEchoIngestion.test.js: repo/client functions
// are monkey-patched on their required singleton module objects and
// restored after each test, nothing ever reaches the real database.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const instagramClient = require('../src/utils/instagramClient');
const instagramAccountsRepo = require('../src/repositories/instagramAccountsRepo');
const clientsRepo = require('../src/repositories/clientsRepo');
const { discoverInstagramAccount, completeInstagramConnection } = require('../src/services/instagramConnectionService');

function stubModule(mod, overrides) {
  const originals = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = mod[key];
    mod[key] = overrides[key];
  }
  return () => { for (const key of Object.keys(originals)) mod[key] = originals[key]; };
}

// --- discoverInstagramAccount ---

test('discoverInstagramAccount: auto-resolves a single Page with a linked Instagram account', async () => {
  const restore = stubModule(instagramClient, {
    listManagedPages: async () => [
      { id: 'page-1', name: 'Test Page', access_token: 'page-token-1', instagram_business_account: { id: 'ig-1', username: 'test_ig' } },
    ],
  });
  try {
    const result = await discoverInstagramAccount({ accessToken: 'user-token' });
    assert.equal(result.needsManualResolution, undefined);
    assert.equal(result.pageId, 'page-1');
    assert.equal(result.pageAccessToken, 'page-token-1');
    assert.equal(result.instagramBusinessAccountId, 'ig-1');
    assert.equal(result.igUsername, 'test_ig');
  } finally {
    restore();
  }
});

test('discoverInstagramAccount: a Page with no linked Instagram account is filtered out, not returned as a candidate', async () => {
  const restore = stubModule(instagramClient, {
    listManagedPages: async () => [
      { id: 'page-no-ig', name: 'No IG Page', access_token: 'token', instagram_business_account: null },
      { id: 'page-1', name: 'Test Page', access_token: 'page-token-1', instagram_business_account: { id: 'ig-1', username: 'test_ig' } },
    ],
  });
  try {
    const result = await discoverInstagramAccount({ accessToken: 'user-token' });
    assert.equal(result.pageId, 'page-1', 'must auto-resolve the ONE page that actually has an Instagram account linked');
  } finally {
    restore();
  }
});

test('discoverInstagramAccount: defers to manual resolution when more than one Page has a linked Instagram account (never guesses)', async () => {
  const restore = stubModule(instagramClient, {
    listManagedPages: async () => [
      { id: 'page-a', name: 'Page A', access_token: 'token-a', instagram_business_account: { id: 'ig-a', username: 'ig_a' } },
      { id: 'page-b', name: 'Page B', access_token: 'token-b', instagram_business_account: { id: 'ig-b', username: 'ig_b' } },
    ],
  });
  try {
    const result = await discoverInstagramAccount({ accessToken: 'user-token' });
    assert.equal(result.needsManualResolution, true);
    assert.equal(result.reason, 'multiple_pages_with_instagram');
    assert.equal(result.diagnostics.candidatePages.length, 2);
  } finally {
    restore();
  }
});

test('discoverInstagramAccount: throws a clear error when the account manages zero Pages at all', async () => {
  const restore = stubModule(instagramClient, { listManagedPages: async () => [] });
  try {
    await assert.rejects(
      () => discoverInstagramAccount({ accessToken: 'user-token' }),
      /no Facebook Pages/
    );
  } finally {
    restore();
  }
});

test('discoverInstagramAccount: throws a clear error when Pages exist but none has a linked Instagram account', async () => {
  const restore = stubModule(instagramClient, {
    listManagedPages: async () => [{ id: 'page-1', name: 'Test Page', access_token: 'token', instagram_business_account: null }],
  });
  try {
    await assert.rejects(
      () => discoverInstagramAccount({ accessToken: 'user-token' }),
      /linked Instagram professional account/
    );
  } finally {
    restore();
  }
});

// --- completeInstagramConnection ---

test('completeInstagramConnection: subscribes the Page, persists connected status, bumps a payment_confirmed client to active', async () => {
  const calls = { subscribePageApp: [], upsertForClient: [], clientsUpdate: [] };
  const restoreClient = stubModule(instagramClient, {
    subscribePageApp: async (pageId, token) => { calls.subscribePageApp.push({ pageId, token }); return {}; },
  });
  const restoreAccountsRepo = stubModule(instagramAccountsRepo, {
    upsertForClient: async (clientId, fields) => { calls.upsertForClient.push({ clientId, fields }); return { id: 'ig-account-1', client_id: clientId, ...fields }; },
  });
  const restoreClientsRepo = stubModule(clientsRepo, {
    findById: async () => ({ id: 'client-1', status: 'payment_confirmed' }),
    update: async (db, clientId, fields) => { calls.clientsUpdate.push({ clientId, fields }); return { id: clientId, ...fields }; },
  });
  try {
    const { account } = await completeInstagramConnection('fake-db', 'client-1', {
      pageId: 'page-1', pageAccessToken: 'page-token', instagramBusinessAccountId: 'ig-1', igUsername: 'test_ig',
    });
    assert.equal(calls.subscribePageApp.length, 1);
    assert.equal(calls.subscribePageApp[0].pageId, 'page-1');
    assert.equal(calls.upsertForClient.length, 1);
    assert.equal(calls.upsertForClient[0].fields.status, 'connected');
    assert.notEqual(calls.upsertForClient[0].fields.access_token_encrypted, 'page-token', 'the token must be encrypted, never stored raw');
    assert.equal(account.id, 'ig-account-1');
    assert.equal(calls.clientsUpdate.length, 1, 'a payment_confirmed client must be bumped to active');
    assert.equal(calls.clientsUpdate[0].fields.status, 'active');
  } finally {
    restoreClient();
    restoreAccountsRepo();
    restoreClientsRepo();
  }
});

test('completeInstagramConnection: does not touch client status when the client is already active', async () => {
  const calls = { clientsUpdate: [] };
  const restoreClient = stubModule(instagramClient, { subscribePageApp: async () => ({}) });
  const restoreAccountsRepo = stubModule(instagramAccountsRepo, {
    upsertForClient: async (clientId, fields) => ({ id: 'ig-account-1', client_id: clientId, ...fields }),
  });
  const restoreClientsRepo = stubModule(clientsRepo, {
    findById: async () => ({ id: 'client-1', status: 'active' }),
    update: async (db, clientId, fields) => { calls.clientsUpdate.push({ clientId, fields }); return {}; },
  });
  try {
    await completeInstagramConnection('fake-db', 'client-1', {
      pageId: 'page-1', pageAccessToken: 'page-token', instagramBusinessAccountId: 'ig-1', igUsername: 'test_ig',
    });
    assert.equal(calls.clientsUpdate.length, 0);
  } finally {
    restoreClient();
    restoreAccountsRepo();
    restoreClientsRepo();
  }
});
