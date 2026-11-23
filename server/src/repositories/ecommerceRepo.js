// Stores, message rules and events for the WooCommerce integration
// (build-docs/features/woocommerce-integration.md). Tenant routes pass
// req.db; the public webhook passes the privileged pool and every query here
// scopes by client_id (or by an id/token it then checks against client_id).
async function findStoreByClient(db, clientId) {
  const { rows } = await db.query(`select * from ecommerce_stores where client_id = $1 and platform = 'woocommerce'`, [clientId]);
  return rows[0] || null;
}

async function findStoreById(db, id) {
  const { rows } = await db.query('select * from ecommerce_stores where id = $1', [id]);
  return rows[0] || null;
}

async function findStoreByConnectToken(db, token) {
  const { rows } = await db.query(`select * from ecommerce_stores where connect_token = $1 and status = 'pending'`, [token]);
  return rows[0] || null;
}

// One store per client: starting a new connection replaces a pending or
// failed one (a connected store must be disconnected first - route checks).
async function upsertPendingStore(db, clientId, storeUrl, connectToken) {
  const { rows } = await db.query(
    `insert into ecommerce_stores (client_id, platform, store_url, status, connect_token)
     values ($1, 'woocommerce', $2, 'pending', $3)
     on conflict (client_id, platform) do update
       set store_url = $2, status = 'pending', connect_token = $3, last_error = null,
           consumer_key_encrypted = null, consumer_secret_encrypted = null, webhook_secret_encrypted = null,
           webhook_ids = '[]'::jsonb, updated_at = now()
     returning *`,
    [clientId, storeUrl, connectToken]
  );
  return rows[0];
}

async function updateStore(db, clientId, id, fields) {
  const allowed = ['status', 'consumer_key_encrypted', 'consumer_secret_encrypted', 'webhook_secret_encrypted', 'connect_token', 'webhook_ids', 'last_event_at', 'last_error'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const values = keys.map((k) => (k === 'webhook_ids' ? JSON.stringify(fields[k]) : fields[k]));
  const { rows } = await db.query(
    `update ecommerce_stores set ${sets.join(', ')}, updated_at = now() where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function deleteStore(db, clientId, id) {
  await db.query('delete from ecommerce_stores where client_id = $1 and id = $2', [clientId, id]);
}

async function listRules(db, clientId, storeId) {
  const { rows } = await db.query('select * from ecommerce_message_rules where client_id = $1 and store_id = $2 order by created_at', [clientId, storeId]);
  return rows;
}

async function findRule(db, clientId, storeId, trigger) {
  const { rows } = await db.query(
    'select * from ecommerce_message_rules where client_id = $1 and store_id = $2 and trigger = $3',
    [clientId, storeId, trigger]
  );
  return rows[0] || null;
}

async function upsertRule(db, clientId, storeId, { trigger, templateName, paramMap, enabled }) {
  const { rows } = await db.query(
    `insert into ecommerce_message_rules (client_id, store_id, trigger, template_name, param_map, enabled)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (store_id, trigger) do update set template_name = $4, param_map = $5, enabled = $6, updated_at = now()
     returning *`,
    [clientId, storeId, trigger, templateName, JSON.stringify(paramMap || {}), enabled]
  );
  return rows[0];
}

async function deleteRule(db, clientId, storeId, trigger) {
  await db.query('delete from ecommerce_message_rules where client_id = $1 and store_id = $2 and trigger = $3', [clientId, storeId, trigger]);
}

// Returns the new row, or null when this (store, dedupe_key) was already
// handled - the caller then does nothing.
async function claimEvent(db, { clientId, storeId, trigger, dedupeKey, orderNumber, customerName, phone }) {
  const { rows } = await db.query(
    `insert into ecommerce_events (client_id, store_id, trigger, dedupe_key, order_number, customer_name, phone)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (store_id, dedupe_key) do nothing
     returning *`,
    [clientId, storeId, trigger, dedupeKey, orderNumber, customerName, phone]
  );
  return rows[0] || null;
}

async function finishEvent(db, clientId, id, { status, detail, messageId }) {
  await db.query(
    'update ecommerce_events set status = $3, detail = $4, message_id = $5 where client_id = $1 and id = $2',
    [clientId, id, status, detail ? String(detail).slice(0, 500) : null, messageId || null]
  );
}

async function listEvents(db, clientId, storeId, limit = 50) {
  const { rows } = await db.query(
    `select id, trigger, order_number, customer_name, phone, status, detail, created_at
     from ecommerce_events where client_id = $1 and store_id = $2 order by created_at desc limit $3`,
    [clientId, storeId, limit]
  );
  return rows;
}

module.exports = {
  findStoreByClient, findStoreById, findStoreByConnectToken, upsertPendingStore, updateStore, deleteStore,
  listRules, findRule, upsertRule, deleteRule, claimEvent, finishEvent, listEvents,
};
