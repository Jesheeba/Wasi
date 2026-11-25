// Records a marketing opt-in/opt-out that arrives through the Hub API
// (build-docs/features/marketing-consent-attestation.md): either
// POST /api/v1/contacts/consent or the optIn field on POST /api/v1/messages.
// Goes through consentRepo.recordEvent, so the status change and its
// evidence are written together and opt-out stays sticky - an opt-in for an
// opted-out contact throws consentRepo.ConsentBlockedError, which callers
// turn into a 409 contact_opted_out.
const consentRepo = require('../repositories/consentRepo');
const { CONSENT_STATEMENT } = require('../utils/consentStatement');

async function recordHubApiConsent(clientId, contactId, { status, method, note, apiKeyId }) {
  const evidence = status === 'opted_in'
    ? { statement: CONSENT_STATEMENT, method, note: note || null, source: 'hub_api' }
    : { note: note || null, source: 'hub_api' };
  return consentRepo.recordEvent(clientId, contactId, {
    event: status,
    source: 'hub_api',
    evidence,
    actorType: 'api_key',
    actorId: apiKeyId || null,
  });
}

module.exports = { recordHubApiConsent };
