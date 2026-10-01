// paymentNotificationService: every billing-message attempt is logged,
// success or failure. Stubs only — this repo's DB guard (see dbSafety.js)
// refuses any test that reaches the shared database, so the repo's SQL is
// not exercised here (it was checked once in a rolled-back transaction, see
// CLAUDE.md's Payment reminder audit entry). Nothing is ever sent to Meta.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const clientNotifier = require('../src/services/clientNotifier');
const paymentNotificationsRepo = require('../src/repositories/paymentNotificationsRepo');
const paymentNotificationService = require('../src/services/paymentNotificationService');

const wabasRepo = require('../src/repositories/wabasRepo');
const realSend = clientNotifier.sendTemplateToClient;
const realResolve = clientNotifier.resolveRecipientPhone;
const realFindWaba = wabasRepo.findByClientId;
const realRecord = paymentNotificationsRepo.record;
const client = { id: 'c1', name: 'Acme', contact_phone: '919999900001' };
const opts = { kind: 'payment_reminder', trigger: 'manual_bulk', name: 'wasi_payment_reminder', bodyParams: { client_name: 'Acme' }, triggeredBy: 'admin1' };

afterEach(() => {
  clientNotifier.sendTemplateToClient = realSend;
  clientNotifier.resolveRecipientPhone = realResolve;
  wabasRepo.findByClientId = realFindWaba;
  paymentNotificationsRepo.record = realRecord;
});

test('a successful send is logged as sent with Meta\'s message id', async () => {
  let logged;
  clientNotifier.resolveRecipientPhone = async (c) => c.contact_phone;
  clientNotifier.sendTemplateToClient = async () => 'wamid.X';
  paymentNotificationsRepo.record = async (row) => { logged = row; return row; };
  const result = await paymentNotificationService.sendAndLog(client, opts);
  assert.equal(result.ok, true);
  assert.equal(logged.status, 'sent');
  assert.equal(logged.meta_message_id, 'wamid.X');
  assert.equal(logged.client_name, 'Acme');
  assert.equal(logged.recipient_phone, '919999900001');
  assert.equal(logged.triggered_by, 'admin1');
});

test('a failed send is still logged, with the real reason, and does not throw', async () => {
  let logged;
  clientNotifier.resolveRecipientPhone = async (c) => c.contact_phone;
  clientNotifier.sendTemplateToClient = async () => { throw new Error('PAYMENT_REMINDER_WABA_ID is not configured'); };
  paymentNotificationsRepo.record = async (row) => { logged = row; return row; };
  const result = await paymentNotificationService.sendAndLog(client, opts);
  assert.equal(result.ok, false);
  assert.equal(logged.status, 'failed');
  assert.match(logged.error_message, /not configured/);
  assert.equal(logged.meta_message_id, null);
});

test('recipient falls back to the connected WABA number (digits only) when no contact_phone', async () => {
  wabasRepo.findByClientId = async () => ({ display_phone_number: '+91 99522 70424' });
  assert.equal(await clientNotifier.resolveRecipientPhone({ id: 'c2', contact_phone: null }), '919952270424');
  assert.equal(await clientNotifier.resolveRecipientPhone({ id: 'c2', contact_phone: '+919688440032' }), '+919688440032');
  wabasRepo.findByClientId = async () => null;
  assert.equal(await clientNotifier.resolveRecipientPhone({ id: 'c3', contact_phone: null }), null);
});

test('sendTemplateToClient sends from the Wasi Demo Client WABA when PAYMENT_REMINDER_WABA_ID is unset', async () => {
  const metaClient = require('../src/utils/metaClient');
  const { encrypt } = require('../src/utils/encryption');
  const realSendTpl = metaClient.sendTemplateMessage;
  const saved = process.env.PAYMENT_REMINDER_WABA_ID;
  const savedSecret = process.env.SERVER_SECRET;
  process.env.SERVER_SECRET = 'test-only-secret-not-a-real-key';
  delete process.env.PAYMENT_REMINDER_WABA_ID;
  let call = null; const mirrored = {};
  const contactsRepo = require('../src/repositories/contactsRepo');
  const chatsRepo = require('../src/repositories/chatsRepo');
  const orig = { up: contactsRepo.upsertByPhone, foc: chatsRepo.findOrCreateByContact, ins: chatsRepo.insertOutboundPending, ms: chatsRepo.markSent };
  contactsRepo.upsertByPhone = async (db, clientId, c) => { mirrored.clientId = clientId; mirrored.phone = c.phone; return { id: 'ct1' }; };
  chatsRepo.findOrCreateByContact = async () => ({ id: 'ch1' });
  chatsRepo.insertOutboundPending = async (db, cid, chatId, body) => { mirrored.body = body; return { id: 'm1' }; };
  chatsRepo.markSent = async (db, cid, id, metaId) => { mirrored.metaId = metaId; return {}; };
  wabasRepo.findByClientId = async (id) => {
    return id === '00000000-0000-0000-0000-000000000001'
      ? { client_id: '00000000-0000-0000-0000-000000000001', phone_number_id: 'PN1', access_token_encrypted: encrypt('tok') } : null;
  };
  metaClient.sendTemplateMessage = async (...args) => { call = args; return 'wamid.Y'; };
  try {
    const id = await clientNotifier.sendTemplateToClient(
      { id: 'cX', name: 'X', contact_phone: '919999900009' },
      { name: 'wasi_payment_reminder', bodyParams: { client_name: 'X' } });
    assert.equal(id, 'wamid.Y');
    assert.equal(call[0], 'PN1');
    assert.equal(call[1], 'tok');
    assert.equal(call[2], '919999900009');
    assert.equal(mirrored.clientId, '00000000-0000-0000-0000-000000000001');
    assert.equal(mirrored.phone, '919999900009');
    assert.equal(mirrored.body, '[template: wasi_payment_reminder]');
    assert.equal(mirrored.metaId, 'wamid.Y');
  } finally {
    metaClient.sendTemplateMessage = realSendTpl;
    contactsRepo.upsertByPhone = orig.up; chatsRepo.findOrCreateByContact = orig.foc; chatsRepo.insertOutboundPending = orig.ins; chatsRepo.markSent = orig.ms;
    if (saved !== undefined) process.env.PAYMENT_REMINDER_WABA_ID = saved;
    if (savedSecret === undefined) delete process.env.SERVER_SECRET; else process.env.SERVER_SECRET = savedSecret;
  }
});
