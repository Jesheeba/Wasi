// Settings > Marketing consent (build-docs/features/marketing-consent-
// attestation.md). Mounted behind requireClientOrTeamAuth +
// requireActiveSubscription + withTenantContext. Anyone may read the state;
// only the Owner or an Admin may attest or withdraw, because it binds the
// business legally (same rule as the AI assistant's data-processing consent).
const { Router } = require('express');
const { z } = require('zod');
const marketingConsentRepo = require('../repositories/marketingConsentRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const { ACCOUNT_CONSENT_VERSION, ACCOUNT_CONSENT_STATEMENT } = require('../utils/consentStatement');

const router = Router();

async function view(req) {
  const current = await marketingConsentRepo.getCurrent(req.db, req.clientId);
  const { rows } = await req.db.query(
    `select count(*) filter (where opt_in_status = 'opted_in')::int as opted_in,
            count(*) filter (where opt_in_status = 'opted_out')::int as opted_out,
            count(*) filter (where opt_in_status is null or opt_in_status = 'unknown')::int as unknown
       from contacts where client_id = $1`,
    [req.clientId]
  );
  return {
    attested: current?.event === 'attested',
    current,
    statement: { version: ACCOUNT_CONSENT_VERSION, text: ACCOUNT_CONSENT_STATEMENT },
    contacts: rows[0],
  };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await view(req));
}));

router.post('/', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { attested } = z.object({ attested: z.boolean() }).strict().parse(req.body);
  await marketingConsentRepo.record(req.db, req.clientId, {
    event: attested ? 'attested' : 'withdrawn',
    statementVersion: ACCOUNT_CONSENT_VERSION,
    statementText: ACCOUNT_CONSENT_STATEMENT,
    actorType: req.actorType,
    actorId: req.actorType === 'team_member' ? req.actorId : null,
  });
  await auditLogRepo.record({
    actor_type: 'client', actor_id: req.clientId,
    action: attested ? 'marketing_consent_attested' : 'marketing_consent_withdrawn',
    target: `${req.clientId}: ${req.actorType}${req.actorType === 'team_member' ? ` ${req.actorId}` : ''}, statement ${ACCOUNT_CONSENT_VERSION}`,
  });
  res.json(await view(req));
}));

module.exports = router;
