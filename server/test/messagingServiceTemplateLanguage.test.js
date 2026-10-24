// Real bug, fixed (sixth instance of the same class — see
// templateLanguageHardcodeFixes.test.js's header comment for the first two,
// apiV1MessageLanguage.test.js for the original, and CLAUDE.md for the
// clientNotifier.js/alertNotifier.js instances): messagingService.js's
// sendChatMessage already fetches the template's real local row (needed for
// the consent/Authentication/media-header checks) but used to send to Meta
// with the caller-supplied `templateLanguage` outright, never checking it
// against `template.language`. Every caller that happened to go through one
// of the other fixed call sites passed the real language itself, but this
// is the shared choke point — routes/chats.js's inbox manual-reply send and
// retry routes forward whatever `templateLanguage` the request body
// supplied, with nothing here to catch a stale or wrong value before it
// reached Meta.
//
// Stub-only, no real DB or HTTP server — every dependency sendChatMessage
// calls is monkey-patched on its own required module object (this
// codebase's established mockable-module convention; see alertNotifier.js's
// own module comment on why a destructured require can't be stubbed this
// way). `decrypt`/`encrypt` are real (pure crypto, no DB), so a real
// encrypted fake token round-trips correctly.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const wabasRepo = require('../src/repositories/wabasRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const subscriptionsRepo = require('../src/repositories/subscriptionsRepo');
const usageRepo = require('../src/repositories/usageRepo');
const metaClient = require('../src/utils/metaClient');
const { encrypt } = require('../src/utils/encryption');
const messagingService = require('../src/services/messagingService');

const originals = {
  findByClientId: wabasRepo.findByClientId,
  insertOutboundPending: chatsRepo.insertOutboundPending,
  markSent: chatsRepo.markSent,
  findByIdContact: contactsRepo.findById,
  findByNameAndClient: messageTemplatesRepo.findByNameAndClient,
  subFindByClientId: subscriptionsRepo.findByClientId,
  incrementSent: usageRepo.incrementSent,
  sendTemplateMessage: metaClient.sendTemplateMessage,
};

afterEach(() => {
  wabasRepo.findByClientId = originals.findByClientId;
  chatsRepo.insertOutboundPending = originals.insertOutboundPending;
  chatsRepo.markSent = originals.markSent;
  contactsRepo.findById = originals.findByIdContact;
  messageTemplatesRepo.findByNameAndClient = originals.findByNameAndClient;
  subscriptionsRepo.findByClientId = originals.subFindByClientId;
  usageRepo.incrementSent = originals.incrementSent;
  metaClient.sendTemplateMessage = originals.sendTemplateMessage;
});

function setUpCommonStubs() {
  wabasRepo.findByClientId = async () => ({
    status: 'connected',
    phone_number_id: 'PN1',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  chatsRepo.insertOutboundPending = async () => ({ id: 'msg-1' });
  chatsRepo.markSent = async () => ({ id: 'msg-1', status: 'sent' });
  usageRepo.incrementSent = async () => {};
  subscriptionsRepo.findByClientId = async () => null; // no active plan -> skip plan-limit check
}

test('sendChatMessage: the template\'s REAL local language wins over a stale/wrong caller-supplied templateLanguage', async () => {
  setUpCommonStubs();
  messageTemplatesRepo.findByNameAndClient = async () => ({
    category: 'Utility', header_type: 'NONE', language: 'ta',
  });
  let capturedArgs = null;
  metaClient.sendTemplateMessage = async (phoneNumberId, accessToken, toPhone, args) => {
    capturedArgs = args;
    return 'wamid.X';
  };

  await messagingService.sendChatMessage('db', 'client1', { id: 'chat1', phone: '919999900001' }, {
    type: 'template',
    templateName: 'wasi_payment_reminder',
    templateLanguage: 'en_US', // deliberately wrong/stale — the real row says 'ta'
    templateComponents: [],
  });

  assert.equal(capturedArgs.language, 'ta', 'the real local template row\'s language must win, not the caller-supplied one');
});

test('sendChatMessage: falls back to the caller-supplied templateLanguage only when no local template row exists', async () => {
  setUpCommonStubs();
  messageTemplatesRepo.findByNameAndClient = async () => null;
  // No local template row means assertConsentForTemplate's requiresConsent
  // check (!template) fires — stub an opted-in contact so this test reaches
  // the actual send, which is what's under test here, not the consent gate.
  contactsRepo.findById = async () => ({ opt_in_status: 'opted_in' });
  let capturedArgs = null;
  metaClient.sendTemplateMessage = async (phoneNumberId, accessToken, toPhone, args) => {
    capturedArgs = args;
    return 'wamid.Y';
  };

  await messagingService.sendChatMessage('db', 'client1', { id: 'chat1', phone: '919999900001', contact_id: 'contact1' }, {
    type: 'template',
    templateName: 'some_unsynced_template',
    templateLanguage: 'en',
    templateComponents: [],
  });

  assert.equal(capturedArgs.language, 'en', 'with no local row to trust, the caller-supplied language is the only fallback — unchanged behavior');
});
