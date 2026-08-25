// Kwick-parity automation: plain keyword-trigger rules, no AI/LLM involved
// (matches app.js's existing automation_rules UI — title/trigger/action —
// this is what actually makes those rules do something). Called by
// flowEngine.js (routes/metaWebhook.js's actual entry point as of the flow
// engine build) whenever there's no active flow for a contact, or a matched
// rule sends free text rather than starting one.
const automationRulesRepo = require('../repositories/automationRulesRepo');
const automationFlowsRepo = require('../repositories/automationFlowsRepo');
const messagingService = require('../services/messagingService');
const logger = require('../utils/logger');

// Only ever called from flowEngine.js, with the privileged `pool` as `db`
// (see repositories/tagsRepo.js's module comment for the convention).
// `contact` is required only for a flow-starting rule (flow_id set) — every
// current caller already has it resolved, so it's not optional.
async function evaluate(db, clientId, chat, inboundBody, contact) {
  const rules = await automationRulesRepo.list(db, clientId);
  const enabled = rules.filter((r) => r.status === 'Enabled');
  const haystack = (inboundBody || '').toLowerCase();

  for (const rule of enabled) {
    const needle = (rule.trigger || '').toLowerCase().trim();
    if (!needle || !haystack.includes(needle)) continue;

    try {
      if (rule.flow_id) {
        // Lazy require: flowEngine.js requires this module at its own top
        // level (to fall back to it), so requiring flowEngine back at OUR
        // top level would be a circular require resolved at load time —
        // requiring it here, inside the function body, defers resolution
        // until both modules have already finished loading, which is safe.
        const flowEngine = require('./flowEngine');
        const flow = await automationFlowsRepo.findById(db, clientId, rule.flow_id);
        if (flow && flow.status === 'active') {
          await flowEngine.startFlow(db, clientId, contact, chat, flow);
        }
      } else {
        // The reply is itself a free-form text send — always legal here
        // since we're running this right after the inbound message that
        // just reopened the 24h window.
        await messagingService.sendChatMessage(db, clientId, chat, { type: 'text', body: rule.action });
      }
    } catch (err) {
      // Don't let one bad rule (e.g. WABA disconnected mid-flight) block
      // ingestion of the message that triggered it — already committed.
      logger.error({ err, ruleTitle: rule.title, chatId: chat.id }, 'automation rule failed');
    }
    break; // first match wins — avoids firing multiple auto-replies for one message
  }
}

module.exports = { evaluate };
