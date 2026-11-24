// AI agent Phase 1 schema (docs/ai-agent/SPEC.md section 6;
// build-docs/features/ai-agent.md). Additive only.
//
// Departures from the SPEC DDL, all recorded in the feature doc:
//   - ai_agents.api_key_encrypted / api_key_last4: bring-your-own-key (owner
//     decision 2026-11-23). Encrypted with utils/encryption.js; only the last
//     4 characters are ever returned by an API.
//   - ai_agents.mode: 'shadow' (generate + log, never send) | 'live'. 'live'
//     is additionally limited by AI_LIVE_ALLOWLIST in code until the legal
//     gate clears.
//   - ai_agents.model: default claude-haiku-4-5 (decision 22), a setting so
//     the Haiku 5.5 evaluation is a config change.
//   - ai_replies.mode: which mode produced the row, so shadow replies are
//     never counted as sent.
//
// Grants: ai_agents, ai_agent_consent_events, ai_knowledge_sources and
// ai_replies are read/written by tenant-scoped routes (req.db), so they get
// the wasi_app grant + tenant_isolation RLS policy, same as migration 023.
// ai_gate_log is written by the runner (privileged pool) and read by a
// tenant route, so it gets the same treatment. chats has a table-level
// wasi_app grant (migration 013): new columns need no grant.
const TENANT_TABLES = ['ai_agents', 'ai_agent_consent_events', 'ai_knowledge_sources', 'ai_replies', 'ai_gate_log'];

exports.up = (pgm) => {
  pgm.createTable('ai_agents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE', unique: true },
    is_enabled: { type: 'boolean', notNull: true, default: false },
    enabled_at: { type: 'timestamptz' },
    enabled_by_type: { type: 'text' },
    enabled_by_id: { type: 'uuid' },
    mode: { type: 'text', notNull: true, default: 'shadow', check: "mode in ('shadow', 'live')" },
    model: { type: 'text', notNull: true, default: 'claude-haiku-4-5' },
    api_key_encrypted: { type: 'text' },
    api_key_last4: { type: 'text' },
    business_name: { type: 'text', notNull: true, default: '' },
    business_type: { type: 'text' },
    description: { type: 'text' },
    areas_served: { type: 'text' },
    hours: { type: 'text' },
    languages: { type: 'text[]', notNull: true, default: pgm.func("'{english}'") },
    tone: { type: 'text', notNull: true, default: 'friendly_professional' },
    schedule_mode: { type: 'text', notNull: true, default: 'outside_hours', check: "schedule_mode in ('always', 'outside_hours')" },
    timezone: { type: 'text', notNull: true, default: 'Asia/Kolkata' },
    staff_hours: { type: 'jsonb' },
    fallback_message: { type: 'text', notNull: true, default: "Thanks for your message. I've passed it on to our team." },
    handover_message: { type: 'text', notNull: true, default: "I've passed this on to our team. They'll reply when they're next in." },
    knowledge_md: { type: 'text', notNull: true, default: '' },
    knowledge_tokens: { type: 'integer', notNull: true, default: 0 },
    monthly_cap: { type: 'integer', notNull: true, default: 1000 },
    replies_used: { type: 'integer', notNull: true, default: 0 },
    period_start: { type: 'date', notNull: true, default: pgm.func("date_trunc('month', now())::date") },
    cap_notified_at: { type: 'timestamptz' },
    ai_consent_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('ai_agent_consent_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    agent_id: { type: 'uuid', notNull: true, references: 'ai_agents', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true, check: "event_type in ('granted', 'revoked')" },
    statement_version: { type: 'text', notNull: true },
    statement_text: { type: 'text', notNull: true },
    actor_type: { type: 'text', notNull: true, check: "actor_type in ('owner', 'team_member')" },
    actor_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ai_agent_consent_events', ['agent_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.createTable('ai_knowledge_sources', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    agent_id: { type: 'uuid', notNull: true, references: 'ai_agents', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true, check: "kind in ('qa', 'pasted', 'upload')" },
    title: { type: 'text' },
    question: { type: 'text' },
    answer: { type: 'text' },
    body: { type: 'text' },
    file_name: { type: 'text' },
    file_bytes: { type: 'integer' },
    origin: { type: 'text', notNull: true, default: 'manual', check: "origin in ('manual', 'history_seed')" },
    is_active: { type: 'boolean', notNull: true, default: true },
    token_estimate: { type: 'integer', notNull: true, default: 0 },
    sort_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ai_knowledge_sources', ['agent_id', 'is_active', 'sort_order']);

  pgm.createTable('ai_replies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    agent_id: { type: 'uuid', notNull: true, references: 'ai_agents', onDelete: 'CASCADE' },
    conversation_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    inbound_message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    outbound_message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    mode: { type: 'text', notNull: true, check: "mode in ('shadow', 'live')" },
    customer_text: { type: 'text', notNull: true },
    reply_text: { type: 'text' },
    outcome: {
      type: 'text', notNull: true,
      check: "outcome in ('sent', 'shadow', 'refused_out_of_scope', 'no_knowledge', 'model_error', 'send_failed', 'rate_limited')",
    },
    source_ids: { type: 'uuid[]', notNull: true, default: pgm.func("'{}'") },
    model: { type: 'text', notNull: true },
    tokens_in: { type: 'integer', notNull: true, default: 0 },
    tokens_cached: { type: 'integer', notNull: true, default: 0 },
    tokens_out: { type: 'integer', notNull: true, default: 0 },
    cost_paise: { type: 'integer', notNull: true, default: 0 },
    latency_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ai_replies', ['client_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('ai_replies', ['conversation_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('ai_replies', 'outbound_message_id');

  pgm.createTable('ai_gate_log', {
    id: { type: 'bigserial', primaryKey: true },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    conversation_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    inbound_message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    gate: { type: 'text', notNull: true },
    detail: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ai_gate_log', ['conversation_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('ai_gate_log', ['client_id', { name: 'created_at', sort: 'DESC' }]);

  // Two different things on purpose (SPEC section 6): ai_muted is a person's
  // decision; ai_cooldown_until is the system pausing itself. Never merge.
  pgm.addColumns('chats', {
    ai_muted: { type: 'boolean', notNull: true, default: false },
    ai_muted_at: { type: 'timestamptz' },
    ai_muted_by_type: { type: 'text' },
    ai_muted_by_id: { type: 'uuid' },
    ai_cooldown_until: { type: 'timestamptz' },
    ai_handover_reason: { type: 'text' },
    ai_handover_at: { type: 'timestamptz' },
  });

  const setting = "nullif(current_setting('app.current_client_id', true), '')::uuid";
  for (const table of TENANT_TABLES) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`create policy tenant_isolation on ${table} using (client_id = ${setting}) with check (client_id = ${setting})`);
  }
  pgm.sql('grant usage, select on sequence ai_gate_log_id_seq to wasi_app');
};

// Drops everything above. ai_replies/ai_gate_log/consent events are history a
// real client may care about: refuse if any agent has ever been enabled.
exports.down = (pgm) => {
  pgm.sql(`do $$ begin
    if exists (select 1 from ai_agents where enabled_at is not null) then
      raise exception 'Refusing to roll back 103_ai_agent: an agent has been enabled; its history would be lost.';
    end if; end $$;`);
  pgm.dropColumns('chats', ['ai_muted', 'ai_muted_at', 'ai_muted_by_type', 'ai_muted_by_id', 'ai_cooldown_until', 'ai_handover_reason', 'ai_handover_at']);
  for (const table of [...TENANT_TABLES].reverse()) pgm.dropTable(table);
};
