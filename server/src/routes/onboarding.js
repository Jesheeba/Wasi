const { Router } = require('express');
const crypto = require('crypto');
const clientsRepo = require('../repositories/clientsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const metaClient = require('../utils/metaClient');
const templateSyncService = require('../services/templateSyncService');
const { encrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { wabaConnectSchema } = require('../utils/validate');

const router = Router();

// Public-ish IDs the frontend needs to call FB.login() for Embedded Signup.
// Not secrets — safe to expose to an authenticated client.
router.get('/config', (req, res) => {
  res.json({
    appId: process.env.META_APP_ID || null,
    configId: process.env.META_CONFIG_ID || null,
    configured: Boolean(process.env.META_APP_ID && process.env.META_CONFIG_ID),
  });
});

router.get('/whatsapp/status', asyncHandler(async (req, res) => {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba) return res.json({ connected: false });
  const { access_token_encrypted, ...safe } = waba;
  res.json({ connected: safe.status === 'connected', waba: safe });
}));

// Runs spec §3 steps 3-5: token exchange, webhook subscription, phone number
// registration, default template creation. All of it degrades to a clear error
// (not a crash) when META_APP_ID/SECRET aren't configured for this environment.
router.post('/whatsapp/connect', asyncHandler(async (req, res) => {
  const { code, waba_id, phone_number_id, via_coexistence } = wabaConnectSchema.parse(req.body);
  const clientId = req.clientId;

  await wabasRepo.upsertForClient(clientId, {
    waba_id,
    phone_number_id,
    status: 'connecting',
  });

  try {
    const shortLivedToken = await metaClient.exchangeCodeForToken(code);
    const accessToken = await metaClient.exchangeForLongLivedToken(shortLivedToken);
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
    //
    // This replaces the old auto-created "welcome_message" stub, which
    // used {{1}} (numbered params — this app's own validator rejects that
    // format) and was never actually submitted to Meta at all, so every
    // new client got a permanently pending template that went nowhere.
    let templateSync = { inserted: 0, updated: 0, orphaned: 0 };
    try {
      templateSync = await templateSyncService.syncTemplates(req.db, clientId);
    } catch (err) {
      console.error('onboarding: template sync after connect failed (non-fatal):', err.message);
    }

    const client = await clientsRepo.findById(req.db, clientId);
    if (client && client.status === 'payment_confirmed') {
      await clientsRepo.update(req.db, clientId, { status: 'active' });
    }

    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: clientId,
      action: 'whatsapp_connected',
      target: clientId,
    });

    const { access_token_encrypted, ...safeWaba } = waba;
    res.json({ connected: true, waba: safeWaba, templateSync });
  } catch (err) {
    await wabasRepo.upsertForClient(clientId, { status: 'failed' });
    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: clientId,
      action: 'whatsapp_connect_failed',
      target: `${clientId}: ${err.message}`,
    });
    res.status(502).json({
      error: 'WhatsApp connection failed',
      detail: err.message,
      hint: 'This usually means META_APP_ID/META_APP_SECRET/META_CONFIG_ID are not configured for a real Meta app yet.',
    });
  }
}));

module.exports = router;
