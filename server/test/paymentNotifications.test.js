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
