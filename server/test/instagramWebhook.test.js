// Instagram DM Automation, Phase 1 — handleInstagramEntry (inbound DM
// ingestion). Stubs only, same dbSafety.js-driven pattern as
// coexistenceEchoIngestion.test.js: repo functions are monkey-patched on
// their required singleton module objects, nothing ever reaches the real
// database. handleInstagramEntry is exported from metaWebhook.js for
// exactly this purpose, the same way handleMessageEchoes already is.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const instagramConversationsRepo = require('../src/repositories/instagramConversationsRepo');
const instagramMessagesRepo = require('../src/repositories/instagramMessagesRepo');
const { handleInstagramEntry } = require('../src/routes/metaWebhook');

const IG_ACCOUNT = { id: 'ig-account-1', client_id: 'client-1', page_id: 'page-1' };

function stubRepos({ existingConversation = null, insertReturns = { id: 'message-1' } } = {}) {
  const calls = { findOrCreateByIgScopedId: [], insertInbound: [], touchLastMessageAt: [] };
  const originals = {
    findOrCreateByIgScopedId: instagramConversationsRepo.findOrCreateByIgScopedId,
    touchLastMessageAt: instagramConversationsRepo.touchLastMessageAt,
    insertInbound: instagramMessagesRepo.insertInbound,
  };

  instagramConversationsRepo.findOrCreateByIgScopedId = async (db, clientId, instagramAccountId, igScopedId) => {
    calls.findOrCreateByIgScopedId.push({ clientId, instagramAccountId, igScopedId });
    return existingConversation || { id: 'conversation-new', client_id: clientId, instagram_account_id: instagramAccountId, ig_scoped_id: igScopedId };
  };
  instagramConversationsRepo.touchLastMessageAt = async (db, id, incrementUnread) => {
    calls.touchLastMessageAt.push({ id, incrementUnread });
    return {};
  };
  instagramMessagesRepo.insertInbound = async (db, clientId, conversationId, body, metaMessageId) => {
    calls.insertInbound.push({ clientId, conversationId, body, metaMessageId });
    return insertReturns;
  };

  return {
    calls,
    restore: () => {
      instagramConversationsRepo.findOrCreateByIgScopedId = originals.findOrCreateByIgScopedId;
      instagramConversationsRepo.touchLastMessageAt = originals.touchLastMessageAt;
      instagramMessagesRepo.insertInbound = originals.insertInbound;
    },
  };
}

test('handleInstagramEntry: a real inbound DM resolves the conversation by sender IGSID and inserts the message', async () => {
  const stub = stubRepos();
  try {
    await handleInstagramEntry(IG_ACCOUNT, {
      id: 'page-1',
      messaging: [
        { sender: { id: 'igsid-123' }, recipient: { id: 'page-1' }, timestamp: 1758700000, message: { mid: 'mid.ABC', text: 'Hi there' } },
      ],
    });

    assert.equal(stub.calls.findOrCreateByIgScopedId.length, 1);
    assert.equal(stub.calls.findOrCreateByIgScopedId[0].igScopedId, 'igsid-123');
    assert.equal(stub.calls.findOrCreateByIgScopedId[0].instagramAccountId, 'ig-account-1');

    assert.equal(stub.calls.insertInbound.length, 1);
    assert.equal(stub.calls.insertInbound[0].conversationId, 'conversation-new');
    assert.equal(stub.calls.insertInbound[0].body, 'Hi there');
    assert.equal(stub.calls.insertInbound[0].metaMessageId, 'mid.ABC');

    assert.equal(stub.calls.touchLastMessageAt.length, 1, 'a newly-inserted message must bump last_message_at/unread_count');
  } finally {
    stub.restore();
  }
});

test('handleInstagramEntry: a redelivered message (idempotent insert returns null) does not double-bump the conversation', async () => {
  const stub = stubRepos({ insertReturns: null });
  try {
    await handleInstagramEntry(IG_ACCOUNT, {
      id: 'page-1',
      messaging: [{ sender: { id: 'igsid-123' }, recipient: { id: 'page-1' }, timestamp: 1758700000, message: { mid: 'mid.ABC', text: 'Hi there' } }],
    });
    assert.equal(stub.calls.touchLastMessageAt.length, 0, 'a redelivery (insertInbound returning null via ON CONFLICT DO NOTHING) must not re-bump the conversation');
  } finally {
    stub.restore();
  }
});

test('handleInstagramEntry: a non-message event (e.g. a read receipt, no message field) is skipped, not an error', async () => {
  const stub = stubRepos();
  try {
    await handleInstagramEntry(IG_ACCOUNT, {
      id: 'page-1',
      messaging: [{ sender: { id: 'igsid-123' }, recipient: { id: 'page-1' }, timestamp: 1758700000, read: { mid: 'mid.ABC' } }],
    });
    assert.equal(stub.calls.findOrCreateByIgScopedId.length, 0, 'must not open/touch a conversation for a non-message event');
  } finally {
    stub.restore();
  }
});

test('handleInstagramEntry: multiple messaging events in one entry are each processed independently', async () => {
  const stub = stubRepos();
  try {
    await handleInstagramEntry(IG_ACCOUNT, {
      id: 'page-1',
      messaging: [
        { sender: { id: 'igsid-1' }, recipient: { id: 'page-1' }, timestamp: 1, message: { mid: 'mid.1', text: 'first' } },
        { sender: { id: 'igsid-2' }, recipient: { id: 'page-1' }, timestamp: 2, message: { mid: 'mid.2', text: 'second' } },
      ],
    });
    assert.equal(stub.calls.insertInbound.length, 2);
    assert.equal(stub.calls.insertInbound[0].body, 'first');
    assert.equal(stub.calls.insertInbound[1].body, 'second');
  } finally {
    stub.restore();
  }
});
