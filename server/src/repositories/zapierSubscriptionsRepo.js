const crypto = require('crypto');

// Only 'message.received' is wired today (see migration 040's comment) —
// the column's CHECK constraint is the real enforcement; this repo doesn't
// duplicate that validation, routes/apiV1Subscriptions.js's zod schema does.
//
// Upserts on (client_id, target_url, event) (migration 041, independent QA
// finding) — a repeat subscribe for the identical target/event (a retried
// Zapier subscribe call, or a Zap re-enabled without a clean unsubscribe)
// reuses the existing row and its existing secret rather than creating a
// second one, which previously caused every matching inbound message to be
// delivered twice. api_key_id is updated to whichever key subscribed most
// recently; the secret is intentionally NOT regenerated on conflict — the
// receiving Zap already has it from the first subscribe.
async function create(db, clientId, apiKeyId, targetUrl, event) {
  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `insert into zapier_subscriptions (client_id, api_key_id, target_url, secret, event)
     values ($1, $2, $3, $4, $5)
     on conflict (client_id, target_url, event)
     do update set api_key_id = excluded.api_key_id
     returning *`,
    [clientId, apiKeyId, targetUrl, secret, event]
  );
  return rows[0];
}

// Read by routes/metaWebhook.js's enqueueForwards — every active
// subscription for this client listening for this event, same shape as the
// wabas.forward_to_url / client_webhooks lookups it already does alongside
// this one. Unlike those two single-valued targets, there can be many rows
// here (one per active Zap).
async function listByClientAndEvent(db, clientId, event) {
  const { rows } = await db.query(
    `select * from zapier_subscriptions where client_id = $1 and event = $2`,
    [clientId, event]
  );
  return rows;
}

async function remove(db, clientId, id) {
  const { rows } = await db.query(
    `delete from zapier_subscriptions where id = $1 and client_id = $2 returning id`,
    [id, clientId]
  );
  return rows[0] || null;
}

// Called from routes/apiKeys.js's revoke/delete (build plan Phase 4,
// independent audit finding). migration 040's api_key_id has ON DELETE
// CASCADE, but that only fires on a real SQL DELETE — apiKeysRepo.revoke
// and softDelete are both tombstones (revoked_at/deleted_at columns, never
// an actual row delete), so the cascade this migration's own comment
// promised never runs in practice. Called explicitly instead: a client
// revoking a key expects any integration using it — including a live Zap —
// to actually stop, matching app.js's own confirm-dialog text ("Any
// integration ... will stop working immediately").
async function removeByApiKeyId(db, apiKeyId) {
  await db.query(`delete from zapier_subscriptions where api_key_id = $1`, [apiKeyId]);
}

module.exports = { create, listByClientAndEvent, remove, removeByApiKeyId };
