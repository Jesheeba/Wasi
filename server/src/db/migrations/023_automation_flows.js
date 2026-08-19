// Flow-based automation engine — replaces automation_rules' single-step
// keyword->reply matching with multi-step, branching, stateful flows (build
// plan: flow engine). automation_rules itself is NOT replaced; it gains a
// nullable flow_id so a matched rule can either send free text (today's
// behavior, flow_id null) or start a flow (flow_id set) — see the CHECK
// constraint below. automationEngine.evaluate()'s existing first-match-wins
// semantics are unchanged; flowEngine.js is what interprets flow_id.
//
// Five new tenant tables, all given the same treatment as every tenant
// table since migration 013_tenant_isolation.js (RLS enabled+forced,
// granted to wasi_app) — same pattern migration 014_hub_capability.js used
// for api_keys/webhook_deliveries.
//
// Branching is modeled as edges (typed transitions), not as a property of
// nodes — flow_edges.condition_value for a 'button_id' edge is always the
// button's stable id (from a msg.interactive.button_reply.id webhook
// payload — see routes/metaWebhook.js), never its display title, since
// title is editable copy and using it as a match key would let a copy edit
// silently break a live flow. A 'keyword' edge matches exact/normalized
// text (trim+lowercase), NOT the substring match automation_rules'
// top-level triggers use — inside a priority-ordered branch set, substring
// overlap ("cancel" vs "can") produces a silent wrong-branch, which is a
// worse failure mode than a loud no-match falling through to 'default'.
//
// contact_flow_state.version is the optimistic-concurrency token for
// flowEngine's advance (compare-and-swap UPDATE ... WHERE version = $n),
// not current_node_id — a self-loop edge (node A -> A, e.g. "didn't
// understand, repeat") leaves current_node_id unchanged across a
// legitimate advance, so id-equality alone can't detect a concurrent
// advance already happened. The partial unique index enforces one active
// flow per contact (status 'active' or 'processing' — 'processing' is
// flowRunner's claim state, matching broadcast_recipients' 'sending'
// pattern) — an inbound message can only route to one place; a contact
// can't be mid-flow in two flows at once. due_at + the (status, due_at)
// index is the same "when is this due" shape webhook_deliveries already
// uses for forwardRunner's poll, reused here for flowRunner's delay/timeout
// poll.

exports.up = (pgm) => {
  pgm.createTable('automation_flows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'draft', check: "status in ('draft', 'active', 'archived')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('automation_flows', 'client_id');

  pgm.createTable('flow_nodes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    flow_id: { type: 'uuid', notNull: true, references: 'automation_flows', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    type: {
      type: 'text',
      notNull: true,
      check: "type in ('send_text', 'send_interactive_buttons', 'send_template', 'delay', 'action', 'end')",
    },
    config: { type: 'jsonb', notNull: true, default: '{}' },
    // Unused by the v1 step-list editor — present so a future canvas editor
    // doesn't need a migration to add it.
    position: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flow_nodes', 'flow_id');
  pgm.createIndex('flow_nodes', 'client_id');

  // Added now that flow_nodes exists — automation_flows and flow_nodes
  // reference each other (a flow has an entry node; a node belongs to a
  // flow), so this side is added second to avoid a create-order cycle.
  pgm.addColumns('automation_flows', {
    entry_node_id: { type: 'uuid', references: 'flow_nodes', onDelete: 'SET NULL' },
  });

  pgm.createTable('flow_edges', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    flow_id: { type: 'uuid', notNull: true, references: 'automation_flows', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    from_node_id: { type: 'uuid', notNull: true, references: 'flow_nodes', onDelete: 'CASCADE' },
    to_node_id: { type: 'uuid', notNull: true, references: 'flow_nodes', onDelete: 'CASCADE' },
    condition_type: {
      type: 'text',
      notNull: true,
      check: "condition_type in ('always', 'button_id', 'keyword', 'default', 'timeout')",
    },
    condition_value: { type: 'text' },
    priority: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flow_edges', 'flow_id');
  pgm.createIndex('flow_edges', 'from_node_id');

  pgm.createTable('contact_flow_state', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    flow_id: { type: 'uuid', notNull: true, references: 'automation_flows', onDelete: 'CASCADE' },
    current_node_id: { type: 'uuid', notNull: true, references: 'flow_nodes' },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status in ('active', 'processing', 'completed', 'cancelled', 'stalled')",
    },
    context: { type: 'jsonb', notNull: true, default: '{}' },
    version: { type: 'integer', notNull: true, default: 0 },
    waiting_since: { type: 'timestamptz' },
    due_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('contact_flow_state', 'client_id');
  // flowRunner's claim query: due, still-active rows.
  pgm.createIndex('contact_flow_state', ['status', 'due_at']);
  // One active (or being-claimed) flow per contact — see module comment.
  pgm.sql(`
    create unique index contact_flow_state_one_active_per_contact
      on contact_flow_state (client_id, contact_id)
      where status in ('active', 'processing')
  `);

  pgm.createTable('flow_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    flow_id: { type: 'uuid', notNull: true, references: 'automation_flows', onDelete: 'CASCADE' },
    node_id: { type: 'uuid', references: 'flow_nodes', onDelete: 'SET NULL' },
    event_type: {
      type: 'text',
      notNull: true,
      check: "event_type in ('entered', 'message_sent', 'button_clicked', 'timed_out', 'superseded', 'stalled', 'completed')",
    },
    detail: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('flow_events', ['client_id', 'contact_id']);
  // Stage 5's super-admin failures-view stall count reads this.
  pgm.createIndex('flow_events', 'event_type');

  // automation_rules gains an opt-in path to start a flow instead of
  // sending free text. A row means exactly one of those two things, never
  // both/neither — enforced in Postgres rather than app-code discipline,
  // matching this codebase's existing habit (opt_in_status CHECK,
  // broadcast_recipients.status CHECK, RLS itself).
  pgm.addColumns('automation_rules', {
    flow_id: { type: 'uuid', references: 'automation_flows', onDelete: 'SET NULL' },
  });
  pgm.addConstraint('automation_rules', 'automation_rules_action_xor_flow', {
    check: '(action is not null) != (flow_id is not null)',
  });

  const NEW_TENANT_TABLES = ['automation_flows', 'flow_nodes', 'flow_edges', 'contact_flow_state', 'flow_events'];
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
  }

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`
      create policy tenant_isolation on ${table}
        using (client_id = ${setting})
        with check (client_id = ${setting})
    `);
  }
};

exports.down = (pgm) => {
  const NEW_TENANT_TABLES = ['automation_flows', 'flow_nodes', 'flow_edges', 'contact_flow_state', 'flow_events'];
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`drop policy if exists tenant_isolation on ${table}`);
    pgm.sql(`alter table ${table} disable row level security`);
    pgm.sql(`revoke all on ${table} from wasi_app`);
  }

  pgm.dropConstraint('automation_rules', 'automation_rules_action_xor_flow');
  pgm.dropColumns('automation_rules', ['flow_id']);

  pgm.dropTable('flow_events');
  pgm.sql('drop index if exists contact_flow_state_one_active_per_contact');
  pgm.dropTable('contact_flow_state');
  pgm.dropTable('flow_edges');
  pgm.dropColumns('automation_flows', ['entry_node_id']);
  pgm.dropTable('flow_nodes');
  pgm.dropTable('automation_flows');
};
