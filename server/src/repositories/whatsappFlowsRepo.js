// WhatsApp Flows ("Forms") - build-docs/features/whatsapp-flows.md.
// Tenant reads/writes take `db` (req.db, RLS-scoped). The webhook's
// response write runs on the privileged pool, so it scopes by client_id.
const COLUMNS = 'id, client_id, name, kind, config, flow_json, meta_flow_id, status, last_error, published_at, created_at, updated_at, attribute_map, template_name';

async function list(db, clientId) {
  const { rows } = await db.query(
    `select ${COLUMNS},
            (select count(*)::int from whatsapp_flow_responses r where r.flow_id = f.id) as response_count,
            (select t.status from message_templates t where t.client_id = f.client_id and t.name = f.template_name order by t.created_at desc limit 1) as template_status
     from whatsapp_flows f where client_id = $1 order by created_at desc`,
    [clientId]
  );
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query(`select ${COLUMNS} from whatsapp_flows where client_id = $1 and id = $2`, [clientId, id]);
  return rows[0] || null;
}

async function create(db, clientId, { name, kind, config }) {
  const { rows } = await db.query(
    `insert into whatsapp_flows (client_id, name, kind, config) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [clientId, name, kind, JSON.stringify(config)]
  );
  return rows[0];
}

// Partial update of the Meta-side state after a create/upload/publish step.
async function update(db, clientId, id, fields) {
  const allowed = ['name', 'config', 'flow_json', 'meta_flow_id', 'status', 'last_error', 'published_at', 'attribute_map', 'template_name'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return findById(db, clientId, id);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const values = keys.map((k) => (k === 'config' || k === 'flow_json' || k === 'attribute_map') && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]);
  const { rows } = await db.query(
    `update whatsapp_flows set ${sets.join(', ')}, updated_at = now() where client_id = $1 and id = $2 returning ${COLUMNS}`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query('delete from whatsapp_flows where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}

async function findByMetaFlowId(db, clientId, metaFlowId) {
  const { rows } = await db.query(`select ${COLUMNS} from whatsapp_flows where client_id = $1 and meta_flow_id = $2`, [clientId, metaFlowId]);
  return rows[0] || null;
}

// Privileged pool, from the webhook. Idempotent on (client_id, meta_message_id)
// so a redelivered webhook can't store a submission twice.
async function recordResponse(db, { clientId, flowId, chatId, contactId, metaMessageId, flowToken, response }) {
  const { rows } = await db.query(
    `insert into whatsapp_flow_responses (client_id, flow_id, chat_id, contact_id, meta_message_id, flow_token, response)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (client_id, meta_message_id) where meta_message_id is not null do nothing
     returning id`,
    [clientId, flowId, chatId, contactId, metaMessageId, flowToken, JSON.stringify(response)]
  );
  return rows[0] || null;
}

async function listResponses(db, clientId, flowId) {
  const { rows } = await db.query(
    `select r.id, r.response, r.created_at, r.chat_id, ch.name as contact_name, ch.phone
     from whatsapp_flow_responses r left join chats ch on ch.id = r.chat_id
     where r.client_id = $1 and r.flow_id = $2
     order by r.created_at desc limit 500`,
    [clientId, flowId]
  );
  return rows;
}

// Live booking: upcoming bookings for one form (newest slot first by date).
async function listBookings(db, clientId, flowId) {
  const { rows } = await db.query(
    `select b.id, b.slot_date::text as slot_date, b.slot_time, b.name, b.status, b.created_at, ch.phone, ch.id as chat_id
     from whatsapp_flow_bookings b left join chats ch on ch.id = b.chat_id
     where b.client_id = $1 and b.flow_id = $2 and b.slot_date >= current_date
     order by b.slot_date, b.slot_time limit 500`,
    [clientId, flowId]
  );
  return rows;
}

async function cancelBooking(db, clientId, flowId, bookingId) {
  const { rowCount } = await db.query(
    `update whatsapp_flow_bookings set status = 'cancelled' where client_id = $1 and flow_id = $2 and id = $3 and status = 'booked'`,
    [clientId, flowId, bookingId]
  );
  return rowCount > 0;
}

module.exports = {
  listBookings,
  cancelBooking, list, findById, create, update, remove, findByMetaFlowId, recordResponse, listResponses };
