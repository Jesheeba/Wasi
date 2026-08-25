const { Router } = require('express');
const crypto = require('crypto');
const multer = require('multer');
const clientsRepo = require('../repositories/clientsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const metaClient = require('../utils/metaClient');
const templateSyncService = require('../services/templateSyncService');
const { encrypt, decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { wabaConnectSchema, businessProfileUpdateSchema } = require('../utils/validate');
const logger = require('../utils/logger');

const router = Router();

// Memory storage, not disk — a profile picture is small (5MB cap enforced
// below, well under Node's default heap headroom) and this is a one-shot
// forward-to-Meta, not something that needs to persist on our own disk
// afterward.
const PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_PICTURE_MIME_TYPES = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png' };
const uploadProfilePicture = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROFILE_PICTURE_MAX_BYTES },
});

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

// Fetched live from Meta on every call, not cached in wabas, since this is
// data Meta already owns and a client edits directly in WhatsApp Manager as
// well as here; caching it would just be another way to show stale state
// (same bug class as the Templates/Contacts staleness fix earlier).
router.get('/whatsapp/business-profile', asyncHandler(async (req, res) => {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    return res.json({ connected: false });
  }
  try {
    const accessToken = await decrypt(waba.access_token_encrypted);
    const data = await metaClient.getBusinessProfile(waba.phone_number_id, accessToken);
    // Meta wraps the single profile object in a "data" array (one element,
    // always — a WABA phone number has exactly one business profile).
    const profile = data?.data?.[0] || null;
    res.json({ connected: true, profile });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch business profile', detail: err.message });
  }
}));

// Partial update. businessProfileUpdateSchema makes every field optional and
// has no profile_picture_handle field at all (that's the separate endpoint
// below) — so whatever survives req.body validation is exactly, and only,
// what the caller wants changed. Trimmed again + blank keys dropped here as
// a server-side backstop even though the frontend is expected to have
// already computed this same diff — this route is the last thing standing
// between a stray empty string and overwriting real data on a live profile.
router.post('/whatsapp/business-profile', asyncHandler(async (req, res) => {
  const parsed = businessProfileUpdateSchema.parse(req.body);
  const fields = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      if (value.length) fields[key] = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) fields[key] = trimmed;
    } else if (value !== undefined) {
      fields[key] = value;
    }
  }

  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    return res.status(400).json({ error: 'No connected WhatsApp number for this client' });
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const accessToken = await decrypt(waba.access_token_encrypted);
    await metaClient.updateBusinessProfile(waba.phone_number_id, accessToken, fields);
    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: req.clientId,
      action: 'business_profile_updated',
      target: `${req.clientId}: ${Object.keys(fields).join(', ')}`,
    });
    res.json({ updated: true, fields: Object.keys(fields) });
  } catch (err) {
    res.status(502).json({ error: 'Could not update business profile', detail: err.message });
  }
}));

// Replace the profile picture — a single action from the caller's
// perspective (pick a file, it's live), but internally: upload the bytes
// via Meta's Resumable Upload API to get a handle, then immediately set
// that handle as the profile's picture. Deliberately its own endpoint, not
// a field on the POST above — that's what makes "never send
// profile_picture_handle unless a new file was actually chosen" true by
// construction rather than by convention.
router.post('/whatsapp/business-profile/picture', uploadProfilePicture.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mimeType = PROFILE_PICTURE_MIME_TYPES[req.file.mimetype];
  if (!mimeType) {
    return res.status(400).json({ error: 'Unsupported file type', detail: 'Only JPEG or PNG images are accepted.' });
  }

  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    return res.status(400).json({ error: 'No connected WhatsApp number for this client' });
  }
  if (!process.env.META_APP_ID) {
    return res.status(502).json({ error: 'META_APP_ID is not configured for this environment' });
  }

  try {
    const accessToken = await decrypt(waba.access_token_encrypted);
    const session = await metaClient.createUploadSession(process.env.META_APP_ID, accessToken, {
      fileName: req.file.originalname || 'profile-picture',
      fileLength: req.file.size,
      fileType: mimeType,
    });
    const uploaded = await metaClient.uploadFileBytes(session.id, accessToken, req.file.buffer);
    if (!uploaded.h) {
      throw new Error('Meta did not return an upload handle');
    }
    await metaClient.updateBusinessProfile(waba.phone_number_id, accessToken, { profile_picture_handle: uploaded.h });
    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: req.clientId,
      action: 'business_profile_picture_updated',
      target: req.clientId,
    });
    res.json({ updated: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not update profile picture', detail: err.message });
  }
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
      display_phone_number: details.display_phone_number || null,
      quality_rating: details.quality_rating || null,
      access_token_encrypted: await encrypt(accessToken),
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
      logger.error({ err, clientId }, 'onboarding: template sync after connect failed (non-fatal)');
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
