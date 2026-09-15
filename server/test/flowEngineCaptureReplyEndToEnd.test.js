// End-to-end capture_reply runtime path through flowEngine.evaluate() —
// same "stub every repo/service flowEngine requires" pattern
// flowEngineRunToRest.test.js already established (no real DB, no real
// Meta send; Node caches each require() to the same object, so overwriting
// a method on it here affects flowEngine's own calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const flowEngine = require('../src/services/flowEngine');
const flowNodesRepo = require('../src/repositories/flowNodesRepo');
const flowEdgesRepo = require('../src/repositories/flowEdgesRepo');
const flowEventsRepo = require('../src/repositories/flowEventsRepo');
const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');
const contactAttributesRepo = require('../src/repositories/contactAttributesRepo');
const contactAttributeValuesRepo = require('../src/repositories/contactAttributeValuesRepo');
const messagingService = require('../src/services/messagingService');
const automationEngine = require('../src/services/automationEngine');

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  return () => { obj[name] = original; };
}

const CAPTURE_NODE_ID = 'node-capture';
const END_NODE_ID = 'node-end';
const ATTRIBUTE_ID = 'attr-full-name';

test('evaluate: a reply to a waiting capture_reply node is stored and the flow advances via its always edge', async () => {
  const flowState = { flow_id: 'flow-1', current_node_id: CAPTURE_NODE_ID, version: 2 };
  const events = [];
  const upserts = [];

  const restores = [
    stub(contactFlowStateRepo, 'findActive', async () => flowState),
    stub(flowNodesRepo, 'findById', async (db, clientId, id) => {
      if (id === CAPTURE_NODE_ID) return { id: CAPTURE_NODE_ID, type: 'capture_reply', config: { body: 'What is your name?', attribute_id: ATTRIBUTE_ID } };
      if (id === END_NODE_ID) return { id: END_NODE_ID, type: 'end', config: {} };
      return null;
    }),
    stub(flowEdgesRepo, 'listForNode', async (db, clientId, nodeId) =>
      nodeId === CAPTURE_NODE_ID ? [{ id: 'edge-always', condition_type: 'always', to_node_id: END_NODE_ID }] : []
    ),
    stub(flowEventsRepo, 'record', async (db, args) => { events.push(args); }),
    stub(contactAttributesRepo, 'findById', async () => ({ id: ATTRIBUTE_ID, name: 'full_name', type: 'text' })),
    stub(contactAttributeValuesRepo, 'upsert', async (db, clientId, contactId, attributeId, value) => {
      upserts.push({ contactId, attributeId, value });
      return { attributeId, value };
    }),
  ];
  let advanceCall = null;
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'row-1' }; }));
  restores.push(stub(automationEngine, 'evaluate', async () => { throw new Error('should not fall through to automationEngine — the capture_reply branch always has an always edge here'); }));

  try {
    await assert.doesNotReject(() =>
      flowEngine.evaluate({}, 'client-1', { id: 'contact-1', name: 'Priya' }, { id: 'chat-1' }, {}, 'Priya Sharma')
    );

    assert.deepEqual(upserts, [{ contactId: 'contact-1', attributeId: ATTRIBUTE_ID, value: 'Priya Sharma' }]);

    const captureEvent = events.find((e) => e.eventType === 'reply_captured');
    assert.ok(captureEvent, 'a reply_captured flow_event should be recorded');
    assert.equal(captureEvent.nodeId, CAPTURE_NODE_ID);
    assert.equal(captureEvent.detail.capture.captured, true);

    assert.ok(advanceCall, 'contactFlowStateRepo.advance should have been called');
    assert.equal(advanceCall.status, 'completed');
    assert.equal(advanceCall.nodeId, END_NODE_ID);
  } finally {
    restores.forEach((r) => r());
  }
});

test('evaluate: a reply that fails the attribute\'s type validation still advances the flow — the value is just skipped', async () => {
  const flowState = { flow_id: 'flow-1', current_node_id: CAPTURE_NODE_ID, version: 2 };
  const events = [];
  const upserts = [];

  const restores = [
    stub(contactFlowStateRepo, 'findActive', async () => flowState),
    stub(flowNodesRepo, 'findById', async (db, clientId, id) => {
      if (id === CAPTURE_NODE_ID) return { id: CAPTURE_NODE_ID, type: 'capture_reply', config: { body: 'How old are you?', attribute_id: ATTRIBUTE_ID } };
      if (id === END_NODE_ID) return { id: END_NODE_ID, type: 'end', config: {} };
      return null;
    }),
    stub(flowEdgesRepo, 'listForNode', async (db, clientId, nodeId) =>
      nodeId === CAPTURE_NODE_ID ? [{ id: 'edge-always', condition_type: 'always', to_node_id: END_NODE_ID }] : []
    ),
    stub(flowEventsRepo, 'record', async (db, args) => { events.push(args); }),
    stub(contactAttributesRepo, 'findById', async () => ({ id: ATTRIBUTE_ID, name: 'age', type: 'number' })),
    stub(contactAttributeValuesRepo, 'upsert', async (db, clientId, contactId, attributeId, value) => {
      upserts.push({ contactId, attributeId, value });
      return { attributeId, value };
    }),
  ];
  let advanceCall = null;
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'row-1' }; }));

  try {
    await flowEngine.evaluate({}, 'client-1', { id: 'contact-1', name: 'Priya' }, { id: 'chat-1' }, {}, 'twenty five');

    assert.equal(upserts.length, 0, 'a value that fails type validation must not be written');
    const captureEvent = events.find((e) => e.eventType === 'reply_captured');
    assert.equal(captureEvent.detail.capture.captured, false);
    assert.equal(captureEvent.detail.capture.reason, 'value_does_not_match_attribute_type');
    // The flow still advances — a bad-format answer shouldn't trap the contact.
    assert.equal(advanceCall.status, 'completed');
    assert.equal(advanceCall.nodeId, END_NODE_ID);
  } finally {
    restores.forEach((r) => r());
  }
});

test('evaluate: a capture_reply node with no always edge falls through to unmatched_input, same as any other no-match case', async () => {
  const flowState = { flow_id: 'flow-1', current_node_id: CAPTURE_NODE_ID, version: 2 };
  const events = [];

  const restores = [
    stub(contactFlowStateRepo, 'findActive', async () => flowState),
    stub(flowNodesRepo, 'findById', async () => ({ id: CAPTURE_NODE_ID, type: 'capture_reply', config: { body: 'Name?', attribute_id: ATTRIBUTE_ID } })),
    stub(flowEdgesRepo, 'listForNode', async () => []), // mis-authored: no always edge
    stub(flowEventsRepo, 'record', async (db, args) => { events.push(args); }),
  ];
  let automationEngineCalled = false;
  restores.push(stub(automationEngine, 'evaluate', async () => { automationEngineCalled = true; }));

  try {
    await flowEngine.evaluate({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, {}, 'Priya');
    const unmatched = events.find((e) => e.eventType === 'unmatched_input');
    assert.ok(unmatched, 'should record unmatched_input, not silently do nothing');
    assert.ok(automationEngineCalled, 'should still fall through to automationEngine as the global override');
  } finally {
    restores.forEach((r) => r());
  }
});

// Sanity check that this file's stubbing didn't leak into other node types'
// existing behavior — a plain send_interactive_buttons wait still goes
// through resolveInboundEdge's button/keyword/default matching, untouched.
test('evaluate: a non-capture_reply waiting node is unaffected by the capture_reply branch', async () => {
  const BUTTONS_NODE_ID = 'node-buttons';
  const flowState = { flow_id: 'flow-1', current_node_id: BUTTONS_NODE_ID, version: 1 };
  let continueFlowNodeId = null;

  const restores = [
    stub(contactFlowStateRepo, 'findActive', async () => flowState),
    stub(flowNodesRepo, 'findById', async (db, clientId, id) => {
      if (id === BUTTONS_NODE_ID) return { id: BUTTONS_NODE_ID, type: 'send_interactive_buttons', config: {} };
      if (id === END_NODE_ID) return { id: END_NODE_ID, type: 'end', config: {} };
      return null;
    }),
    stub(flowEdgesRepo, 'listForNode', async () => [{ id: 'edge-default', condition_type: 'default', to_node_id: END_NODE_ID }]),
    stub(flowEventsRepo, 'record', async () => {}),
  ];
  restores.push(stub(contactFlowStateRepo, 'advance', async (db, args) => { continueFlowNodeId = args.nodeId; return { id: 'row-1' }; }));

  try {
    await flowEngine.evaluate({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, {}, 'anything at all');
    assert.equal(continueFlowNodeId, END_NODE_ID, 'the default edge should still route normally');
  } finally {
    restores.forEach((r) => r());
  }
});
