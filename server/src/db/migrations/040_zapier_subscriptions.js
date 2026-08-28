// Integrations Marketplace, Tier 2 — Zapier (wasi-master-plan.md §3.1/§8.2,
// build plan Phase 4). Zapier's "New WhatsApp Message Received" trigger is a
// REST Hook (instant) trigger, not a polling one — Phase 0 investigation
// found no existing "list inbound messages across the account by time"
// endpoint to poll, and building one would be MORE new surface than reusing
// what already exists: routes/metaWebhook.js's enqueueForwards already fires
// on every message.received event, feeding the existing webhook_deliveries
// queue + forwardRunner.js delivery/retry/HMAC-signing logic (migration
// 014_hub_capability.js) unchanged.
//
// The one thing that infrastructure can't already do is hold a per-Zap
// subscription: both existing forward targets (wabas.forward_to_url,
// client_webhooks.callback_url) are single-valued per client (see those
// tables), but a client may turn on several Zaps, each needing its own
// target_url. zapier_subscriptions is that missing piece — one row per
// active Zap subscription — and nothing else; enqueueForwards (routes/
// metaWebhook.js) is extended to also enqueue to every matching row here,
// the same way it already does for the other two targets.
//
// api_key_id ties a subscription to the specific key that created it (the
// client's own key, pasted into Zapier's connection dialog per Phase 0's
// interim-auth decision — no OAuth/Connected-Apps dependency, see
// wasi-master-plan.md §8.6's own build-order: OAuth is sequenced AFTER
// Zapier, needed only when moving from private/beta to certified
// distribution, not to ship at all). Deleting the key (routes/apiKeys.js)
// cascades to remove every subscription it owns — an integration a client
// revoked shouldn't keep receiving events.
//
// `secret` is generated fresh per subscription (crypto.randomBytes, same as
// every other secret in this codebase — see wabas.forward_secret,
// client_webhooks.secret) and returned to the Zapier app exactly once, at
// creation time, for HMAC verification — never a shared secret across
// subscriptions or clients.
//
// Same tenant-table treatment as api_keys/webhook_deliveries in migration
// 014_hub_capability.js: RLS enabled+forced and granted to wasi_app as
// defense-in-depth, even though routes/apiV1Subscriptions.js (like every
// other /api/v1/* route) runs on the privileged `pool` connection today,
// not req.db — not exercised via wasi_app currently, same documented
// exception as that migration.
exports.up = (pgm) => {
  pgm.createTable('zapier_subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    api_key_id: { type: 'uuid', notNull: true, references: 'api_keys', onDelete: 'CASCADE' },
    target_url: { type: 'text', notNull: true },
    secret: { type: 'text', notNull: true },
    event: { type: 'text', notNull: true, check: "event = 'message.received'" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('zapier_subscriptions', 'client_id');
  pgm.createIndex('zapier_subscriptions', 'api_key_id');

  pgm.sql(`grant select, insert, update, delete on zapier_subscriptions to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table zapier_subscriptions enable row level security`);
  pgm.sql(`alter table zapier_subscriptions force row level security`);
  pgm.sql(`
    create policy tenant_isolation on zapier_subscriptions
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same discipline as migrations 032/036/039's down()s — a real client's
  // live Zap subscription could exist by the time a rollback runs on this
  // shared database; silently dropping it would break their integration
  // with no warning.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from zapier_subscriptions');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 040_zapier_subscriptions: ${count} real Zapier subscription(s) exist. ` +
      `A client's live Zap depends on this row — confirm with them before removing it, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on zapier_subscriptions`);
  pgm.sql(`alter table zapier_subscriptions disable row level security`);
  pgm.sql(`revoke all on zapier_subscriptions from wasi_app`);
  pgm.dropTable('zapier_subscriptions');
};
