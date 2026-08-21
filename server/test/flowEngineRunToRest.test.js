// Regression tests for the crash a live investigation found: a node one hop
// ahead of a contact's current position (not FK-protected the way the
// contact's CURRENT node is — see flowEngine.js's runToRest comment) can be
// deleted out from under an in-flight advance. flowNodesRepo.findById
// returns null, not a throw, for a missing row — before this fix, that null
// was dereferenced directly (a crash) with no clean 'stalled' outcome and
// no flow_events audit row. Stubs the repos/messagingService flowEngine
// requires (Node caches each require() to the same object, so overwriting
// a method on it here affects flowEngine's own calls) rather than a real DB
// — same reasoning server/test/flowValidation.test.js gives for its fake db.
const test = require('node:test');
const assert = require('node:assert/strict');
const flowEngine = require('../src/services/flowEngine');
const flowNodesRepo = require('../src/repositories/flowNodesRepo');
const flowEventsRepo = require('../src/repositories/flowEventsRepo');
const flowEdgesRepo = require('../src/repositories/flowEdgesRepo');
const messagingService = require('../src/services/messagingService');

// runToRest isn't exported (only evaluate/startFlow/advanceDueNode are) —
// call it through startFlow, the thinnest wrapper around it, with
// contactFlowStateRepo also stubbed so no real DB write is attempted.
const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  return () => { obj[name] = original; };
}

test('runToRest (via startFlow): entry node deleted before execution — stalls cleanly, does not throw', async () => {
  const restores = [
    stub(flowNodesRepo, 'findById', async () => null), // the deleted node
    stub(flowEventsRepo, 'record', async () => {}),
    stub(contactFlowStateRepo, 'create', async () => ({ version: 0 })),
  ];
  let advanceCall = null;
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'x' }; }));

  try {
    const flow = { id: 'flow-1', entry_node_id: 'node-missing' };
    await assert.doesNotReject(() => flowEngine.startFlow({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, flow));
    assert.equal(advanceCall.status, 'stalled');
    // Falls back to the entry node's own id (the only "known position" a
    // brand-new contact_flow_state row has) — never null, which would
    // violate contact_flow_state.current_node_id's NOT NULL constraint.
    assert.equal(advanceCall.nodeId, 'node-missing');
  } finally {
    restores.forEach((r) => r());
  }
});

test('runToRest (via continueFlow, through evaluate): target of a matched edge deleted before execution — contact stays at their real current node, stalled', async () => {
  const CURRENT_NODE_ID = 'node-current-real';
  const restores = [
    stub(flowNodesRepo, 'findById', async (db, clientId, id) => (id === CURRENT_NODE_ID ? { id: CURRENT_NODE_ID, type: 'send_text' } : null)),
    stub(flowEdgesRepo, 'listForNode', async () => [{ id: 'edge-1', condition_type: 'keyword', condition_value: 'hi', to_node_id: 'node-missing' }]),
    stub(flowEventsRepo, 'record', async () => {}),
  ];
  const flowState = { flow_id: 'flow-1', current_node_id: CURRENT_NODE_ID, version: 3 };
  restores.push(stub(contactFlowStateRepo, 'findActive', async () => flowState));
  let advanceCall = null;
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'x' }; }));
  const automationEngine = require('../src/services/automationEngine');
  restores.push(stub(automationEngine, 'evaluate', async () => {}));

  try {
    const contact = { id: 'contact-1' };
    await assert.doesNotReject(() =>
      flowEngine.evaluate({}, 'client-1', contact, { id: 'chat-1' }, {}, 'hi')
    );
    assert.ok(advanceCall, 'contactFlowStateRepo.advance should have been called (a matched edge was found)');
    assert.equal(advanceCall.status, 'stalled');
    // Must be the contact's real, still-existing current node — never
    // 'node-missing' (the edge's target), which would violate the NOT NULL
    // FK on current_node_id, and never null/undefined (a crash).
    assert.equal(advanceCall.nodeId, CURRENT_NODE_ID);
  } finally {
    restores.forEach((r) => r());
  }
});

test('runToRest (via startFlow): a REAL node executes, then the next node in an always-chain is deleted — reports the last real node, not the missing one', async () => {
  const FIRST_NODE_ID = 'node-first-real';
  const restores = [
    stub(flowNodesRepo, 'findById', async (db, clientId, id) => (id === FIRST_NODE_ID ? { id: FIRST_NODE_ID, type: 'send_text', config: { body: 'hi' } } : null)),
    stub(flowEdgesRepo, 'listForNode', async () => [{ id: 'edge-1', condition_type: 'always', to_node_id: 'node-missing-2' }]),
    stub(flowEventsRepo, 'record', async () => {}),
    stub(messagingService, 'sendChatMessage', async () => ({ id: 'msg-1' })),
    stub(contactFlowStateRepo, 'create', async () => ({ version: 0 })),
  ];
  let advanceCall = null;
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'x' }; }));

  try {
    const flow = { id: 'flow-1', entry_node_id: FIRST_NODE_ID };
    await assert.doesNotReject(() => flowEngine.startFlow({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, flow));
    assert.equal(advanceCall.status, 'stalled');
    assert.equal(advanceCall.nodeId, FIRST_NODE_ID, 'should report the last node that actually executed, not the deleted one it tried to advance into');
  } finally {
    restores.forEach((r) => r());
  }
});
