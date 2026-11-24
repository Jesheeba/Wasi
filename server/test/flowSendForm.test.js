// Bot Flow "Send form" step + the Business onboarding form kind
// (build-docs/features/whatsapp-flows.md, "Send form in automation").
// Stubs every repo/service flowEngine touches (same pattern as
// flowEngineCaptureReplyEndToEnd.test.js): no DB, no Meta call.
const test = require('node:test');
const assert = require('node:assert/strict');
const flowEngine = require('../src/services/flowEngine');
const { validateFlow } = require('../src/services/flowValidation');
const tpl = require('../src/utils/whatsappFlowTemplates');
const flowNodesRepo = require('../src/repositories/flowNodesRepo');
const flowEdgesRepo = require('../src/repositories/flowEdgesRepo');
const flowEventsRepo = require('../src/repositories/flowEventsRepo');
const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');
const whatsappFlowsRepo = require('../src/repositories/whatsappFlowsRepo');
const messagingService = require('../src/services/messagingService');
const automationEngine = require('../src/services/automationEngine');

const FORM_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_FORM_ID = '99999999-2222-4333-8444-555555555555';
const FORM = { id: FORM_ID, name: 'Wasi onboarding', kind: 'onboarding', status: 'draft', meta_flow_id: 'META_1', template_name: null };
const FORM_NODE = { id: 'n-form', type: 'send_form', config: { form_id: FORM_ID, body: 'Hi {{customer_name}}, fill this in', cta: 'Start' } };
const THANKS_NODE = { id: 'n-thanks', type: 'send_text', config: { body: 'Thanks!' } };
const CONTACT = { id: 'contact-1', name: 'Priya' };
const CHAT = { id: 'chat-1', phone: '919092766740' };

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  return () => { obj[name] = original; };
}
const nfm = (formId) => ({ interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ flow_token: tpl.makeFlowToken(formId) }) } } });

// Installs stubs for a graph; returns { sends, events, advance(), restore() }.
function harness({ edges = {}, form = FORM, windowOpen = true, flowState = null } = {}) {
  const sends = [];
  const events = [];
  let advanceCall = null;
  const nodes = { [FORM_NODE.id]: FORM_NODE, [THANKS_NODE.id]: THANKS_NODE };
  const restores = [
    stub(flowNodesRepo, 'findById', async (db, c, id) => nodes[id] || null),
    stub(flowEdgesRepo, 'listForNode', async (db, c, id) => edges[id] || []),
    stub(flowEventsRepo, 'record', async (db, e) => { events.push(e); }),
    stub(whatsappFlowsRepo, 'findById', async (db, c, id) => (form && id === form.id ? form : null)),
    stub(messagingService, 'canSendFreeform', async () => windowOpen),
    stub(messagingService, 'sendChatMessage', async (db, c, chat, msg) => { sends.push(msg); return { id: 'm1' }; }),
    stub(contactFlowStateRepo, 'findActive', async () => flowState),
    stub(contactFlowStateRepo, 'create', async () => ({ version: 1 })),
    stub(contactFlowStateRepo, 'advance', async (db, a) => { advanceCall = a; return { id: 'row' }; }),
    stub(automationEngine, 'evaluate', async () => ({ handled: false, how: null })),
  ];
  return { sends, events, advanced: () => advanceCall, restore: () => restores.forEach((r) => r()) };
}
const ALWAYS = { [FORM_NODE.id]: [{ id: 'e1', condition_type: 'always', to_node_id: THANKS_NODE.id }] };

test('AC1 onboarding form: valid against Meta limits, SIGN_UP, offered as a form type', () => {
  const { config, errors } = tpl.normalizeConfig('onboarding', {});
  assert.deepEqual(errors, []);
  assert.equal(tpl.KINDS.onboarding.category, 'SIGN_UP');
  const json = tpl.buildFlowJson('onboarding', config);
  assert.equal(json.screens[0].id, 'ONBOARDING');
  const names = json.screens[0].layout.children.map((c) => c.name).filter(Boolean);
  for (const f of ['business', 'name', 'email', 'industry', 'plan', 'provider', 'website']) assert.ok(names.includes(f), f);
  assert.ok(config.fields.plan.options.includes('Growth (₹2,999/month)'));
  assert.equal(config.fields.website.required, false);
});

test('AC9 edges: a Send form step takes always (submitted) and timeout only', () => {
  assert.equal(flowEngine.isEdgeTypeLegalForNode('send_form', 'always'), true);
  assert.equal(flowEngine.isEdgeTypeLegalForNode('send_form', 'timeout'), true);
  assert.equal(flowEngine.isEdgeTypeLegalForNode('send_form', 'keyword'), false);
});

test('submittedFormId reads the Wasi form id out of a completed form only', () => {
  assert.equal(flowEngine.submittedFormId(nfm(FORM_ID)), FORM_ID);
  assert.equal(flowEngine.submittedFormId({}), null);
  assert.equal(flowEngine.submittedFormId({ interactive: { nfm_reply: { response_json: 'not json' } } }), null);
});

test('AC2 the step sends the form (draft mode, our token, rendered text) and waits with a timeout', async () => {
  const h = harness({ edges: { [FORM_NODE.id]: [...ALWAYS[FORM_NODE.id], { id: 'e2', condition_type: 'timeout', to_node_id: THANKS_NODE.id }] } });
  FORM_NODE.config.timeout_minutes = 60;
  try {
    await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'flow-1', entry_node_id: FORM_NODE.id });
    assert.equal(h.sends.length, 1);
    const sent = h.sends[0];
    assert.equal(sent.type, 'flow');
    assert.equal(sent.body, 'Hi Priya, fill this in');
    assert.deepEqual([sent.flow.metaFlowId, sent.flow.flowToken, sent.flow.cta, sent.flow.mode, sent.flow.screen, sent.flow.action],
      ['META_1', `wasi_flow:${FORM_ID}`, 'Start', 'draft', 'ONBOARDING', 'navigate']);
    const rest = h.advanced();
    assert.equal(rest.status, 'active');
    assert.equal(rest.nodeId, FORM_NODE.id);
    assert.ok(rest.dueAt, 'timeout edge + minutes sets due_at');
  } finally { delete FORM_NODE.config.timeout_minutes; h.restore(); }
});

test('AC3 submitting that form continues the flow (form_submitted), and the agent stays silent', async () => {
  const h = harness({ edges: ALWAYS, flowState: { flow_id: 'flow-1', current_node_id: FORM_NODE.id, version: 3 } });
  try {
    const out = await flowEngine.evaluate({}, 'client-1', CONTACT, CHAT, nfm(FORM_ID), 'Form submitted: Wasi onboarding');
    assert.deepEqual(out, { handled: true, how: 'flow_form_submitted' });
    assert.equal(flowEngine.agentMayAnswer(out), false);
    assert.ok(h.events.some((e) => e.eventType === 'form_submitted' && e.detail.formId === FORM_ID));
    assert.deepEqual(h.sends.map((s) => s.body), ['Thanks!']);
    assert.equal(h.advanced().status, 'completed');
  } finally { h.restore(); }
});

test('AC4 a text or a different form while waiting does not move the flow', async () => {
  for (const [msg, body] of [[{}, 'what are the fees?'], [nfm(OTHER_FORM_ID), 'Form submitted']]) {
    const h = harness({ edges: ALWAYS, flowState: { flow_id: 'flow-1', current_node_id: FORM_NODE.id, version: 3 } });
    try {
      const out = await flowEngine.evaluate({}, 'client-1', CONTACT, CHAT, msg, body);
      assert.deepEqual(out, { handled: false, how: 'unmatched_input' });
      assert.equal(h.sends.length, 0);
      assert.equal(h.advanced(), null);
      assert.ok(h.events.some((e) => e.eventType === 'unmatched_input'));
    } finally { h.restore(); }
  }
});

test('AC5 a Send form step with no next step sends and finishes (never parks the contact)', async () => {
  const h = harness();
  try {
    await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'flow-1', entry_node_id: FORM_NODE.id });
    assert.equal(h.sends.length, 1);
    assert.equal(h.advanced().status, 'completed');
  } finally { h.restore(); }
});

test('AC6 outside 24h: the approved "Send anytime" template goes out; without one the step stalls with the reason', async () => {
  const db = { query: async () => ({ rows: [{ name: 'wasi_onboarding_form', language: 'en', status: 'approved' }] }) };
  let h = harness({ edges: ALWAYS, windowOpen: false, form: { ...FORM, template_name: 'wasi_onboarding_form' } });
  try {
    await flowEngine.startFlow(db, 'client-1', CONTACT, CHAT, { id: 'flow-1', entry_node_id: FORM_NODE.id });
    assert.equal(h.sends[0].type, 'template');
    assert.equal(h.sends[0].templateComponents[0].parameters[0].action.flow_token, `wasi_flow:${FORM_ID}`);
  } finally { h.restore(); }

  h = harness({ edges: ALWAYS, windowOpen: false });
  try {
    await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'flow-1', entry_node_id: FORM_NODE.id });
    assert.equal(h.sends.length, 0);
    assert.equal(h.advanced().status, 'stalled');
    assert.equal(h.events.find((e) => e.eventType === 'stalled').detail.code, 'session_window_closed');
  } finally { h.restore(); }
});

test('AC7 a deleted or retired form stalls the step, nothing is sent', async () => {
  for (const form of [null, { ...FORM, status: 'deprecated' }]) {
    const h = harness({ edges: ALWAYS, form });
    try {
      await flowEngine.startFlow({}, 'client-1', CONTACT, CHAT, { id: 'flow-1', entry_node_id: FORM_NODE.id });
      assert.equal(h.sends.length, 0);
      assert.equal(h.advanced().status, 'stalled');
    } finally { h.restore(); }
  }
});

test('AC8 activation checks: no form, deleted form, retired form are flagged; a usable form is not', async () => {
  const check = async (config, form) => {
    const r = stub(whatsappFlowsRepo, 'findById', async () => form);
    try { return (await validateFlow({}, 'client-1', [{ id: 'n', type: 'send_form', config }], [])).map((i) => i.code); } finally { r(); }
  };
  assert.deepEqual(await check({}, null), ['send_form_missing']);
  assert.deepEqual(await check({ form_id: FORM_ID }, null), ['send_form_not_found']);
  assert.deepEqual(await check({ form_id: FORM_ID }, { ...FORM, status: 'deprecated' }), ['send_form_not_sendable']);
  assert.deepEqual(await check({ form_id: FORM_ID }, FORM), []);
});
