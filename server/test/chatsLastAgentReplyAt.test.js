// Unit 0.2 (docs/ai-agent/IMPLEMENTATION.md): chats.last_agent_reply_at.
//
// Stubs only — nothing here may reach a real database (this project has no
// separate dev DB, and src/db/pool.js refuses any test that tries). Real
// repo/service/route code runs against a recording fake `db`; collaborators
// that would touch Meta or other tables are monkey-patched on their required
// singleton objects and restored after each test.
//
// The six write-rule tests are numbered W1-W6 in their titles so they can be
// reported individually. They prove WHICH statements run; the SQL itself
// (greatest()/coalesce(), the savepoint) was executed once against a
// throwaway local Postgres, see the unit's report.
//
// What W2-W4 do and do not prove: broadcastRunner, flowEngine and the Hub API
// all funnel into messagingService.sendChatMessage (verified by grep), so each
// test drives that REAL function with the exact argument shape that caller
// uses, and asserts it issues no statement touching last_agent_reply_at. The
// source-scan test then proves none of those callers (nor anything else)
// writes the column on its own. They do not run each runner end to end; that
// needs a database.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const chatsRepo = require('../src/repositories/chatsRepo');
const chatSlaLogsRepo = require('../src/repositories/chatSlaLogsRepo');
const wabasRepo = require('../src/repositories/wabasRepo');
const subscriptionsRepo = require('../src/repositories/subscriptionsRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const metaClient = require('../src/utils/metaClient');
const messagingService = require('../src/services/messagingService');
const { encrypt } = require('../src/utils/encryption');
const { isHumanActive, HUMAN_ACTIVE_WINDOW_MS } = require('../src/services/humanActivity');
const migration = require('../src/db/migrations/087_chats_last_agent_reply_at');

const CLIENT_ID = 'client-1';
const CHAT_ID = '00000000-0000-4000-8000-000000000001';
const MSG_ID = '00000000-0000-4000-8000-000000000002';
const COLUMN = 'last_agent_reply_at';

// ---- recording fake db -----------------------------------------------------
function fakeDb({ rowsFor = () => [{ id: 'row-1', status: 'pending' }], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (failOn && failOn.test(String(sql))) throw new Error('simulated statement failure');
      return { rows: rowsFor(String(sql), params) };
    },
    touched: () => calls.filter((c) => c.sql.includes(COLUMN)),
  };
}

// ---- monkey-patch bookkeeping ---------------------------------------------
const restores = [];
function patch(obj, key, value) {
  const original = obj[key];
  obj[key] = value;
  restores.push(() => { obj[key] = original; });
}
afterEach(() => { while (restores.length) restores.pop()(); });

// ---- route harness: the REAL routes/chats.js behind fake auth --------------
function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.db = db;
    req.clientId = CLIENT_ID;
    req.actorType = 'team_member';
    req.actorRole = 'Agent';
    req.actorId = 'team-member-1';
    req.commitAndRelease = async () => {};
    req.reacquireDb = async () => db;
    next();
  });
  app.use('/api/chats', require('../src/routes/chats'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function request(app, method, url, body) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubRouteCollaborators({ send } = {}) {
  const order = [];
  patch(chatsRepo, 'findById', async () => ({ id: CHAT_ID, client_id: CLIENT_ID, phone: '919876500000', contact_id: null }));
  patch(chatsRepo, 'findMessageById', async () => ({ id: MSG_ID, status: 'failed', body: 'hi' }));
  patch(chatsRepo, 'findLastInboundMessage', async () => null);
  patch(chatSlaLogsRepo, 'recordFirstResponseIfAbsent', async () => {});
  patch(messagingService, 'sendChatMessage', async (...args) => {
    order.push('send');
    if (send) return send(...args);
    return { id: MSG_ID, status: 'sent' };
  });
  patch(messagingService, 'retryMessage', async () => {
    order.push('retry');
    return { id: MSG_ID, status: 'sent' };
  });
  return order;
}

// ---- real sendChatMessage harness (broadcast / flow / Hub API) -------------
function stubSendPipeline() {
  patch(chatsRepo, 'lastInboundAt', async () => new Date().toISOString()); // window open
  patch(wabasRepo, 'findByClientId', async () => ({
    status: 'connected', phone_number_id: 'phone-1', access_token_encrypted: encrypt('fake-token-never-sent'),
  }));
  patch(subscriptionsRepo, 'findByClientId', async () => null); // no plan limit
  patch(messageTemplatesRepo, 'findByNameAndClient', async () => ({ category: 'Utility', header_type: 'NONE' }));
  patch(metaClient, 'sendTextMessage', async () => 'wamid.TEXT');
  patch(metaClient, 'sendTemplateMessage', async () => 'wamid.TEMPLATE');
  patch(metaClient, 'sendInteractiveMessage', async () => 'wamid.INTERACTIVE');
}
const CHAT = { id: CHAT_ID, client_id: CLIENT_ID, phone: '919876500000', contact_id: null };

// =============================================================================
// THE SIX WRITE-RULE TESTS
// =============================================================================

test('W1: a human send through routes/chats.js WRITES last_agent_reply_at', async () => {
  const db = fakeDb();
  const order = stubRouteCollaborators();
  const res = await request(buildApp(db), 'POST', `/api/chats/${CHAT_ID}/messages`, { type: 'text', body: 'Hello from the inbox' });

  assert.equal(res.status, 201);
  const writes = db.touched();
  assert.equal(writes.length, 1, 'exactly one write to the column');
  assert.match(writes[0].sql, /update chats\s+set last_agent_reply_at\s*=\s*greatest\(/);
  assert.deepEqual(writes[0].params, [CLIENT_ID, CHAT_ID], 'scoped to this client and this chat');
  assert.deepEqual(order, ['send'], 'the send still happened');
  // Written BEFORE the send, so it is committed by the route's own release
  // on both the success and the send_failed paths.
  const writeIndex = db.calls.findIndex((c) => c.sql.includes(COLUMN));
  assert.ok(writeIndex >= 0);
  // The retry route is the second permitted human writer.
  const retryDb = fakeDb();
  stubRouteCollaborators();
  const retryRes = await request(buildApp(retryDb), 'POST', `/api/chats/${CHAT_ID}/messages/${MSG_ID}/retry`);
  assert.equal(retryRes.status, 200);
  assert.equal(retryDb.touched().length, 1, 'a human retry also counts');
});

test('W2: a BROADCAST send (broadcastRunner -> sendChatMessage with the privileged pool, template) does NOT write it', async () => {
  const db = fakeDb();
  stubSendPipeline();
  const sent = await messagingService.sendChatMessage(db, CLIENT_ID, CHAT, {
    type: 'template',
    templateName: 'weekly_offer',
    templateLanguage: 'en',
    templateComponents: [],
    headerMediaAssetId: undefined,
  });
  assert.ok(sent, 'the send really ran');
  assert.ok(db.calls.length > 0, 'and it really issued statements');
  assert.equal(db.touched().length, 0, 'but none touched last_agent_reply_at');
});

test('W3: a FLOW send (flowEngine -> sendChatMessage, text and interactive) does NOT write it', async () => {
  const db = fakeDb();
  stubSendPipeline();
  await messagingService.sendChatMessage(db, CLIENT_ID, CHAT, { type: 'text', body: 'Welcome!' });
  await messagingService.sendChatMessage(db, CLIENT_ID, CHAT, {
    type: 'interactive', body: 'Pick one', buttons: [{ id: 'a', title: 'A' }],
  });
  assert.ok(db.calls.length > 0);
  assert.equal(db.touched().length, 0);
});

test('W4: a HUB API send (apiV1Messages -> sendChatMessage with the pool, text and template with components) does NOT write it', async () => {
  const db = fakeDb();
  stubSendPipeline();
  await messagingService.sendChatMessage(db, CLIENT_ID, CHAT, { type: 'text', body: 'Your order shipped' });
  await messagingService.sendChatMessage(db, CLIENT_ID, CHAT, {
    type: 'template', templateName: 'order_update', templateLanguage: 'en',
    templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'A123', parameter_name: 'order' }] }],
  });
  assert.ok(db.calls.length > 0);
  assert.equal(db.touched().length, 0);
});

test('W5: an echo of a message Wasi ALREADY HAS (its own send coming back) does NOT write it', async () => {
  // The echo's meta_message_id already exists, so ON CONFLICT DO NOTHING
  // inserts nothing and RETURNING yields no row.
  const db = fakeDb({ rowsFor: () => [] });
  const result = await chatsRepo.insertEcho(db, CLIENT_ID, CHAT_ID, {
    metaMessageId: 'wamid.OWN_SEND', body: 'sent by Wasi', sentAt: '2026-10-13T09:00:00.000Z',
  });
  assert.equal(result, null);
  assert.equal(db.calls.length, 1, 'only the insert ran; no chat update at all');
  assert.equal(db.touched().length, 0);
});

test('W6: an echo of a message Wasi does NOT have (a person replying from their own phone) DOES write it, from the echo\'s own timestamp', async () => {
  const echoSentAt = new Date('2026-10-13T09:00:00.000Z');
  const db = fakeDb({ rowsFor: () => [{ id: 'echo-row', sent_at: echoSentAt }] });
  const result = await chatsRepo.insertEcho(db, CLIENT_ID, CHAT_ID, {
    metaMessageId: 'wamid.PHONE_REPLY', body: 'replied from phone', sentAt: echoSentAt.toISOString(),
  });
  assert.ok(result);
  const writes = db.touched();
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /last_agent_reply_at\s*=\s*greatest\(coalesce\(last_agent_reply_at, \$3::timestamptz\), \$3::timestamptz\)/);
  assert.deepEqual(writes[0].params, [CLIENT_ID, CHAT_ID, echoSentAt], 'uses the echo\'s own time, not now()');
});

// =============================================================================
// SUPPORTING TESTS
// =============================================================================

test('the human write is non-fatal: a failing bookkeeping statement does not fail or poison the send', async () => {
  const db = fakeDb({ failOn: /update chats\s+set last_agent_reply_at/ });
  stubRouteCollaborators();
  const res = await request(buildApp(db), 'POST', `/api/chats/${CHAT_ID}/messages`, { type: 'text', body: 'still goes out' });
  assert.equal(res.status, 201, 'the send is not failed by the bookkeeping');
  const sqls = db.calls.map((c) => c.sql);
  assert.ok(sqls.includes('savepoint mark_agent_reply'));
  assert.ok(sqls.includes('rollback to savepoint mark_agent_reply'), 'the transaction is rolled back to the savepoint so later writes survive');
});

test('a human reply that is then rejected (409 session_window_closed) is still recorded: a person was working the chat', async () => {
  const db = fakeDb();
  stubRouteCollaborators({
    send: async () => { throw new messagingService.MessagingError('outside window', 'session_window_closed'); },
  });
  const res = await request(buildApp(db), 'POST', `/api/chats/${CHAT_ID}/messages`, { type: 'text', body: 'too late' });
  assert.equal(res.status, 409);
  assert.equal(db.touched().length, 1);
});

test('source scan: only chatsRepo.js assigns the column, and only insertEcho and markAgentReplyNonFatal do within it; only routes/chats.js calls the human writer', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }(root));
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');

  const assigners = files.filter((f) => /last_agent_reply_at\s*=/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(assigners, ['repositories/chatsRepo.js'],
    'only chatsRepo.js may assign last_agent_reply_at; a flow, runner, Hub API or agent file doing so is the bug this unit exists to prevent');

  const callers = files
    .filter((f) => /markAgentReplyNonFatal\(/.test(fs.readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
  assert.deepEqual(callers, ['repositories/chatsRepo.js', 'routes/chats.js'], 'the human writer is called only from the inbox routes');

  // Within chatsRepo.js, only the two sanctioned functions assign it.
  const repoSrc = fs.readFileSync(path.join(root, 'repositories', 'chatsRepo.js'), 'utf8');
  const writers = repoSrc
    .split(/\nasync function /)
    .slice(1)
    .filter((chunk) => /last_agent_reply_at\s*=/.test(chunk))
    .map((chunk) => chunk.slice(0, chunk.indexOf('(')))
    .sort();
  assert.deepEqual(writers, ['insertEcho', 'markAgentReplyNonFatal']);

  // And the shared send choke points never mention it at all.
  for (const f of ['services/messagingService.js', 'services/broadcastRunner.js', 'services/flowEngine.js',
    'services/automationEngine.js', 'routes/apiV1Messages.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /last_agent_reply_at|markAgentReply/, `${f} must not touch it`);
  }
});

test('migration 087: nullable timestamptz, no default, down is refused when real values exist', async () => {
  const added = [];
  migration.up({ addColumns: (table, cols) => added.push({ table, cols }) });
  assert.deepEqual(added, [{ table: 'chats', cols: { last_agent_reply_at: { type: 'timestamptz' } } }]);

  const dropped = [];
  await migration.down({
    db: { select: async () => [{ count: 0 }] },
    dropColumns: (table, cols) => dropped.push({ table, cols }),
  });
  assert.deepEqual(dropped, [{ table: 'chats', cols: ['last_agent_reply_at'] }]);

  await assert.rejects(
    () => migration.down({ db: { select: async () => [{ count: 3 }] }, dropColumns: () => assert.fail('must not drop') }),
    /Cannot roll back 087_chats_last_agent_reply_at: 3 chat\(s\)/
  );
});

test('migration 087 is the next free number', () => {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('087_')), ['087_chats_last_agent_reply_at.js']);
});

// =============================================================================
// GATE 4 READER: null means unknown, never "a human replied at the epoch"
// =============================================================================

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

test('gate 4: null / undefined / unparseable last_agent_reply_at is "no recent human reply", NOT a timestamp', () => {
  for (const value of [null, undefined, 'not-a-date', '', NaN]) {
    assert.deepEqual(isHumanActive({ assigned_team_member_id: null, last_agent_reply_at: value }, NOW), { active: false, reason: null },
      `value ${String(value)} must read as unknown`);
  }
  assert.deepEqual(isHumanActive({}, NOW), { active: false, reason: null });
  assert.deepEqual(isHumanActive(null, NOW), { active: false, reason: null });
});

test('gate 4: an explicit epoch (1970) timestamp is simply very old, so inactive', () => {
  assert.equal(isHumanActive({ last_agent_reply_at: new Date(0) }, NOW).active, false);
  assert.equal(isHumanActive({ last_agent_reply_at: '1970-01-01T00:00:00Z' }, NOW).active, false);
});

test('gate 4: 15-minute boundary (14 min active, exactly 15 inactive, 16 inactive)', () => {
  assert.deepEqual(isHumanActive({ last_agent_reply_at: ago(14 * 60 * 1000) }, NOW), { active: true, reason: 'recent_agent_reply' });
  assert.equal(isHumanActive({ last_agent_reply_at: ago(HUMAN_ACTIVE_WINDOW_MS) }, NOW).active, false);
  assert.equal(isHumanActive({ last_agent_reply_at: ago(16 * 60 * 1000) }, NOW).active, false);
});

test('gate 4: an assigned chat is human-active even with a null last_agent_reply_at', () => {
  assert.deepEqual(isHumanActive({ assigned_team_member_id: 'tm-1', last_agent_reply_at: null }, NOW), { active: true, reason: 'assigned' });
});

test('gate 4: accepts ISO strings (as drivers return them) and Dates alike', () => {
  assert.equal(isHumanActive({ last_agent_reply_at: ago(60 * 1000).toISOString() }, NOW).active, true);
  assert.equal(isHumanActive({ last_agent_reply_at: ago(60 * 1000) }, NOW).active, true);
});

test('gate 4: small clock skew into the future counts as just now; a far-future value cannot silence a chat', () => {
  assert.equal(isHumanActive({ last_agent_reply_at: new Date(NOW.getTime() + 30 * 1000) }, NOW).active, true);
  assert.equal(isHumanActive({ last_agent_reply_at: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }, NOW).active, false);
});
