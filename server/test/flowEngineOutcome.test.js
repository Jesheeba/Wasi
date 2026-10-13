// Unit 0.3 (docs/ai-agent/IMPLEMENTATION.md): flowEngine.evaluate and
// automationEngine.evaluate return { handled, how }.
//
// Stubs only, same pattern as flowEngineCaptureReplyEndToEnd.test.js: every
// repo/service the engines require is replaced on its singleton module object
// and restored after each test; no database, no Meta call. These tests prove
// the OUTCOME contract at every return path of docs/ai-agent/SPEC.md section
// 7 (gate 5), and that the existing behaviour (side effects) is unchanged:
// each branch's pre-existing assertions live in the other flowEngine*.test.js
// files, which are run alongside this one.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const flowEngine = require('../src/services/flowEngine');
const automationEngine = require('../src/services/automationEngine');
const flowNodesRepo = require('../src/repositories/flowNodesRepo');
const flowEdgesRepo = require('../src/repositories/flowEdgesRepo');
const flowEventsRepo = require('../src/repositories/flowEventsRepo');
const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');
const contactAttributesRepo = require('../src/repositories/contactAttributesRepo');
const contactAttributeValuesRepo = require('../src/repositories/contactAttributeValuesRepo');
const automationRulesRepo = require('../src/repositories/automationRulesRepo');
const automationFlowsRepo = require('../src/repositories/automationFlowsRepo');
const messagingService = require('../src/services/messagingService');

const restores = [];
function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  restores.push(() => { obj[name] = original; });
}
afterEach(() => { while (restores.length) restores.pop()(); });

const CONTACT = { id: 'contact-1', name: 'Priya' };
const CHAT = { id: 'chat-1' };
const BUTTONS_NODE = 'node-buttons';
const CAPTURE_NODE = 'node-capture';
const END_NODE = 'node-end';

function evaluate(body = 'hello', msg = {}) {
  return flowEngine.evaluate({}, 'client-1', CONTACT, CHAT, msg, body);
}

// An active flow sitting on `nodeId`, with the given outgoing edges.
function activeFlow(nodeId, nodeType, edges, config = {}) {
  stub(contactFlowStateRepo, 'findActive', async () => ({ flow_id: 'flow-1', current_node_id: nodeId, version: 1 }));
  stub(flowNodesRepo, 'findById', async (db, clientId, id) => {
    if (id === nodeId) return { id: nodeId, type: nodeType, config };
    if (id === END_NODE) return { id: END_NODE, type: 'end', config: {} };
    return null;
  });
  stub(flowEdgesRepo, 'listForNode', async (db, clientId, id) => (id === nodeId ? edges : []));
  stub(flowEventsRepo, 'record', async () => {});
  stub(contactFlowStateRepo, 'advance', async () => ({ id: 'row-1' }));
}
function noActiveFlow() {
  stub(contactFlowStateRepo, 'findActive', async () => null);
}
function rules(list) {
  stub(automationRulesRepo, 'list', async () => list);
}

// ---------------------------------------------------------------- flowEngine

test('O1: an active flow\'s current node matched the message -> { handled: true, how: "flow_continued" }', async () => {
  activeFlow(BUTTONS_NODE, 'send_interactive_buttons', [{ id: 'e1', condition_type: 'default', to_node_id: END_NODE }]);
  stub(automationEngine, 'evaluate', async () => { throw new Error('rules must not run when the flow matched'); });
  assert.deepEqual(await evaluate('anything'), { handled: true, how: 'flow_continued' });
});

test('O2: an active capture_reply node took the message -> { handled: true, how: "flow_capture_reply" }', async () => {
  activeFlow(CAPTURE_NODE, 'capture_reply',
    [{ id: 'e-always', condition_type: 'always', to_node_id: END_NODE }],
    { body: 'Name?', attribute_id: 'attr-1' });
  stub(contactAttributesRepo, 'findById', async () => ({ id: 'attr-1', name: 'full_name', type: 'text' }));
  stub(contactAttributeValuesRepo, 'upsert', async () => ({}));
  stub(automationEngine, 'evaluate', async () => { throw new Error('rules must not run on a captured reply'); });
  assert.deepEqual(await evaluate('Priya Sharma'), { handled: true, how: 'flow_capture_reply' });
});

test('O3: no flow, a keyword rule starts an ACTIVE flow -> { handled: true, how: "rule_started_flow" }', async () => {
  noActiveFlow();
  rules([{ title: 'fees', trigger: 'fees', status: 'Enabled', flow_id: 'flow-9' }]);
  stub(automationFlowsRepo, 'findById', async () => ({ id: 'flow-9', status: 'active', entry_node_id: 'n1' }));
  stub(flowEngine, 'startFlow', async () => ({ started: true }));
  assert.deepEqual(await evaluate('what are the fees'), { handled: true, how: 'rule_started_flow' });
});

test('O4: a concurrent trigger already started a flow (23505) still counts as a flow owning the conversation', async () => {
  noActiveFlow();
  rules([{ title: 'fees', trigger: 'fees', status: 'Enabled', flow_id: 'flow-9' }]);
  stub(automationFlowsRepo, 'findById', async () => ({ id: 'flow-9', status: 'active', entry_node_id: 'n1' }));
  stub(flowEngine, 'startFlow', async () => ({ started: false, reason: 'already_active' }));
  assert.deepEqual(await evaluate('fees'), { handled: true, how: 'rule_started_flow' });
});

test('O5: no flow, a keyword rule sends its free-text action -> { handled: true, how: "rule_text_reply" }', async () => {
  noActiveFlow();
  rules([{ title: 'hours', trigger: 'hours', status: 'Enabled', action: 'We are open 9 to 6.' }]);
  const sent = [];
  stub(messagingService, 'sendChatMessage', async (db, clientId, chat, payload) => { sent.push(payload); return {}; });
  assert.deepEqual(await evaluate('your hours?'), { handled: true, how: 'rule_text_reply' });
  assert.deepEqual(sent, [{ type: 'text', body: 'We are open 9 to 6.' }], 'the existing send is unchanged');
});

test('O6: a matched rule whose SEND throws still claims the message: handled true, how "rule_text_reply_failed", and it does not throw', async () => {
  noActiveFlow();
  rules([{ title: 'hours', trigger: 'hours', status: 'Enabled', action: 'We are open.' }]);
  stub(messagingService, 'sendChatMessage', async () => { throw new Error('WABA disconnected mid-flight'); });
  const errors = [];
  stub(console, 'error', (...args) => errors.push(args.join(' ')));
  let outcome;
  await assert.doesNotReject(async () => { outcome = await evaluate('hours'); });
  assert.deepEqual(outcome, { handled: true, how: 'rule_text_reply_failed' });
  assert.ok(errors.some((e) => e.includes('automation rule "hours" failed')), 'the swallowed error is still logged exactly as before');
  assert.equal(flowEngine.agentMayAnswer(outcome), false, 'the agent must not answer over a rule that matched');
});

test('O7: a matched rule whose FLOW START throws -> handled true, how "rule_flow_start_failed"', async () => {
  noActiveFlow();
  rules([{ title: 'fees', trigger: 'fees', status: 'Enabled', flow_id: 'flow-9' }]);
  stub(automationFlowsRepo, 'findById', async () => ({ id: 'flow-9', status: 'active', entry_node_id: 'n1' }));
  stub(flowEngine, 'startFlow', async () => { throw new Error('db down'); });
  stub(console, 'error', () => {});
  assert.deepEqual(await evaluate('fees'), { handled: true, how: 'rule_flow_start_failed' });
});

test('O8: an active flow recognised nothing and no rule matched -> { handled: false, how: "unmatched_input" }, and the agent must stay silent', async () => {
  activeFlow(BUTTONS_NODE, 'send_interactive_buttons', [{ id: 'e1', condition_type: 'button_id', condition_value: 'yes', to_node_id: END_NODE }]);
  rules([]);
  const outcome = await evaluate('banana');
  assert.deepEqual(outcome, { handled: false, how: 'unmatched_input' });
  assert.equal(flowEngine.agentMayAnswer(outcome), false, 'SPEC decision 15');
});

test('O9: an unmatched message in an active flow that a global keyword rule DOES match returns the rule\'s outcome', async () => {
  activeFlow(BUTTONS_NODE, 'send_interactive_buttons', [{ id: 'e1', condition_type: 'button_id', condition_value: 'yes', to_node_id: END_NODE }]);
  rules([{ title: 'agent', trigger: 'agent', status: 'Enabled', action: 'Connecting you.' }]);
  stub(messagingService, 'sendChatMessage', async () => ({}));
  assert.deepEqual(await evaluate('i want an agent'), { handled: true, how: 'rule_text_reply' });
});

test('O10: nothing engaged (no flow, no matching rule) -> { handled: false, how: null }, the ONLY outcome the agent may answer', async () => {
  noActiveFlow();
  rules([{ title: 'fees', trigger: 'fees', status: 'Enabled', action: 'x' }, { title: 'off', trigger: 'hello', status: 'Disabled', action: 'y' }]);
  const outcome = await evaluate('hello there');
  assert.deepEqual(outcome, { handled: false, how: null });
  assert.equal(flowEngine.agentMayAnswer(outcome), true);
});

test('O11: a rule matched but its flow is inactive, or has no entry node: nothing was done, so nothing engaged', async () => {
  noActiveFlow();
  rules([{ title: 'fees', trigger: 'fees', status: 'Enabled', flow_id: 'flow-9' }]);
  stub(automationFlowsRepo, 'findById', async () => ({ id: 'flow-9', status: 'draft', entry_node_id: null }));
  assert.deepEqual(await evaluate('fees'), { handled: false, how: null }, 'inactive flow');

  stub(automationFlowsRepo, 'findById', async () => ({ id: 'flow-9', status: 'active', entry_node_id: null }));
  stub(flowEngine, 'startFlow', async () => ({ started: false, reason: 'no_entry_node' }));
  assert.deepEqual(await evaluate('fees'), { handled: false, how: null }, 'active but empty flow');
});

// ---------------------------------------------------------- startFlow return

test('startFlow returns { started: false, reason } for a draft flow and for a concurrent-trigger race, { started: true } otherwise', async () => {
  assert.deepEqual(await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'f', entry_node_id: null }),
    { started: false, reason: 'no_entry_node' });

  stub(contactFlowStateRepo, 'create', async () => { const e = new Error('dup'); e.code = '23505'; throw e; });
  assert.deepEqual(await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'f', entry_node_id: 'n1' }),
    { started: false, reason: 'already_active' });

  stub(contactFlowStateRepo, 'create', async () => ({ version: 1 }));
  stub(flowNodesRepo, 'findById', async () => ({ id: 'n1', type: 'end', config: {} }));
  stub(flowEdgesRepo, 'listForNode', async () => []);
  stub(flowEventsRepo, 'record', async () => {});
  stub(contactFlowStateRepo, 'advance', async () => ({}));
  assert.deepEqual(await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'f', entry_node_id: 'n1' }), { started: true });

  stub(contactFlowStateRepo, 'create', async () => { throw new Error('connection reset'); });
  await assert.rejects(() => flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'f', entry_node_id: 'n1' }), /connection reset/,
    'a real failure still throws, exactly as before');
});

// ------------------------------------------------------------ evaluateSafely

test('evaluateSafely: an exception is { handled: false, how: "flow_error", error } and the agent may not answer', async () => {
  stub(flowEngine, 'evaluate', async () => { throw new Error('flow table unavailable'); });
  const outcome = await flowEngine.evaluateSafely({}, 'client-1', CONTACT, CHAT, {}, 'hi');
  assert.deepEqual(outcome, { handled: false, how: 'flow_error', error: 'flow table unavailable' });
  assert.equal(flowEngine.agentMayAnswer(outcome), false);
});

test('evaluateSafely: an unrecognisable return value fails toward silence, never toward "nothing engaged"', async () => {
  for (const bad of [undefined, null, 'ok', {}, { how: null }, { handled: 'yes' }]) {
    stub(flowEngine, 'evaluate', async () => bad);
    const outcome = await flowEngine.evaluateSafely({}, 'client-1', CONTACT, CHAT, {}, 'hi');
    assert.equal(outcome.how, 'flow_error', `value ${JSON.stringify(bad)}`);
    assert.equal(flowEngine.agentMayAnswer(outcome), false);
  }
});

test('evaluateSafely: passes a real outcome straight through, and calls through module.exports so a replaced evaluate is honoured', async () => {
  stub(flowEngine, 'evaluate', async () => ({ handled: true, how: 'flow_continued' }));
  assert.deepEqual(await flowEngine.evaluateSafely({}, 'client-1', CONTACT, CHAT, {}, 'hi'), { handled: true, how: 'flow_continued' });
  stub(flowEngine, 'evaluate', async () => ({ handled: false, how: null }));
  assert.deepEqual(await flowEngine.evaluateSafely({}, 'client-1', CONTACT, CHAT, {}, 'hi'), { handled: false, how: null });
});

// ----------------------------------------------------------- agentMayAnswer

test('agentMayAnswer is an allow-list of exactly one outcome: every other `how`, including unknown future ones, means silent', () => {
  assert.equal(flowEngine.agentMayAnswer({ handled: false, how: null }), true);
  const silent = [
    { handled: true, how: 'flow_continued' }, { handled: true, how: 'flow_capture_reply' },
    { handled: true, how: 'rule_started_flow' }, { handled: true, how: 'rule_text_reply' },
    { handled: true, how: 'rule_text_reply_failed' }, { handled: true, how: 'rule_flow_start_failed' },
    { handled: false, how: 'unmatched_input' }, { handled: false, how: 'flow_error', error: 'x' },
    { handled: false, how: 'some_future_outcome' }, { handled: true, how: null },
    null, undefined, {},
  ];
  for (const outcome of silent) {
    assert.equal(flowEngine.agentMayAnswer(outcome), false, JSON.stringify(outcome));
  }
});

// -------------------------------------------- the caller list, pinned in code

test('caller list: flowEngine.evaluate is called from exactly one production file, automationEngine.evaluate from exactly one', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'migrations') walk(full); } else if (e.name.endsWith('.js')) files.push(full);
    }
  }(root));
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const strip = (s) => s.replace(/\/\/.*$/gm, ''); // ignore comments
  const callers = (re) => files.filter((f) => re.test(strip(fs.readFileSync(f, 'utf8')))).map(rel).sort();

  assert.deepEqual(callers(/flowEngine\.(evaluate|evaluateSafely)\(/), ['routes/metaWebhook.js'],
    'a new caller of flowEngine.evaluate must handle the outcome; add it here deliberately');
  assert.deepEqual(callers(/automationEngine\.evaluate\(/), ['services/flowEngine.js']);
});
