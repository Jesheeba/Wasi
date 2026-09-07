// Shared WABA-connection logic (PLAN.md item 25, 2026-09-07) — factored out
// of routes/onboarding.js so routes/admin.js's resolve-waba route (for the
// needs_manual_resolution state) can complete a connection identically
// instead of duplicating this logic. The only real difference between "a
// client connects directly" and "admin resolves an ambiguous discovery" is
// where waba_id/phone_number_id/accessToken came from, not what happens
// once they're known.
const wabasRepo = require('../repositories/wabasRepo');
const clientsRepo = require('../repositories/clientsRepo');
const metaClient = require('../utils/metaClient');
const templateSyncService = require('./templateSyncService');
const crypto = require('crypto');
const { encrypt } = require('../utils/encryption');

// Server-side WABA/phone discovery — the fallback for when Embedded
// Signup's postMessage didn't deliver waba_id and/or phone_number_id.
// Meta's debug_token response is "ground truth when the postMessage never
// arrived" (confirmed against Meta's own docs + an independently-
// corroborated integration guide, 2026-09-07), read via granular_scopes'
// whatsapp_business_management target_ids.
//
// This app's entire schema already assumes one meaningful WABA per client
// (wabasRepo.findByClientId takes the most recent) — if discovery resolves
// to exactly one WABA and exactly one phone number, that matches the
// popup-supplied case exactly. If more than one comes back for either, this
// deliberately does NOT guess: no real client investigated this session had
// more than one, and auto-picking "the first one" could silently connect
// the wrong number for a business that has more than one WhatsApp line —
// worse than surfacing it for manual resolution.
//
// knownWabaId is trusted as-is when the popup already supplied it (Meta's
// own docs suggest waba_id is far more reliably present than
// phone_number_id) — debug_token is only called when it's genuinely
// missing, not to cross-validate a value we already have.
async function discoverWabaAndPhoneNumber({ accessToken, knownWabaId }) {
  const diagnostics = { knownWabaId: knownWabaId || null };
  let wabaId = knownWabaId || null;

  if (!wabaId) {
    const debugData = await metaClient.debugToken(accessToken);
    const wabaScope = (debugData?.granular_scopes || []).find((s) => s.scope === 'whatsapp_business_management');
    const targetIds = wabaScope?.target_ids || [];
    diagnostics.wabaTargetIds = targetIds;

    if (targetIds.length === 0) {
      throw new Error('Meta returned no WhatsApp Business Account for this authorization — debug_token had no whatsapp_business_management scope with any target_ids.');
    }
    if (targetIds.length > 1) {
      // reason lives INSIDE diagnostics, not just as a sibling return field —
      // diagnostics is the only part of this result that actually gets
      // persisted (wabas.connect_diagnostics). A sibling-only reason would
      // be visible in the audit_log text but invisible to the admin UI
      // rendering this state later, which is exactly the "recorded but
      // nobody can see it" gap this item exists to close.
      diagnostics.reason = 'multiple_wabas';
      return { needsManualResolution: true, reason: 'multiple_wabas', diagnostics };
    }
    wabaId = targetIds[0];
  }

  const phoneNumbers = await metaClient.listPhoneNumbers(wabaId, accessToken);
  diagnostics.wabaId = wabaId;
  diagnostics.candidatePhoneNumbers = phoneNumbers.map((p) => ({
    id: p.id,
    display_phone_number: p.display_phone_number,
    is_on_biz_app: p.is_on_biz_app,
    platform_type: p.platform_type,
  }));

  if (phoneNumbers.length === 0) {
    throw new Error(`No phone numbers are registered under WhatsApp Business Account ${wabaId} yet.`);
  }
  if (phoneNumbers.length > 1) {
    // Added 2026-09-07 (see CLAUDE.md Known Gaps): a WABA with more than one
    // number used to always defer to manual resolution, even when exactly
    // one of them is unambiguously the Coexistence-connected one —
    // is_on_biz_app is Meta's own documented signal for "this number is
    // linked via the WhatsApp Business app." Only auto-resolves on a CLEAR
    // single match; zero or more than one still defers, same as before —
    // this must never guess between two genuinely ambiguous candidates
    // (see this function's own top comment on why guessing is worse than
    // surfacing it).
    const onBizApp = phoneNumbers.filter((p) => p.is_on_biz_app === true);
    if (onBizApp.length === 1) {
      diagnostics.autoResolvedVia = 'is_on_biz_app';
      return { wabaId, phoneNumberId: onBizApp[0].id, diagnostics };
    }
    diagnostics.reason = 'multiple_phone_numbers';
    return { needsManualResolution: true, reason: 'multiple_phone_numbers', wabaId, diagnostics };
  }

  return { wabaId, phoneNumberId: phoneNumbers[0].id, diagnostics };
}

// The shared tail of a successful connect — subscribe, conditionally
// register, fetch details, persist 'connected', sync templates, bump client
// status. `db` is whatever connection the caller has (req.db for the client
// route, the privileged pool for the admin route) — matches
// clientsRepo/templateSyncService's existing db-first-param convention,
// both already called with either today.
async function completeWabaConnection(db, clientId, { waba_id, phone_number_id, accessToken, via_coexistence }) {
  await metaClient.subscribeAppToWaba(waba_id, accessToken);

  // Coexistence-onboarded numbers are already registered on the WhatsApp
  // Business app on the owner's phone — calling register-with-PIN again
  // would re-register a number that's actively in use there. Plain
  // migration connects still need it: that's how an unregistered number
  // gets activated on the Cloud API in the first place. Same config_id
  // serves both flows now, so this must branch per-request, not be
  // skipped globally.
  if (!via_coexistence) {
    const pin = String(crypto.randomInt(100000, 999999));
    await metaClient.registerPhoneNumber(phone_number_id, accessToken, pin);
  }

  const details = await metaClient.getPhoneNumberDetails(phone_number_id, accessToken);

  const waba = await wabasRepo.upsertForClient(clientId, {
    waba_id,
    phone_number_id,
    display_name: details.verified_name || null,
    display_phone_number: details.display_phone_number || null,
    quality_rating: details.quality_rating || null,
    access_token_encrypted: encrypt(accessToken),
    verified_at: new Date().toISOString(),
    status: 'connected',
  });

  // Pulls in any templates that already exist on this WABA — Embedded
  // Signup connects an EXISTING number, it doesn't provision a fresh
  // one, so a client can easily already have approved templates on
  // Meta the moment they connect. Best-effort: a sync failure here
  // shouldn't fail the whole connect flow, since the WABA connection
  // itself already succeeded — see templateSyncService.js.
  let templateSync = { inserted: 0, updated: 0, orphaned: 0 };
  try {
    templateSync = await templateSyncService.syncTemplates(db, clientId);
  } catch (err) {
    console.error('wabaConnectionService: template sync after connect failed (non-fatal):', err.message);
  }

  const client = await clientsRepo.findById(db, clientId);
  if (client && client.status === 'payment_confirmed') {
    await clientsRepo.update(db, clientId, { status: 'active' });
  }

  return { waba, templateSync };
}

module.exports = { discoverWabaAndPhoneNumber, completeWabaConnection };
