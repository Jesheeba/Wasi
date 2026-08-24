async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    'select * from message_templates where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

// routes/templates.js's POST /:id/header-media (send-time media upload)
// looks up the target template by id, scoped to the caller's tenant.
async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from message_templates where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
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

// Meta scopes template uniqueness to (name, language) per WABA, not name
// alone — a second submission under a (name, language) Meta already has
// something for doesn't get cleanly rejected, it queues for review and can
// sit unresolved far longer than normal (confirmed live: 20+ hours pending
// against an already-approved same-name-and-language template). Used by
// routes/templates.js to reject that case before ever calling Meta.
// orphaned_at is null on purpose — an orphaned row is confirmed gone from
// Meta (templateSyncService.js's reconcile no longer finds it there), so
// its (name, language) slot is presumed free again. A rejected-but-not-
// orphaned row still blocks: Meta's exact reuse behavior after a rejection
// (does the slot free up immediately, or only after the template is
// explicitly deleted on Meta?) isn't confirmed, so this fails closed
// rather than risk letting another submission queue indefinitely.
async function findActiveByNameAndLanguage(db, clientId, name, language) {
  const { rows } = await db.query(
    `select * from message_templates
     where client_id = $1 and name = $2 and language = $3 and orphaned_at is null
     order by created_at desc`,
    [clientId, name, language]
  );
  return rows;
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
  meta_template_id,
}) {
  const authOptions = category === 'Authentication'
    ? { codeExpirationMinutes, addSecurityDisclaimer, otpButtonType }
    : null;
  const { rows } = await db.query(
    `insert into message_templates (
       client_id, name, category, status, body, language,
       header_type, header_content, footer_text, buttons, body_param_examples, auth_options,
       meta_template_id
     )
     values ($1, $2, $3, coalesce($4, 'pending'), $5, coalesce($6, 'en_US'), $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      client_id, name, category, status, body || null, language,
      header?.type || null, header?.text || null, footer || null,
      buttons ? JSON.stringify(buttons) : null,
      bodyParamExamples ? JSON.stringify(bodyParamExamples) : null,
      authOptions ? JSON.stringify(authOptions) : null,
      meta_template_id || null,
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

// --- Template sync (services/templateSyncService.js) ---

// A template found on Meta with no local row at all — full reconstruction
// from Meta's own data, since there's nothing local to preserve.
async function createFromMetaSync(db, {
  client_id, meta_template_id, name, category, status, language, rejection_reason,
  body, bodyParamExamples, headerType, headerContent, footerText, buttons,
}) {
  const { rows } = await db.query(
    `insert into message_templates (
       client_id, meta_template_id, name, category, status, language, rejection_reason,
       body, body_param_examples, header_type, header_content, footer_text, buttons
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      client_id, meta_template_id, name, category, status, language || 'en_US', rejection_reason || null,
      body || null,
      bodyParamExamples ? JSON.stringify(bodyParamExamples) : null,
      headerType && headerType !== 'NONE' ? headerType : null,
      headerContent || null,
      footerText || null,
      buttons ? JSON.stringify(buttons) : null,
    ]
  );
  return rows[0];
}

// A template matched to an existing local row (by meta_template_id or,
// for legacy/backfill rows, by name) — only the fields that can drift on
// Meta's side get refreshed; content fields (body/header/footer/buttons)
// are left as this app already has them. meta_template_id backfills via
// COALESCE rather than overwriting, so it's a no-op once already set.
// Clears orphaned_at unconditionally: reappearing in this sync's Meta
// listing means it isn't missing anymore, however it got marked before.
async function updateFromMetaSync(db, id, { status, category, rejection_reason, meta_template_id }) {
  const { rows } = await db.query(
    `update message_templates
     set status = $2, category = $3, rejection_reason = $4,
         meta_template_id = coalesce(meta_template_id, $5),
         orphaned_at = null,
         updated_at = now()
     where id = $1
     returning *`,
    [id, status, category, rejection_reason || null, meta_template_id]
  );
  return rows[0] || null;
}

// Marks a local row as no longer found on Meta — never a delete. A local
// draft never submitted (no meta_template_id) is never passed here; see
// templateSyncService.js's reconcileTemplates for that guard.
async function markOrphaned(db, id) {
  const { rows } = await db.query(
    `update message_templates set orphaned_at = now(), updated_at = now() where id = $1 returning *`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  listByClientId,
  create,
  listAll,
  updateStatus,
  findById,
  findByNameAndClient,
  findActiveByNameAndLanguage,
  createFromMetaSync,
  updateFromMetaSync,
  markOrphaned,
};
