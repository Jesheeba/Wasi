// Central place any outbound WhatsApp send goes through — chat replies,
// automation-rule actions, and (server/src/services/broadcastRunner.js)
// campaign sends all call this, so the session-window rule and
// sent/failed bookkeeping only exist in one place.
//
// Every function here takes `db` first, forwarded straight through from the
// caller (req.db for a client-authenticated chat reply, the privileged
// `pool` for broadcastRunner/automationEngine) — same convention as the
// repos it calls (see repositories/tagsRepo.js's module comment). The one
// exception is the WABA lookup in getSendableWaba: it always uses the
// privileged `pool` directly, never the passed-in `db`, because
// wabas.access_token_encrypted is revoked from the restricted role at the
// column level (migration 013_tenant_isolation.js) — see wabasRepo.js's
// module comment for the full reasoning.
const wabasRepo = require('../repositories/wabasRepo');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const plansRepo = require('../repositories/plansRepo');
const usageRepo = require('../repositories/usageRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

class MessagingError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function getSendableWaba(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    throw new MessagingError('No connected WhatsApp Business number for this account.', 'waba_not_connected');
  }
  return waba;
}

async function canSendFreeform(db, clientId, chatId) {
  const lastIn = await chatsRepo.lastInboundAt(db, clientId, chatId);
  if (!lastIn) return false;
  return Date.now() - new Date(lastIn).getTime() < SESSION_WINDOW_MS;
}

// Marketing consent gate (build plan Phase 4) — the send path is the
// enforcement point precisely so it can't be bypassed by a different
// caller (chats.js's manual send route, broadcastRunner, or anything
// future) the way a UI-only check could be. Utility and authentication
// templates are exempt; a template whose category can't be determined
// locally is treated as marketing — fail closed, not open.
async function assertConsentForTemplate(db, clientId, chat, templateName) {
  const template = await messageTemplatesRepo.findByNameAndClient(db, clientId, templateName);
  const requiresConsent = !template || template.category === 'Marketing';
  if (!requiresConsent) return;

  const contact = chat.contact_id ? await contactsRepo.findById(db, clientId, chat.contact_id) : null;
  if (!contact || contact.opt_in_status !== 'opted_in') {
    throw new MessagingError(
      'This contact has not opted in to marketing messages — utility/authentication templates are unaffected.',
      'consent_required'
    );
  }
}

// Approximate plan enforcement — see usageRepo.monthToDateSent for the
// "outbound messages this month" proxy this checks against.
async function assertWithinPlanLimit(db, clientId) {
  const subscription = await subscriptionsRepo.findByClientId(db, clientId);
  if (!subscription || subscription.status !== 'active') return; // no active paid plan to enforce yet — don't block dev/demo use
  const plan = await plansRepo.findById(subscription.plan);
  if (!plan || plan.conversation_limit == null) return; // unlimited (Scale) or unknown plan
  const used = await usageRepo.monthToDateSent(db, clientId);
  if (used >= plan.conversation_limit) {
    throw new MessagingError(
      `Monthly conversation limit reached for the ${subscription.plan} plan (${plan.conversation_limit}/mo). Upgrade to send more.`,
      'plan_limit_reached'
    );
  }
}

// type: 'text' -> { body }. type: 'template' -> { templateName, templateLanguage, templateComponents }.
async function sendChatMessage(db, clientId, chat, { type, body, templateName, templateLanguage, templateComponents }) {
  if (type === 'text' && !(await canSendFreeform(db, clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window — send a template message instead.',
      'session_window_closed'
    );
  }
  if (type === 'template') {
    await assertConsentForTemplate(db, clientId, chat, templateName);
  }
  await assertWithinPlanLimit(db, clientId);

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);
  const toPhone = chat.phone;
  const displayBody = type === 'text' ? body : `[template: ${templateName}]`;

  const message = await chatsRepo.insertOutboundPending(db, clientId, chat.id, displayBody);

  try {
    const metaMessageId = type === 'text'
      ? await metaClient.sendTextMessage(waba.phone_number_id, accessToken, toPhone, body)
      : await metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, toPhone, {
          name: templateName,
          language: templateLanguage,
          components: templateComponents || [],
        });
    const sent = await chatsRepo.markSent(db, clientId, message.id, metaMessageId);
    await usageRepo.incrementSent(db, clientId);
    return sent;
  } catch (err) {
    await chatsRepo.markFailed(db, clientId, message.id, err.message);
    throw new MessagingError(err.message, 'send_failed');
  }
}

// Re-attempts a previously failed send using its original text body. Only
// supports retrying free-form text (the common failed case — a transient
// Cloud API error); a template retry should go through sendChatMessage again
// with the template explicitly, since we don't persist which template a
// message used.
async function retryMessage(db, clientId, chat, message) {
  if (message.status !== 'failed') {
    throw new MessagingError('Only a failed message can be retried.', 'not_failed');
  }
  if (!(await canSendFreeform(db, clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window — send a template message instead.',
      'session_window_closed'
    );
  }

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);

  try {
    const metaMessageId = await metaClient.sendTextMessage(waba.phone_number_id, accessToken, chat.phone, message.body);
    return chatsRepo.markSent(db, clientId, message.id, metaMessageId);
  } catch (err) {
    await chatsRepo.markFailed(db, clientId, message.id, err.message);
    throw new MessagingError(err.message, 'send_failed');
  }
}

module.exports = { MessagingError, canSendFreeform, sendChatMessage, retryMessage, SESSION_WINDOW_MS };
