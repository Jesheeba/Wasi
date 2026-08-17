// Central place any outbound WhatsApp send goes through — chat replies,
// automation-rule actions, and (server/src/services/broadcastRunner.js)
// campaign sends all call this, so the session-window rule and
// sent/failed bookkeeping only exist in one place.
const wabasRepo = require('../repositories/wabasRepo');
const chatsRepo = require('../repositories/chatsRepo');
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

async function canSendFreeform(clientId, chatId) {
  const lastIn = await chatsRepo.lastInboundAt(clientId, chatId);
  if (!lastIn) return false;
  return Date.now() - new Date(lastIn).getTime() < SESSION_WINDOW_MS;
}

// Approximate plan enforcement — see usageRepo.monthToDateSent for the
// "outbound messages this month" proxy this checks against.
async function assertWithinPlanLimit(clientId) {
  const subscription = await subscriptionsRepo.findByClientId(clientId);
  if (!subscription || subscription.status !== 'active') return; // no active paid plan to enforce yet — don't block dev/demo use
  const plan = await plansRepo.findById(subscription.plan);
  if (!plan || plan.conversation_limit == null) return; // unlimited (Scale) or unknown plan
  const used = await usageRepo.monthToDateSent(clientId);
  if (used >= plan.conversation_limit) {
    throw new MessagingError(
      `Monthly conversation limit reached for the ${subscription.plan} plan (${plan.conversation_limit}/mo). Upgrade to send more.`,
      'plan_limit_reached'
    );
  }
}

// type: 'text' -> { body }. type: 'template' -> { templateName, templateLanguage, templateComponents }.
async function sendChatMessage(clientId, chat, { type, body, templateName, templateLanguage, templateComponents }) {
  if (type === 'text' && !(await canSendFreeform(clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window — send a template message instead.',
      'session_window_closed'
    );
  }
  await assertWithinPlanLimit(clientId);

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);
  const toPhone = chat.phone;
  const displayBody = type === 'text' ? body : `[template: ${templateName}]`;

  const message = await chatsRepo.insertOutboundPending(clientId, chat.id, displayBody);

  try {
    const metaMessageId = type === 'text'
      ? await metaClient.sendTextMessage(waba.phone_number_id, accessToken, toPhone, body)
      : await metaClient.sendTemplateMessage(waba.phone_number_id, accessToken, toPhone, {
          name: templateName,
          language: templateLanguage,
          components: templateComponents || [],
        });
    const sent = await chatsRepo.markSent(clientId, message.id, metaMessageId);
    await usageRepo.incrementSent(clientId);
    return sent;
  } catch (err) {
    await chatsRepo.markFailed(clientId, message.id, err.message);
    throw new MessagingError(err.message, 'send_failed');
  }
}

// Re-attempts a previously failed send using its original text body. Only
// supports retrying free-form text (the common failed case — a transient
// Cloud API error); a template retry should go through sendChatMessage again
// with the template explicitly, since we don't persist which template a
// message used.
async function retryMessage(clientId, chat, message) {
  if (message.status !== 'failed') {
    throw new MessagingError('Only a failed message can be retried.', 'not_failed');
  }
  if (!(await canSendFreeform(clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window — send a template message instead.',
      'session_window_closed'
    );
  }

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);

  try {
    const metaMessageId = await metaClient.sendTextMessage(waba.phone_number_id, accessToken, chat.phone, message.body);
    return chatsRepo.markSent(clientId, message.id, metaMessageId);
  } catch (err) {
    await chatsRepo.markFailed(clientId, message.id, err.message);
    throw new MessagingError(err.message, 'send_failed');
  }
}

module.exports = { MessagingError, canSendFreeform, sendChatMessage, retryMessage, SESSION_WINDOW_MS };
