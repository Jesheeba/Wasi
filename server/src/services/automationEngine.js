// Kwick-parity automation: plain keyword-trigger rules, no AI/LLM involved
// (matches app.js's existing automation_rules UI - title/trigger/action -
// this is what actually makes those rules do something). Called by
// flowEngine.js (routes/metaWebhook.js's actual entry point as of the flow
// engine build) whenever there's no active flow for a contact, or a matched
// rule sends free text rather than starting one.
const automationRulesRepo = require('../repositories/automationRulesRepo');
const automationFlowsRepo = require('../repositories/automationFlowsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const messagingService = require('../services/messagingService');

// Only ever called from flowEngine.js, with the privileged `pool` as `db`
// (see repositories/tagsRepo.js's module comment for the convention).
// `contact` is required only for a flow-starting rule (flow_id set) - every
// current caller already has it resolved, so it's not optional.
//
// Returns { handled, how } (see flowEngine.js's outcome table). A rule that
// matched claims the message even when its action then throws: the exception
// is still swallowed here (a bad rule must never block ingestion), but it is
// reported as handled:true with a `_failed` how, so the AI agent stays silent
// instead of answering over a rule that did match, and the gate log can tell
// a rule that worked from one that did not.
//
// Matching: a keyword matches as a whole word or phrase, case-insensitive
// ("hi" matches "Hi there", not "this"). Trigger "*" matches any message but
// only after every keyword rule has had its turn, never while the contact is
// inside an active flow (allowWildcard false), and at most once per chat per
// 24h (chatsRepo.claimAutoReply).
const WILDCARD = '*';
const isWildcard = (rule) => (rule.trigger || '').trim() === WILDCARD;

// Letters, combining marks (Tamil vowel signs are \p{M}) and digits form a
// word; anything else is a boundary. Inner whitespace matches any run of it.
function matchesTrigger(trigger, text) {
  const needle = (trigger || '').trim();
  if (!needle || needle === WILDCARD) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(text || '');
}

async function evaluate(db, clientId, chat, inboundBody, contact, { allowWildcard = true } = {}) {
  const rules = await automationRulesRepo.list(db, clientId);
  const enabled = rules.filter((r) => r.status === 'Enabled');
  const rule = enabled.find((r) => !isWildcard(r) && matchesTrigger(r.trigger, inboundBody))
    || (allowWildcard && chat?.id ? enabled.find(isWildcard) : undefined);
  if (!rule) return { handled: false, how: null };

  const wildcard = isWildcard(rule);
  if (wildcard && !(await chatsRepo.claimAutoReply(db, clientId, chat.id))) {
    return { handled: false, how: null }; // already auto-replied in this chat within 24h
  }
  const release = () => (wildcard ? chatsRepo.releaseAutoReply(db, clientId, chat.id).catch(() => {}) : null);

  // First match wins: one auto-reply per message at most.
  try {
    if (rule.flow_id) {
      // Lazy require: flowEngine.js requires this module at its own top
      // level (to fall back to it), so requiring flowEngine back at OUR
      // top level would be a circular require resolved at load time -
      // requiring it here, inside the function body, defers resolution
      // until both modules have already finished loading, which is safe.
      const flowEngine = require('./flowEngine');
      const flow = await automationFlowsRepo.findById(db, clientId, rule.flow_id);
      if (flow && flow.status === 'active') {
        const started = await flowEngine.startFlow(db, clientId, contact, chat, flow);
        // 'already_active' means a concurrent trigger's flow already owns
        // this contact's conversation: still a flow handling it. A draft
        // flow with no entry node ran nothing, so nothing engaged.
        if (started && (started.started || started.reason === 'already_active')) {
          return { handled: true, how: 'rule_started_flow' };
        }
      }
      // Rule matched but there was no active flow to run (missing,
      // inactive or empty): nothing was done for the customer.
      await release();
      return { handled: false, how: null };
    }
    // The reply is itself a free-form text send - always legal here
    // since we're running this right after the inbound message that
    // just reopened the 24h window.
    await messagingService.sendChatMessage(db, clientId, chat, { type: 'text', body: rule.action });
    return { handled: true, how: 'rule_text_reply' };
  } catch (err) {
    // Don't let one bad rule (e.g. WABA disconnected mid-flight) block
    // ingestion of the message that triggered it - already committed.
    console.error(`automation rule "${rule.title}" failed for chat ${chat.id}:`, err.message);
    await release();
    return { handled: true, how: rule.flow_id ? 'rule_flow_start_failed' : 'rule_text_reply_failed' };
  }
}

module.exports = { evaluate, matchesTrigger };
