const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFlow } = require('../src/services/flowValidation');

// Fake `db` — validateFlow only ever reaches the DB through
// messageTemplatesRepo.findByNameAndClient(db, clientId, name), which runs
// `select * from message_templates where client_id = $1 and name = $2 ...`.
// No real Postgres needed; this stands in for it precisely enough for
// validateFlow's own logic to be exercised end to end, DB-free (avoiding
// the shared-production-DB guard entirely for this test file).
function fakeDb(templatesByName) {
  return {
    async query(sql, params) {
      assert.match(sql, /from message_templates/);
      const name = params[1];
      const row = templatesByName[name];
      return { rows: row ? [row] : [] };
    },
  };
}

const CLIENT_ID = 'client-1';

test('validateFlow: an unrouted button on a node with a default branch — falls-through message', async () => {
  const nodes = [
    { id: 'n1', type: 'send_interactive_buttons', config: { buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }] } },
    { id: 'n2', type: 'send_text', config: {} },
    { id: 'n3', type: 'send_text', config: {} },
  ];
  const edges = [
    { id: 'e1', from_node_id: 'n1', to_node_id: 'n2', condition_type: 'button_id', condition_value: 'yes' },
    { id: 'e2', from_node_id: 'n1', to_node_id: 'n3', condition_type: 'default', condition_value: null },
  ];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'unrouted_button');
  assert.equal(issues[0].nodeId, 'n1');
  assert.match(issues[0].message, /"No"/);
  assert.match(issues[0].message, /falls through to the default branch/);
});

test('validateFlow: an unrouted button with NO default branch either — dropped message, not "falls through"', async () => {
  const nodes = [
    { id: 'n1', type: 'send_interactive_buttons', config: { buttons: [{ id: 'yes', title: 'Yes' }] } },
  ];
  const edges = [];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'unrouted_button');
  assert.match(issues[0].message, /silently dropped/);
});

test('validateFlow: every button routed — no issue', async () => {
  const nodes = [
    { id: 'n1', type: 'send_interactive_buttons', config: { buttons: [{ id: 'yes', title: 'Yes' }] } },
    { id: 'n2', type: 'end', config: {} },
  ];
  const edges = [
    { id: 'e1', from_node_id: 'n1', to_node_id: 'n2', condition_type: 'button_id', condition_value: 'yes' },
  ];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  assert.equal(issues.length, 0);
});

test('validateFlow: a delay node with no always edge stalls every contact — flagged', async () => {
  const nodes = [{ id: 'n1', type: 'delay', config: { duration_minutes: 5 } }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'delay_dead_end');
  assert.equal(issues[0].nodeId, 'n1');
});

test('validateFlow: a delay node WITH an always edge — no issue', async () => {
  const nodes = [
    { id: 'n1', type: 'delay', config: { duration_minutes: 5 } },
    { id: 'n2', type: 'end', config: {} },
  ];
  const edges = [{ id: 'e1', from_node_id: 'n1', to_node_id: 'n2', condition_type: 'always', condition_value: null }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  assert.equal(issues.length, 0);
});

test('validateFlow: send_text/send_template/action with zero outgoing edges is NOT flagged (legitimate implicit end)', async () => {
  const nodes = [
    { id: 'n1', type: 'send_text', config: { body: 'bye' } },
    { id: 'n2', type: 'action', config: { kind: 'human_handoff' } },
  ];
  const issues = await validateFlow(fakeDb({ ok_template: { status: 'approved' } }), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 0);
});

test('validateFlow: send_interactive_buttons with zero outgoing edges and zero buttons is NOT flagged', async () => {
  const nodes = [{ id: 'n1', type: 'send_interactive_buttons', config: { buttons: [] } }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 0);
});

test('validateFlow: send_template referencing a template that does not exist', async () => {
  const nodes = [{ id: 'n1', type: 'send_template', config: { templateName: 'ghost_template' } }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'template_not_found');
});

test('validateFlow: send_template referencing a pending (not approved) template', async () => {
  const nodes = [{ id: 'n1', type: 'send_template', config: { templateName: 'draft_template' } }];
  const issues = await validateFlow(fakeDb({ draft_template: { status: 'pending' } }), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'template_not_approved');
  assert.match(issues[0].message, /pending/);
});

test('validateFlow: send_template referencing an approved template — no issue', async () => {
  const nodes = [{ id: 'n1', type: 'send_template', config: { templateName: 'good_template' } }];
  const issues = await validateFlow(fakeDb({ good_template: { status: 'approved' } }), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 0);
});

test('validateFlow: send_template with no templateName at all', async () => {
  const nodes = [{ id: 'n1', type: 'send_template', config: {} }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'template_missing');
});

test('validateFlow: an edge pointing at a node that no longer exists in the given set', async () => {
  const nodes = [{ id: 'n1', type: 'send_text', config: {} }];
  const edges = [{ id: 'e1', from_node_id: 'n1', to_node_id: 'ghost-node', condition_type: 'always', condition_value: null }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'dangling_edge');
  assert.equal(issues[0].edgeId, 'e1');
});

test('validateFlow: a dangling edge from n1 does not count toward n1s own routed-button coverage', async () => {
  // A button_id edge whose TARGET is missing shouldn't be treated as having
  // "covered" that button — it's dangling, so the button is effectively
  // still unrouted for any real execution.
  const nodes = [
    { id: 'n1', type: 'send_interactive_buttons', config: { buttons: [{ id: 'yes', title: 'Yes' }] } },
  ];
  const edges = [{ id: 'e1', from_node_id: 'n1', to_node_id: 'ghost-node', condition_type: 'button_id', condition_value: 'yes' }];
  const issues = await validateFlow(fakeDb({}), CLIENT_ID, nodes, edges);
  const codes = issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['dangling_edge', 'unrouted_button']);
});
