// Coexistence echo ingestion, Phase 1 — stubs only, per explicit instruction
// for this task: nothing written to the shared database (this project has
// no separate dev DB). Repo functions are monkey-patched on their required
// singleton module objects and restored after each test, same pattern as
// sessionInvalidation.test.js. Requiring '../src/routes/metaWebhook' (and
// its own '../src/db/pool' import) only constructs objects — no query is
// ever allowed to reach the real driver in this file.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/db/pool');
const chatsRepo = require('../src/repositories/chatsRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const { handleMessageEchoes } = require('../src/routes/metaWebhook');

const WABA = { id: 'waba-row-1', client_id: 'client-1', waba_id: '999888777' };

function stubRepos({ existingChat = null } = {}) {
  const calls = { upsertByPhone: [], findOrCreateByContact: [], insertEcho: [] };
  const originals = {
    upsertByPhone: contactsRepo.upsertByPhone,
    findOrCreateByContact: chatsRepo.findOrCreateByContact,
    insertEcho: chatsRepo.insertEcho,
  };

  contactsRepo.upsertByPhone = async (db, clientId, { phone, name, wa_id }) => {
    calls.upsertByPhone.push({ clientId, phone, name, wa_id });
    return { id: 'contact-1', client_id: clientId, phone, name };
  };
  chatsRepo.findOrCreateByContact = async (db, clientId, contact) => {
    calls.findOrCreateByContact.push({ clientId, contact });
    return existingChat || { id: 'chat-new', client_id: clientId, contact_id: contact.id };
  };
  chatsRepo.insertEcho = async (db, clientId, chatId, fields) => {
    calls.insertEcho.push({ clientId, chatId, fields });
    return { id: 'message-1', chat_id: chatId, client_id: clientId, direction: 'out', status: 'delivered', ...fields };
  };

  return {
    calls,
    restore: () => {
      contactsRepo.upsertByPhone = originals.upsertByPhone;
      chatsRepo.findOrCreateByContact = originals.findOrCreateByContact;
      chatsRepo.insertEcho = originals.insertEcho;
    },
  };
}

// --- handleMessageEchoes (webhook-level ingestion) ---

test('handleMessageEchoes: a text echo resolves the contact/chat by the `to` number and inserts via chatsRepo.insertEcho', async () => {
  const stub = stubRepos();
  try {
    await handleMessageEchoes(WABA, {
      message_echoes: [
        { id: 'wamid.ECHO1', from: '911234500000', to: '919876500000', timestamp: '1758700000', type: 'text', text: { body: 'On my way!' } },
      ],
    });

    assert.equal(stub.calls.upsertByPhone.length, 1);
    assert.equal(stub.calls.upsertByPhone[0].phone, '919876500000', 'must resolve the chat by the CUSTOMER number (`to`), not the business\'s own number (`from`)');

    assert.equal(stub.calls.insertEcho.length, 1);
    const { fields } = stub.calls.insertEcho[0];
    assert.equal(fields.metaMessageId, 'wamid.ECHO1');
    assert.equal(fields.body, 'On my way!');
    assert.equal(fields.sentAt, new Date(1758700000 * 1000).toISOString());
  } finally {
    stub.restore();
  }
});

test('handleMessageEchoes: an echo to a contact with no prior chat still resolves via findOrCreateByContact (a business can start a conversation from their phone)', async () => {
  const stub = stubRepos({ existingChat: null }); // findOrCreateByContact's stub returns a freshly "created" chat when none exists
  try {
    await handleMessageEchoes(WABA, {
      message_echoes: [{ id: 'wamid.ECHO2', from: '911234500000', to: '919000000001', timestamp: '1758700100', type: 'text', text: { body: 'Hi, new here' } }],
    });
    assert.equal(stub.calls.findOrCreateByContact.length, 1, 'must call findOrCreateByContact — the function that creates a chat when none exists yet');
    assert.equal(stub.calls.insertEcho[0].chatId, 'chat-new');
  } finally {
    stub.restore();
  }
});

test('handleMessageEchoes: an unrecognized/unstructured echo type is still stored (best-effort), never dropped silently', async () => {
  const stub = stubRepos();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await handleMessageEchoes(WABA, {
      message_echoes: [{ id: 'wamid.ECHO3', from: '911234500000', to: '919876500000', timestamp: '1758700200', type: 'sticker' }],
    });
    assert.equal(stub.calls.insertEcho.length, 1, 'an unrecognized type must still produce a stored row');
    assert.equal(stub.calls.insertEcho[0].fields.body, '[sticker]');
    assert.ok(warnings.some((w) => w.includes('unrecognized')), 'an unrecognized type must be logged, not silently dropped');
  } finally {
    console.warn = originalWarn;
    stub.restore();
  }
});

test('handleMessageEchoes: an echo with no `to` is skipped (can\'t resolve a chat) without throwing', async () => {
  const stub = stubRepos();
  try {
    await handleMessageEchoes(WABA, {
      message_echoes: [{ id: 'wamid.ECHO4', from: '911234500000', timestamp: '1758700300', type: 'text', text: { body: 'orphaned' } }],
    });
    assert.equal(stub.calls.insertEcho.length, 0);
    assert.equal(stub.calls.upsertByPhone.length, 0);
  } finally {
    stub.restore();
  }
});

// --- chatsRepo.insertEcho (the dedicated insert path itself) ---

function fakeDb(queryImpl) {
  return { query: queryImpl };
}

test('chatsRepo.insertEcho: inserts direction=out/status=delivered, and clears unread_count (an echo is proof the business already answered)', async () => {
  const queries = [];
  const db = fakeDb(async (sql, params) => {
    queries.push({ sql, params });
    if (/^insert into messages/.test(sql)) return { rows: [{ id: 'msg-1', direction: 'out', status: 'delivered' }] };
    return { rows: [] };
  });

  const row = await chatsRepo.insertEcho(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.X', body: 'hi', sentAt: null });

  assert.ok(row);
  const insertSql = queries.find((q) => /^insert into messages/.test(q.sql)).sql;
  assert.match(insertSql, /'out'/, 'must insert direction as out');
  assert.match(insertSql, /'delivered'/, 'must insert status directly as delivered, not pending');
  assert.doesNotMatch(insertSql, /unread_count/, 'unread_count is a chats-table column, never touched by the messages insert itself');

  const updateSql = queries.find((q) => /^update chats/.test(q.sql))?.sql;
  assert.ok(updateSql, 'must still update chats.last_message_at, the way inbound does');
  assert.match(updateSql, /unread_count\s*=\s*0/, 'a successful echo insert must zero unread_count on the chat — the business already answered from their phone');
});

test('chatsRepo.insertEcho: does NOT clear unread_count when the insert is a no-op (a redelivered webhook for an already-seen echo)', async () => {
  const queries = [];
  const db = fakeDb(async (sql, params) => {
    queries.push({ sql, params });
    if (/^insert into messages/.test(sql)) return { rows: [] }; // ON CONFLICT DO NOTHING — already ingested
    return { rows: [] };
  });

  const row = await chatsRepo.insertEcho(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.ALREADY-SEEN', body: 'hi' });

  assert.equal(row, null);
  assert.equal(queries.some((q) => /^update chats/.test(q.sql)), false, 'a no-op insert must not re-zero unread_count for an unrelated new unread message that may have arrived in between');
});

test('chatsRepo.insertEcho: is idempotent on the echo\'s own meta message id — the same payload twice inserts exactly one row', async () => {
  let insertCount = 0;
  const db = fakeDb(async (sql) => {
    if (/^insert into messages/.test(sql)) {
      insertCount += 1;
      // Mirrors real ON CONFLICT (meta_message_id) DO NOTHING behavior: the
      // first call returns the row, a redelivered webhook's second call
      // returns nothing.
      return { rows: insertCount === 1 ? [{ id: 'msg-1', direction: 'out', status: 'delivered' }] : [] };
    }
    return { rows: [] };
  });

  const first = await chatsRepo.insertEcho(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.DUPLICATE', body: 'hi' });
  const second = await chatsRepo.insertEcho(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.DUPLICATE', body: 'hi' });

  assert.ok(first, 'first delivery inserts a row');
  assert.equal(second, null, 'a redelivered webhook for the same echo must not insert a second row');
  assert.equal(insertCount, 2, 'both delivery attempts DO run the insert statement — ON CONFLICT DO NOTHING at the DB level is what prevents the duplicate, not app-level skipping');
});

test('chatsRepo.insertEcho: defaults source to whatsapp_app', async () => {
  let capturedParams = null;
  const db = fakeDb(async (sql, params) => {
    if (/^insert into messages/.test(sql)) {
      capturedParams = params;
      return { rows: [{ id: 'msg-1' }] };
    }
    return { rows: [] };
  });
  await chatsRepo.insertEcho(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.Y', body: 'hi' });
  assert.ok(capturedParams.includes('whatsapp_app'), 'source must default to whatsapp_app when the caller does not override it');
});
