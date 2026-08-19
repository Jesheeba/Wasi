// Flow engine (server/src/services/flowEngine.js) — pure-function testing
// for normalizeInboundEvent/resolveInboundEdge, same reasoning
// templateSyncService.test.js documents for reconcileTemplates: no DB, no
// network, no real Meta App needed to prove the branching logic is correct.
// The DB-touching half (runToRest, startFlow, continueFlow, the CAS
// advance) is covered by Stage 7's live verification against the real WABA,
// not here — mirroring templateSync.test.js's split between pure-function
// tests and one live-DB end-to-end test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInboundEvent, resolveInboundEdge, dueEdgeType } = require('../src/services/flowEngine');

// --- normalizeInboundEvent ---

test('normalizeInboundEvent: a button reply becomes a button_click event keyed on id, not title', () => {
  const msg = { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'flow_test_yes', title: 'Yes' } } };
  const event = normalizeInboundEvent(msg, 'Yes');
  assert.equal(event.kind, 'button_click');
  assert.equal(event.buttonId, 'flow_test_yes');
  assert.equal(event.buttonTitle, 'Yes');
});

test('normalizeInboundEvent: plain text uses the caller-derived body, not msg.text directly', () => {
  const msg = { type: 'text', text: { body: 'hello' } };
  const event = normalizeInboundEvent(msg, 'hello');
  assert.equal(event.kind, 'text');
  assert.equal(event.text, 'hello');
});

test('normalizeInboundEvent: no interactive.button_reply falls back to text even for other msg types', () => {
  const msg = { type: 'sticker' };
  const event = normalizeInboundEvent(msg, '[sticker]');
  assert.equal(event.kind, 'text');
  assert.equal(event.text, '[sticker]');
});

// --- resolveInboundEdge ---
// Edges are passed in flowEdgesRepo.listForNode's real order (default
// last) — these tests construct that order explicitly rather than relying
// on the repo, since resolveInboundEdge itself doesn't sort.

test('resolveInboundEdge: a button_id edge matches on id, ignoring title entirely', () => {
  const edges = [
    { id: 'e1', condition_type: 'button_id', condition_value: 'flow_test_yes', to_node_id: 'n_yes' },
    { id: 'e2', condition_type: 'button_id', condition_value: 'flow_test_no', to_node_id: 'n_no' },
  ];
  const event = { kind: 'button_click', buttonId: 'flow_test_no', buttonTitle: 'No' };
  const matched = resolveInboundEdge(edges, event);
  assert.equal(matched.id, 'e2');
});

test('resolveInboundEdge: a button_click event never matches a keyword edge, even if the title happens to equal the keyword', () => {
  const edges = [{ id: 'e1', condition_type: 'keyword', condition_value: 'yes', to_node_id: 'n1' }];
  const event = { kind: 'button_click', buttonId: 'flow_test_yes', buttonTitle: 'Yes' };
  assert.equal(resolveInboundEdge(edges, event), null);
});

test('resolveInboundEdge: keyword matching is exact/normalized, not substring — "cancel" does not match "can"', () => {
  const edges = [{ id: 'e1', condition_type: 'keyword', condition_value: 'can', to_node_id: 'n1' }];
  const event = { kind: 'text', text: 'cancel my order' };
  assert.equal(resolveInboundEdge(edges, event), null);
});

test('resolveInboundEdge: keyword matching trims and lowercases both sides', () => {
  const edges = [{ id: 'e1', condition_type: 'keyword', condition_value: '  Cancel  ', to_node_id: 'n1' }];
  const event = { kind: 'text', text: 'CANCEL' };
  const matched = resolveInboundEdge(edges, event);
  assert.equal(matched.id, 'e1');
});

test('resolveInboundEdge: falls through to the default edge when nothing else matches', () => {
  const edges = [
    { id: 'e1', condition_type: 'button_id', condition_value: 'flow_test_yes', to_node_id: 'n_yes' },
    { id: 'e2', condition_type: 'default', condition_value: null, to_node_id: 'n_fallback' },
  ];
  const event = { kind: 'text', text: 'something unexpected' };
  const matched = resolveInboundEdge(edges, event);
  assert.equal(matched.id, 'e2');
});

test('resolveInboundEdge: no match and no default edge returns null, not a throw', () => {
  const edges = [{ id: 'e1', condition_type: 'button_id', condition_value: 'flow_test_yes', to_node_id: 'n_yes' }];
  const event = { kind: 'text', text: 'unrelated' };
  assert.equal(resolveInboundEdge(edges, event), null);
});

test('resolveInboundEdge: an always edge is never matched against an inbound event', () => {
  const edges = [{ id: 'e1', condition_type: 'always', condition_value: null, to_node_id: 'n1' }];
  assert.equal(resolveInboundEdge(edges, { kind: 'text', text: 'anything' }), null);
  assert.equal(resolveInboundEdge(edges, { kind: 'button_click', buttonId: 'x' }), null);
});

test('resolveInboundEdge: a timeout edge is never matched against an inbound event (Stage 4 owns it)', () => {
  const edges = [{ id: 'e1', condition_type: 'timeout', condition_value: null, to_node_id: 'n1' }];
  assert.equal(resolveInboundEdge(edges, { kind: 'text', text: 'anything' }), null);
});

test('resolveInboundEdge: priority order is respected among non-default edges', () => {
  const edges = [
    { id: 'e_low', condition_type: 'keyword', condition_value: 'x', priority: 0, to_node_id: 'n1' },
    { id: 'e_high', condition_type: 'keyword', condition_value: 'x', priority: 1, to_node_id: 'n2' },
  ];
  // First edge in the passed-in (already-sorted) order wins, regardless of
  // which has the numerically higher priority field — sorting is
  // flowEdgesRepo.listForNode's job, resolveInboundEdge just walks in order.
  const matched = resolveInboundEdge(edges, { kind: 'text', text: 'x' });
  assert.equal(matched.id, 'e_low');
});

// --- dueEdgeType (Stage 4) ---

test('dueEdgeType: a delay node fires its always edge when due', () => {
  assert.equal(dueEdgeType('delay'), 'always');
});

test('dueEdgeType: a waiting-for-reply node fires its timeout edge when due', () => {
  assert.equal(dueEdgeType('send_interactive_buttons'), 'timeout');
});
