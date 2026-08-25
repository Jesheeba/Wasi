// Pulls a WABA's real template list from Meta and reconciles it against
// this app's local message_templates rows. Without this, a client whose
// WABA already has approved templates (Embedded Signup connects an
// EXISTING number, it doesn't provision a fresh one) sees an empty
// template list in Wasi despite having working, sendable templates —
// every new client's first impression would be "nothing here."
//
// reconcileTemplates is kept pure — no DB, no network — same reasoning
// templateParams.js documents for staying separate from metaClient.js:
// testable with plain JS objects (server/test/templateSync.test.js),
// not a real Meta App or Postgres.
const wabasRepo = require('../repositories/wabasRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

class TemplateSyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const CATEGORY_MAP = { UTILITY: 'Utility', MARKETING: 'Marketing', AUTHENTICATION: 'Authentication' };

// Meta returns categories uppercase; local schema/zod enum uses
// title-case (buildTemplateCreatePayload's category.toUpperCase(), in
// reverse). Falls back to the raw value for anything unrecognized rather
// than dropping it, in case Meta ever adds a category this map doesn't
// know about yet.
function mapMetaCategory(metaCategory) {
  return CATEGORY_MAP[String(metaCategory || '').toUpperCase()] || metaCategory;
}

// Meta's status vocabulary (APPROVED, PENDING, REJECTED, PAUSED, DISABLED,
// IN_APPEAL, PENDING_DELETION) already uses underscores matching this
// app's lowercase snake_case convention (migration
// 016_widen_template_status_vocabulary.js) — a plain lowercase is enough,
// no translation table needed.
function mapMetaStatus(metaStatus) {
  return String(metaStatus || 'pending').toLowerCase();
}

// Confirmed live against the real WABA: Meta's `rejected_reason` field on
// a non-rejected template isn't absent or null — it's the literal string
// "NONE". Treated as no reason, not stored as text.
function mapRejectionReason(rejectedReason) {
  return rejectedReason && rejectedReason !== 'NONE' ? rejectedReason : null;
}

// Matching: prefer meta_template_id (unambiguous) when the local row has
// one; fall back to name (unique per WABA — Meta enforces this, and it's
// how every local row created before this sync existed can still be
// found) for rows with no stored id yet. A match via name backfills the
// id (see messageTemplatesRepo.updateFromMetaSync).
//
// Orphan detection only considers local rows that HAVE a meta_template_id
// — i.e. were confirmed to exist on Meta at some point. A row with none
// is a local draft that was never submitted; it was never "on Meta" to
// begin with, so it can't be missing from anything, and reconcile must
// never touch it. Already-orphaned rows aren't re-flagged (orphaned_at
// stays as the original detection time, not refreshed every sync).
function reconcileTemplates(metaTemplates, localTemplates) {
  const localByMetaId = new Map();
  const localByName = new Map();
  for (const t of localTemplates) {
    if (t.meta_template_id) localByMetaId.set(t.meta_template_id, t);
    localByName.set(t.name, t);
  }

  const toInsert = [];
  const toUpdate = [];
  const matchedLocalIds = new Set();

  for (const mt of metaTemplates || []) {
    const local = localByMetaId.get(mt.id) || localByName.get(mt.name);
    const parsed = metaClient.parseTemplateComponents(mt.components);

    if (local) {
      matchedLocalIds.add(local.id);
      toUpdate.push({
        localId: local.id,
        status: mapMetaStatus(mt.status),
        category: mapMetaCategory(mt.category),
        rejection_reason: mapRejectionReason(mt.rejected_reason),
        meta_template_id: mt.id,
      });
    } else {
      toInsert.push({
        meta_template_id: mt.id,
        name: mt.name,
        category: mapMetaCategory(mt.category),
        status: mapMetaStatus(mt.status),
        language: mt.language || 'en_US',
        rejection_reason: mapRejectionReason(mt.rejected_reason),
        ...parsed,
      });
    }
  }

  const toOrphan = localTemplates
    .filter((t) => t.meta_template_id && !matchedLocalIds.has(t.id) && !t.orphaned_at)
    .map((t) => t.id);

  return { toInsert, toUpdate, toOrphan };
}

// The actual sync: fetch both sides, reconcile, write. `db` is the
// caller's connection (req.db under a client-authenticated request, same
// convention messagingService.js etc. use) — wabasRepo always uses the
// privileged pool internally regardless (access_token_encrypted is
// revoked from the restricted role at the column level, see wabasRepo.js).
async function syncTemplates(db, clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    throw new TemplateSyncError('No connected WhatsApp Business number for this account.', 'waba_not_connected');
  }

  const accessToken = await decrypt(waba.access_token_encrypted);
  const [metaTemplates, localTemplates] = await Promise.all([
    metaClient.listTemplates(waba.waba_id, accessToken),
    messageTemplatesRepo.listByClientId(db, clientId),
  ]);

  const { toInsert, toUpdate, toOrphan } = reconcileTemplates(metaTemplates, localTemplates);

  for (const t of toInsert) {
    await messageTemplatesRepo.createFromMetaSync(db, { client_id: clientId, ...t });
  }
  for (const t of toUpdate) {
    const { localId, ...fields } = t;
    await messageTemplatesRepo.updateFromMetaSync(db, localId, fields);
  }
  for (const id of toOrphan) {
    await messageTemplatesRepo.markOrphaned(db, id);
  }

  return { inserted: toInsert.length, updated: toUpdate.length, orphaned: toOrphan.length };
}

module.exports = { syncTemplates, reconcileTemplates, mapMetaCategory, mapMetaStatus, TemplateSyncError };
