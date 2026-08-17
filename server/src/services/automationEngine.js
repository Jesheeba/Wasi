// Kwick-parity automation: plain keyword-trigger rules, no AI/LLM involved
// (matches app.js's existing automation_rules UI — title/trigger/action —
// this is what actually makes those rules do something). Runs after every
// inbound message is committed (server/src/routes/metaWebhook.js).
const automationRulesRepo = require('../repositories/automationRulesRepo');
const messagingService = require('../services/messagingService');

async function evaluate(clientId, chat, inboundBody) {
  const rules = await automationRulesRepo.list(clientId);
  const enabled = rules.filter((r) => r.status === 'Enabled');
  const haystack = (inboundBody || '').toLowerCase();

  for (const rule of enabled) {
    const needle = (rule.trigger || '').toLowerCase().trim();
    if (!needle || !haystack.includes(needle)) continue;

    try {
      // The reply is itself a free-form text send — always legal here since
      // we're running this right after the inbound message that just
      // reopened the 24h window.
      await messagingService.sendChatMessage(clientId, chat, { type: 'text', body: rule.action });
    } catch (err) {
      // Don't let one bad rule (e.g. WABA disconnected mid-flight) block
      // ingestion of the message that triggered it — already committed.
      console.error(`automation rule "${rule.title}" failed for chat ${chat.id}:`, err.message);
    }
    break; // first match wins — avoids firing multiple auto-replies for one message
  }
}

module.exports = { evaluate };
