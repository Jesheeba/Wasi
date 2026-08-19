async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    'select * from message_templates where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

// Consent enforcement (messagingService.sendChatMessage) looks up a
// template's category by name to decide whether it's subject to the
// opt-in gate — a template name is only unique per client, not globally.
async function findByNameAndClient(db, clientId, name) {
  const { rows } = await db.query(
    'select * from message_templates where client_id = $1 and name = $2 order by created_at desc limit 1',
    [clientId, name]
  );
  return rows[0] || null;
}

// language/header/footer/buttons/bodyParamExamples/auth fields added for
// the template form rebuild (migration 020_template_rich_fields.js) — all
// previously silently dropped here even when present upstream (language in
// particular has had a DB column with a default since 006_messaging.js,
// but nothing ever wrote a caller-chosen value into it until now).
async function create(db, {
  client_id, name, category, status, body,
  language, header, footer, buttons, bodyParamExamples,
  codeExpirationMinutes, addSecurityDisclaimer, otpButtonType,
}) {
  const authOptions = category === 'Authentication'
    ? { codeExpirationMinutes, addSecurityDisclaimer, otpButtonType }
    : null;
  const { rows } = await db.query(
    `insert into message_templates (
       client_id, name, category, status, body, language,
       header_type, header_content, footer_text, buttons, body_param_examples, auth_options
     )
     values ($1, $2, $3, coalesce($4, 'pending'), $5, coalesce($6, 'en_US'), $7, $8, $9, $10, $11, $12)
     returning *`,
    [
      client_id, name, category, status, body || null, language,
      header?.type || null, header?.text || null, footer || null,
      buttons ? JSON.stringify(buttons) : null,
      bodyParamExamples ? JSON.stringify(bodyParamExamples) : null,
      authOptions ? JSON.stringify(authOptions) : null,
    ]
  );
  return rows[0];
}

// All templates across every tenant, joined with client identity — powers
// the admin Templates Review queue (spec §5 "Templates Review" row).
// Admin-only, always the privileged connection.
async function listAll(db, status) {
  const { rows } = await db.query(
    `select t.*, c.name as client_name, c.tenant_slug
     from message_templates t
     join clients c on c.id = t.client_id
     where $1::text is null or t.status = $1
     order by t.created_at desc`,
    [status || null]
  );
  return rows;
}

// Admin-only (status flips from the Templates Review queue) and the Meta
// webhook (message_template_status_update) — always the privileged
// connection, no client_id known up front in the webhook case.
async function updateStatus(db, id, status) {
  const { rows } = await db.query(
    `update message_templates set status = $2, updated_at = now() where id = $1 returning *`,
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { listByClientId, create, listAll, updateStatus, findByNameAndClient };
