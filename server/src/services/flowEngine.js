// Multi-step, branching, stateful automation — replaces automationEngine.js
// as metaWebhook.js's entry point (see routes/metaWebhook.js). automationEngine
// itself is unchanged in shape and is still exactly what runs when there's no
// active flow for a contact, or when a rule sends free text rather than
// starting a flow — this module wraps it, rather than duplicating its
// matching logic.
//
// automationEngine.js lazily requires this module (inside its evaluate()
// function body, not at top level) to start a flow when a matched rule has
// flow_id set. That's a deliberate one-directional-at-load-time /
// circular-at-call-time require: this file requires automationEngine at the
// top (safe, automationEngine has no top-level dependency back on this
// file), and automationEngine only reaches back into this file once both
// modules have already finished loading — the standard CommonJS fix for a
// two-way dependency between "the fallback" and "the thing it falls back
// from."
//
// Concurrency: every write to contact_flow_state goes through
// contactFlowStateRepo.create (an INSERT that relies on migration 023's
// partial unique index to reject a second concurrent flow-start for the
// same contact) or .advance (a compare-and-swap UPDATE keyed on
// current_node_id + version). Nothing in this file holds a Postgres lock
// across a Meta API call — runToRest executes nodes (which may call out to
// Meta) entirely before the single CAS write that persists the result,
// exactly mirroring broadcastRunner's claim -> send -> finalize shape.
const automationEngine = require('./automationEngine');
const automationFlowsRepo = require('../repositories/automationFlowsRepo');
const flowNodesRepo = require('../repositories/flowNodesRepo');
const flowEdgesRepo = require('../repositories/flowEdgesRepo');
const contactFlowStateRepo = require('../repositories/contactFlowStateRepo');
const flowEventsRepo = require('../repositories/flowEventsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const consentRepo = require('../repositories/consentRepo');
const messagingService = require('../services/messagingService');

// Node types that don't wait for a reply — after executing, the engine
// follows the node's single 'always' edge automatically, in the same pass
// (no separate inbound event needed to continue). Anything not in this set
// (currently just send_interactive_buttons; delay joins it in Stage 4)
// pauses here and persists that as the contact's resting state.
const AUTO_ADVANCE_TYPES = new Set(['send_text', 'action']);

// Normalizes a raw Meta inbound message (plus the display body
// routes/metaWebhook.js already derived from it) into what edge-matching
// actually branches on. A button click's `text` is its title, purely for
// symmetry with the plain-text case — matching never uses it; button
// branches match buttonId, never the (editable) title.
function normalizeInboundEvent(msg, inboundBody) {
  const buttonReply = msg?.interactive?.button_reply;
  if (buttonReply) {
    return { kind: 'button_click', buttonId: buttonReply.id, buttonTitle: buttonReply.title, text: buttonReply.title };
  }
  return { kind: 'text', text: inboundBody || '' };
}

function normalizeKeyword(s) {
  return (s || '').trim().toLowerCase();
}

// Pure — no DB, no network — deliberately, so it's unit-testable the same
// way templateSyncService.reconcileTemplates is (server/test/flowEngine.test.js).
// `edges` must already be in flowEdgesRepo.listForNode's order (default
// last) — this just walks them and returns the first structural match.
// 'always'/'timeout' edges are never matched here; those apply to
// auto-advance and the (Stage 4) timeout poller respectively, not to an
// inbound reply.
function resolveInboundEdge(edges, inboundEvent) {
  for (const edge of edges) {
    if (edge.condition_type === 'button_id') {
      if (inboundEvent.kind === 'button_click' && inboundEvent.buttonId === edge.condition_value) return edge;
    } else if (edge.condition_type === 'keyword') {
      if (inboundEvent.kind === 'text' && normalizeKeyword(inboundEvent.text) === normalizeKeyword(edge.condition_value)) return edge;
    } else if (edge.condition_type === 'default') {
      return edge;
    }
  }
  return null;
}

async function executeAction(db, clientId, contact, node) {
  const { kind } = node.config || {};
  if (kind === 'assign_tag') {
    await contactsRepo.update(db, clientId, contact.id, { tag_id: node.config.tag_id });
  } else if (kind === 'set_opt_in') {
    // consentRepo manages its own transaction and is deliberately not
    // db-first (see its module comment) — always called on the privileged
    // pool here, same as every other flowEngine call (metaWebhook.js is the
    // only caller, on `pool`).
    await consentRepo.recordEvent(clientId, contact.id, {
      event: node.config.opt_in_event,
      source: 'flow',
      evidence: { flow_node_id: node.id },
    });
  } else if (kind === 'human_handoff') {
    // No dedicated handoff queue in v1 — ending automation here is enough;
    // the chat is already visible to a human agent in the normal inbox.
    // Broader visibility (e.g. a "needs attention" filter) is out of scope,
    // same as the plan's stall-visibility note limits itself to surfacing,
    // not auto-creating a support ticket.
  } else {
    throw new Error(`flowEngine: unsupported action kind "${kind}"`);
  }
}

// Sends/acts for one node. send_template and delay are valid flow_nodes.type
// values (migration 023) but have no case here yet — Stage 5 adds
// send_template, Stage 4 adds delay's due_at handling in runToRest below.
// Until then, a node of either type throws here, which runToRest catches
// and turns into a 'stalled' state — a safe failure (nothing sent, nothing
// silently skipped), not a crash, if one is ever created out of sequence.
async function executeNode(db, clientId, contact, chat, node) {
  if (node.type === 'send_text') {
    await messagingService.sendChatMessage(db, clientId, chat, { type: 'text', body: node.config.body });
  } else if (node.type === 'send_interactive_buttons') {
    await messagingService.sendChatMessage(db, clientId, chat, {
      type: 'interactive',
      body: node.config.body,
      buttons: node.config.buttons,
    });
  } else if (node.type === 'action') {
    await executeAction(db, clientId, contact, node);
  } else if (node.type === 'end') {
    // no-op — runToRest treats reaching 'end' as completion
  } else {
    throw new Error(`flowEngine: node type "${node.type}" is not yet supported by the engine`);
  }
}

// Executes nodes starting at startNodeId, following 'always' edges
// automatically for auto-advance types, until reaching a node that waits
// for a reply, a terminal 'end', a node with no outgoing edge (implicit
// end), or a failed send/action. Returns the resting state to persist —
// does NOT touch contact_flow_state itself, so the caller can distinguish
// "starting a new flow" (INSERT) from "continuing one" (CAS UPDATE) without
// this function needing to know which.
async function runToRest(db, clientId, contact, chat, flowId, startNodeId) {
  let node = await flowNodesRepo.findById(db, clientId, startNodeId);

  while (true) {
    try {
      await executeNode(db, clientId, contact, chat, node);
    } catch (err) {
      await flowEventsRepo.record(db, {
        clientId, contactId: contact.id, flowId, nodeId: node.id,
        eventType: 'stalled', detail: { error: err.message, code: err.code },
      });
      return { nodeId: node.id, status: 'stalled' };
    }

    await flowEventsRepo.record(db, {
      clientId, contactId: contact.id, flowId, nodeId: node.id,
      eventType: node.type === 'end' ? 'completed' : 'entered',
    });

    if (node.type === 'end') {
      return { nodeId: node.id, status: 'completed' };
    }
    if (!AUTO_ADVANCE_TYPES.has(node.type)) {
      // Waits for a reply (send_interactive_buttons today; delay in Stage 4
      // will also land here with a due_at instead of waiting_since).
      return { nodeId: node.id, status: 'active', waitingSince: new Date().toISOString() };
    }

    const edges = await flowEdgesRepo.listForNode(db, clientId, node.id);
    const alwaysEdge = edges.find((e) => e.condition_type === 'always');
    if (!alwaysEdge) {
      return { nodeId: node.id, status: 'completed' }; // no outgoing edge = implicit end
    }
    node = await flowNodesRepo.findById(db, clientId, alwaysEdge.to_node_id);
  }
}

// Called from automationEngine.js when a matched rule has flow_id set.
// flow.status !== 'active' is checked by the caller, not here.
async function startFlow(db, clientId, contact, chat, flow) {
  if (!flow.entry_node_id) return; // draft flow with no entry node — nothing to run

  let state;
  try {
    state = await contactFlowStateRepo.create(db, {
      clientId, contactId: contact.id, flowId: flow.id, currentNodeId: flow.entry_node_id,
    });
  } catch (err) {
    if (err.code === '23505') return; // another concurrent trigger already started a flow for this contact — first one wins
    throw err;
  }

  const rest = await runToRest(db, clientId, contact, chat, flow.id, flow.entry_node_id);
  await contactFlowStateRepo.advance(db, {
    clientId, contactId: contact.id,
    expectedNodeId: flow.entry_node_id, expectedVersion: state.version,
    ...rest,
  });
}

async function continueFlow(db, clientId, contact, chat, flowState, matchedEdge) {
  await flowEventsRepo.record(db, {
    clientId, contactId: contact.id, flowId: flowState.flow_id, nodeId: flowState.current_node_id,
    eventType: 'button_clicked',
    detail: { edgeId: matchedEdge.id, conditionType: matchedEdge.condition_type, conditionValue: matchedEdge.condition_value },
  });

  const rest = await runToRest(db, clientId, contact, chat, flowState.flow_id, matchedEdge.to_node_id);
  const updated = await contactFlowStateRepo.advance(db, {
    clientId, contactId: contact.id,
    expectedNodeId: flowState.current_node_id, expectedVersion: flowState.version,
    ...rest,
  });
  if (!updated) {
    await flowEventsRepo.record(db, {
      clientId, contactId: contact.id, flowId: flowState.flow_id, nodeId: rest.nodeId,
      eventType: 'superseded',
    });
  }
}

// Called from routes/metaWebhook.js in place of the previous direct
// automationEngine.evaluate() call. `contact` and `chat` are the rows
// metaWebhook.js already resolved for this inbound message; `msg` is the
// raw Meta message object (for interactive.button_reply); `inboundBody` is
// the display body metaWebhook.js already derived from it.
async function evaluate(db, clientId, contact, chat, msg, inboundBody) {
  const inboundEvent = normalizeInboundEvent(msg, inboundBody);
  const flowState = await contactFlowStateRepo.findActive(db, clientId, contact.id);

  if (flowState) {
    const edges = await flowEdgesRepo.listForNode(db, clientId, flowState.current_node_id);
    const matched = resolveInboundEdge(edges, inboundEvent);
    if (matched) {
      await continueFlow(db, clientId, contact, chat, flowState, matched);
      return;
    }
    // No branch recognized this input — flow state is left untouched on
    // purpose (see migration 023's module comment) rather than guessing.
    // automationEngine still runs below as a global override, so a
    // non-flow keyword rule (e.g. "agent"/"help") can interrupt a flow.
    await flowEventsRepo.record(db, {
      clientId, contactId: contact.id, flowId: flowState.flow_id, nodeId: flowState.current_node_id,
      eventType: 'unmatched_input', detail: { inboundEvent },
    });
  }

  await automationEngine.evaluate(db, clientId, chat, inboundBody, contact);
}

module.exports = { evaluate, startFlow, normalizeInboundEvent, resolveInboundEdge };
