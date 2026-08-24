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
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const messagingService = require('../services/messagingService');
const { resolveParamValues, buildTemplateComponents } = require('../utils/templateParamMapping');

// Node types that don't wait for a reply — after executing, the engine
// follows the node's single 'always' edge automatically, in the same pass
// (no separate inbound event needed to continue). send_template joins
// send_text/action here rather than waiting: this engine doesn't route on
// template QUICK_REPLY button clicks (a separate webhook shape from
// send_interactive_buttons' free-form buttons — scoped out, see the plan's
// "needs its own spike" note on template button-edge routing), so a
// send_template node has nothing to wait for. Anything not in this set
// pauses here and persists that as the contact's resting state — either
// waiting for a reply (send_interactive_buttons) or waiting for time to
// pass (delay, handled as its own case in runToRest since it always pauses
// unconditionally, never advances in the same pass).
const AUTO_ADVANCE_TYPES = new Set(['send_text', 'send_template', 'action']);

// Which flow_edges.condition_type values make sense on an edge FROM a given
// node type — the write-time half of the guarantee flowEdgesRepo's ordering
// is the runtime half of (see its module comment). A 'keyword' edge hanging
// off a 'delay' node can never evaluate (delay never sees an inbound
// event), same for 'button_id'/'default' off any auto-advance type; 'end'
// takes no edges at all since it's terminal. Used by
// routes/automationFlows.js to reject a bad edge at creation, not by the
// engine itself (runToRest/resolveInboundEdge already only ever look for
// the specific edge type that's meaningful for the node they're at).
const LEGAL_EDGE_TYPES_BY_NODE_TYPE = {
  send_interactive_buttons: new Set(['button_id', 'keyword', 'default', 'timeout']),
  delay: new Set(['always']),
  send_text: new Set(['always']),
  send_template: new Set(['always']),
  action: new Set(['always']),
  end: new Set([]),
};

function isEdgeTypeLegalForNode(nodeType, conditionType) {
  return (LEGAL_EDGE_TYPES_BY_NODE_TYPE[nodeType] || new Set()).has(conditionType);
}

// A node that pauses "is due" for one of two reasons, each following a
// different edge type — delay always fires its single unconditional edge;
// a waiting-for-reply node (send_interactive_buttons) fires its 'timeout'
// edge if the reply never came. Pure, so it's unit-testable
// (server/test/flowEngine.test.js) without needing a real due contact_flow_state row.
function dueEdgeType(nodeType) {
  return nodeType === 'delay' ? 'always' : 'timeout';
}

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

// Sends/acts for one node. send_template is a valid flow_nodes.type value
// (migration 023) but has no case here yet — Stage 5 adds it. Until then, a
// a node type this engine doesn't know about throws here, which runToRest
// catches and turns into a 'stalled' state — a safe failure (nothing sent,
// nothing silently skipped), not a crash.
async function executeNode(db, clientId, contact, chat, node) {
  if (node.type === 'send_text') {
    await messagingService.sendChatMessage(db, clientId, chat, { type: 'text', body: node.config.body });
  } else if (node.type === 'send_interactive_buttons') {
    await messagingService.sendChatMessage(db, clientId, chat, {
      type: 'interactive',
      body: node.config.body,
      buttons: node.config.buttons,
    });
  } else if (node.type === 'send_template') {
    await executeSendTemplate(db, clientId, contact, chat, node);
  } else if (node.type === 'action') {
    await executeAction(db, clientId, contact, node);
  } else if (node.type === 'delay' || node.type === 'end') {
    // no-op — delay has nothing to send, it just pauses (runToRest sets
    // due_at); 'end' is terminal, runToRest treats reaching it as completion
  } else {
    throw new Error(`flowEngine: node type "${node.type}" is not yet supported by the engine`);
  }
}

// Same param-mapping shape and resolution as broadcasts (build plan
// priority fix) — node.config.paramMappings is { [paramName]: {source,
// field, value} }, reusing utils/templateParamMapping.js rather than a
// second implementation. Unlike broadcasts, there's no dedicated
// creation-time coverage check yet (Stage 6's editor is what should enforce
// every {{param}} has a mapping before a flow can go 'active') — an
// unmapped param here just resolves to '' via resolveParamValues' own
// fallback and sends with it blank, which Meta will likely reject; that
// surfaces as a normal 'stalled' state via runToRest's catch, not a crash.
async function executeSendTemplate(db, clientId, contact, chat, node) {
  const template = await messageTemplatesRepo.findByNameAndClient(db, clientId, node.config.templateName);
  const templateComponents = template
    ? buildTemplateComponents(template, resolveParamValues(node.config.paramMappings, contact))
    : [];
  await messagingService.sendChatMessage(db, clientId, chat, {
    type: 'template',
    templateName: node.config.templateName,
    templateLanguage: node.config.templateLanguage || 'en_US',
    templateComponents,
    headerMediaAssetId: node.config.headerMediaAssetId,
  });
}

// Executes nodes starting at startNodeId, following 'always' edges
// automatically for auto-advance types, until reaching a node that waits
// for a reply, a terminal 'end', a node with no outgoing edge (implicit
// end), or a failed send/action. Returns the resting state to persist —
// does NOT touch contact_flow_state itself, so the caller can distinguish
// "starting a new flow" (INSERT) from "continuing one" (CAS UPDATE) without
// this function needing to know which.
//
// fallbackNodeId is the contact's own current_node_id at the moment this
// call started (defaults to startNodeId, correct for startFlow's brand-new
// row — see its comment on why that specific race is already prevented
// elsewhere). It exists because startNodeId — or a later node reached by
// following an 'always' edge — can legitimately not exist: only a
// contact's CURRENT node is FK-protected against deletion (migration
// 023_automation_flows.js's current_node_id has no onDelete, so Postgres
// blocks that one specific delete); a node one hop further along a chain
// has no such protection and can be deleted out from under an in-flight
// advance. flowNodesRepo.findById returns null, not a throw, for a missing
// row — without this fallback, that null would either be dereferenced
// directly (a crash) or get written into contact_flow_state.current_node_id
// (NOT NULL, so that's a second, different crash) instead of leaving the
// contact at the real node they're still safely on.
async function runToRest(db, clientId, contact, chat, flowId, startNodeId, fallbackNodeId = startNodeId) {
  let node = await flowNodesRepo.findById(db, clientId, startNodeId);
  let lastRealNodeId = fallbackNodeId;

  while (true) {
    if (!node) {
      await flowEventsRepo.record(db, {
        clientId, contactId: contact.id, flowId, nodeId: lastRealNodeId,
        eventType: 'stalled',
        detail: { error: 'The next node in this flow no longer exists — it was likely deleted while this contact was mid-flow.' },
      });
      return { nodeId: lastRealNodeId, status: 'stalled' };
    }

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
    lastRealNodeId = node.id;

    if (node.type === 'end') {
      return { nodeId: node.id, status: 'completed' };
    }
    if (node.type === 'delay') {
      // Always pauses unconditionally — never advances in this same pass,
      // unlike AUTO_ADVANCE_TYPES. flowRunner.js's tick is the only thing
      // that ever moves a contact off a delay node, once due_at arrives.
      const minutes = Number(node.config?.duration_minutes);
      const dueAt = new Date(Date.now() + (Number.isFinite(minutes) ? minutes : 0) * 60_000).toISOString();
      return { nodeId: node.id, status: 'active', dueAt };
    }
    if (!AUTO_ADVANCE_TYPES.has(node.type)) {
      // Waits for a reply (send_interactive_buttons). Also sets due_at if
      // this node defines a 'timeout' edge and a timeout_minutes config —
      // both are required together; a timeout edge with no duration (or
      // vice versa) is treated as "no timeout configured" rather than
      // guessing a default, since Stage 6's editor is what should enforce
      // they're set together at save time.
      const edges = await flowEdgesRepo.listForNode(db, clientId, node.id);
      const timeoutEdge = edges.find((e) => e.condition_type === 'timeout');
      const timeoutMinutes = Number(node.config?.timeout_minutes);
      const dueAt = timeoutEdge && Number.isFinite(timeoutMinutes)
        ? new Date(Date.now() + timeoutMinutes * 60_000).toISOString()
        : null;
      return { nodeId: node.id, status: 'active', waitingSince: new Date().toISOString(), dueAt };
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

  // fallbackNodeId = flowState.current_node_id, not the default (matchedEdge.to_node_id)
  // — if that target (or a node further along an 'always' chain from it)
  // doesn't exist, the contact must stay reported at the real node they're
  // still on, never at the nonexistent one (see runToRest's comment).
  const rest = await runToRest(db, clientId, contact, chat, flowState.flow_id, matchedEdge.to_node_id, flowState.current_node_id);
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

// Called from flowRunner.js's tick for a contact_flow_state row it has
// already atomically claimed into 'processing' (see contactFlowStateRepo's
// claimDueBatch) — the row being due means the contact's CURRENT node has
// timed out (delay's unconditional wait elapsed, or a
// send_interactive_buttons reply never arrived). dueEdgeType picks which
// edge type means "time's up" for this node; runToRest then executes
// forward from there exactly like a webhook-driven advance would. Returns
// the resting state for flowRunner to finalize via
// contactFlowStateRepo.finalizeProcessing — this function never writes to
// contact_flow_state itself, same separation runToRest's own callers use.
async function advanceDueNode(db, clientId, contact, chat, flowState) {
  const node = await flowNodesRepo.findById(db, clientId, flowState.current_node_id);
  const edges = await flowEdgesRepo.listForNode(db, clientId, node.id);
  const edge = edges.find((e) => e.condition_type === dueEdgeType(node.type));

  if (!edge) {
    // No edge to advance along — shouldn't happen given Stage 6's
    // write-time validation (a delay node always needs an 'always' edge; a
    // node with a timeout_minutes config always needs a 'timeout' edge),
    // but this row was already claimed into 'processing' and must be
    // resolved one way or another, not left to be reclaimed forever.
    await flowEventsRepo.record(db, {
      clientId, contactId: contact.id, flowId: flowState.flow_id, nodeId: node.id,
      eventType: 'stalled', detail: { error: `no ${dueEdgeType(node.type)} edge configured on this node` },
    });
    return { nodeId: node.id, status: 'stalled' };
  }

  await flowEventsRepo.record(db, {
    clientId, contactId: contact.id, flowId: flowState.flow_id, nodeId: node.id,
    eventType: 'timed_out', detail: { edgeId: edge.id, conditionType: edge.condition_type },
  });
  // fallbackNodeId = flowState.current_node_id — same reasoning as
  // continueFlow's call: if edge.to_node_id (or a node further along an
  // 'always' chain from it) doesn't exist, stay reported at the real node.
  return runToRest(db, clientId, contact, chat, flowState.flow_id, edge.to_node_id, flowState.current_node_id);
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

module.exports = {
  evaluate, startFlow, advanceDueNode,
  normalizeInboundEvent, resolveInboundEdge, dueEdgeType, isEdgeTypeLegalForNode,
};
