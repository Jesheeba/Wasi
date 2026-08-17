const { Router } = require('express');
const crypto = require('crypto');
const clientsRepo = require('../repositories/clientsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const metaClient = require('../utils/metaClient');
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
  const { code, waba_id, phone_number_id } = wabaConnectSchema.parse(req.body);
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

    const pin = String(crypto.randomInt(100000, 999999));
    await metaClient.registerPhoneNumber(phone_number_id, accessToken, pin);

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

    const existingTemplates = await messageTemplatesRepo.listByClientId(clientId);
    if (existingTemplates.length === 0) {
      await messageTemplatesRepo.create({
        client_id: clientId,
        name: 'welcome_message',
        category: 'Utility',
        status: 'pending',
        body: 'Hi {{1}}, thanks for connecting with us on WhatsApp! How can we help today?',
      });
    }

    const client = await clientsRepo.findById(clientId);
    if (client && client.status === 'payment_confirmed') {
      await clientsRepo.update(clientId, { status: 'active' });
    }

    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: clientId,
      action: 'whatsapp_connected',
      target: clientId,
    });

    const { access_token_encrypted, ...safeWaba } = waba;
    res.json({ connected: true, waba: safeWaba });
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
