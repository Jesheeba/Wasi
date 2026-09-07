const { Router } = require('express');
const { ZodError } = require('zod');
const multer = require('multer');
const clientsRepo = require('../repositories/clientsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const metaClient = require('../utils/metaClient');
const { discoverWabaAndPhoneNumber, completeWabaConnection } = require('../services/wabaConnectionService');
const { encrypt, decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { wabaConnectSchema, wabaConnectIncompleteSchema, businessProfileUpdateSchema } = require('../utils/validate');

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
    const accessToken = decrypt(waba.access_token_encrypted);
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
    const accessToken = decrypt(waba.access_token_encrypted);
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
    const accessToken = decrypt(waba.access_token_encrypted);
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
  // clientId comes from the JWT (requireClientAuth), never the body, so it's
  // always known even if req.body fails validation entirely — this is what
  // makes a guaranteed audit trail possible below regardless of what broke.
  const clientId = req.clientId;
  let waba_id, phone_number_id, code, via_coexistence;

  try {
    // wabaConnectSchema.parse used to run OUTSIDE this try, before ANY
    // write — found 2026-09-05: 4 real clients (a missing/malformed
    // phone_number_id or, in principle, any other required field) failed
    // with literally zero trace anywhere, because a Zod throw here
    // propagated straight past this whole route with no audit_log entry and
    // no wabas row ever written. Moving it inside the try/catch below is
    // the actual fix for "this class of failure must never be silent
    // again" — not just the phone_number_id case specifically, ANY
    // validation failure on this route now guarantees a write.
    ({ code, waba_id, phone_number_id, via_coexistence } = wabaConnectSchema.parse(req.body));

    // waba_id/phone_number_id can both be undefined here (see
    // wabaConnectSchema's comment) — `|| null` so a real DB null lands in
    // the column instead of pg rejecting an undefined bound parameter. This
    // write must succeed regardless of whether either showed up, so a
    // genuine attempt is never invisible even before discovery runs below.
    await wabasRepo.upsertForClient(clientId, {
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      status: 'connecting',
    });

    const shortLivedToken = await metaClient.exchangeCodeForToken(code);
    const accessToken = await metaClient.exchangeForLongLivedToken(shortLivedToken);

    // Server-side discovery (PLAN.md item 25, Part A) — only runs when the
    // popup didn't already supply both ids; when it did, this whole block
    // is skipped and behavior is byte-for-byte unchanged from before this
    // item. Wrapped so a discovery-mechanism failure itself (a transient
    // debug_token/phone_numbers error) falls back to the existing audited
    // failure below rather than becoming a new, different crash.
    if (!waba_id || !phone_number_id) {
      let discovery;
      try {
        discovery = await discoverWabaAndPhoneNumber({ accessToken, knownWabaId: waba_id });
      } catch (discoveryErr) {
        console.error('onboarding: server-side discovery failed (falling back to the existing failure path):', discoveryErr.message);
        discovery = null;
      }

      if (discovery?.needsManualResolution) {
        // Distinct status, not lumped into 'failed' — per your explicit
        // instruction, a recorded ambiguity nobody can see is the same
        // invisible-failure pattern already hit 4 times. Admin's Client
        // Detail page (see PLAN.md item 25 Part A) is what makes this
        // actually visible, not just present in the DB.
        //
        // The access token is persisted here too, encrypted — not just the
        // diagnostics. Without this, admin resolving the ambiguity later
        // would have nothing to complete the connection with, and the
        // client would need to redo signup anyway even though Meta already
        // linked something real. POST /clients/:id/resolve-waba (admin.js)
        // is what uses this token once a human picks the right candidate.
        await wabasRepo.upsertForClient(clientId, {
          waba_id: discovery.wabaId || waba_id || null,
          status: 'needs_manual_resolution',
          // Explicit JSON.stringify — pg does NOT auto-serialize a raw JS
          // object/array for a jsonb column, it applies Postgres-array-
          // literal serialization instead, which Postgres then rejects as
          // invalid JSON. This exact mistake (documented in CLAUDE.md) once
          // wiped the production template-library cache; not repeating it here.
          connect_diagnostics: JSON.stringify(discovery.diagnostics),
          access_token_encrypted: encrypt(accessToken),
        });
        await auditLogRepo.record({
          actor_type: 'client',
          actor_id: clientId,
          action: 'whatsapp_connect_needs_manual_resolution',
          target: `${clientId}: ${discovery.reason} — ${JSON.stringify(discovery.diagnostics)}`,
        });
        return res.status(409).json({
          error: 'Your Meta Business account has more than one WhatsApp number or account, and we could not tell which one to connect automatically.',
          detail: 'Our support team has been notified and will help you finish connecting the right one. No further action is needed from you right now.',
          code: 'needs_manual_resolution',
        });
      }

      if (discovery) {
        waba_id = discovery.wabaId || waba_id;
        phone_number_id = discovery.phoneNumberId || phone_number_id;
      }
    }

    // Found 2026-09-05, widened 2026-09-07 once discovery above was built:
    // failing here — inside the try, so it hits the same catch block as
    // every other connect failure — means this still gets a real
    // wabas.status='failed' row, a real whatsapp_connect_failed audit_log
    // entry with this exact message, and a specific 502 back to the client,
    // instead of ever silently rejecting before the first write the way the
    // old pre-write Zod validation used to.
    if (!waba_id || !phone_number_id) {
      throw new Error(
        `WhatsApp signup finished on Facebook's side, but Meta never sent a ${!waba_id ? 'WhatsApp Business Account' : 'phone number'} ID, and server-side discovery could not resolve it either (waba_id: ${waba_id || 'unknown'}). ` +
        'This can happen on a Coexistence (QR code) connection — please try connecting again. If it keeps happening, contact support with this exact message.'
      );
    }

    const { waba, templateSync } = await completeWabaConnection(req.db, clientId, {
      waba_id, phone_number_id, accessToken, via_coexistence,
    });

    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: clientId,
      action: 'whatsapp_connected',
      target: clientId,
    });

    const { access_token_encrypted, ...safeWaba } = waba;
    res.json({ connected: true, waba: safeWaba, templateSync });
  } catch (err) {
    // Guaranteed trail for EVERY failure this route can produce, including
    // one that happens before waba_id/phone_number_id are even known (a Zod
    // validation failure) — this is the direct fix for "4 clients failed
    // with zero trace," not scoped to the phone_number_id case alone. Zod's
    // own .message is a raw JSON dump of .issues; formatted here into
    // something a human reads in the audit log without decoding it.
    const isValidationError = err instanceof ZodError;
    const message = isValidationError
      ? `Invalid request: ${err.issues.map((i) => `${i.path.join('.') || '(body)'} — ${i.message}`).join('; ')}`
      : err.message;

    // Best-effort, deliberately never allowed to throw past this point — a
    // request that failed validation may never have reached the first
    // upsertForClient call above, so this could be inserting the very first
    // wabas row for this client (upsertForClient handles that fine, scoped
    // by clientId alone: client_id + status, everything else left null).
    // Swallowing a failure here must never suppress the audit_log write
    // below it, which is the actual guarantee this fix is about.
    await wabasRepo.upsertForClient(clientId, { status: 'failed' }).catch((e) => {
      console.error('onboarding: failed to record wabas status=failed after a connect failure (non-fatal, audit log write still proceeds):', e.message);
    });

    await auditLogRepo.record({
      actor_type: 'client',
      actor_id: clientId,
      action: 'whatsapp_connect_failed',
      target: `${clientId}: ${message}`,
    });
    res.status(isValidationError ? 400 : 502).json({
      error: 'WhatsApp connection failed',
      detail: message,
      hint: isValidationError ? undefined : 'This usually means META_APP_ID/META_APP_SECRET/META_CONFIG_ID are not configured for a real Meta app yet.',
    });
  }
}));

// PLAN.md item 25, Part B — records the "Meta linked it, we never got the
// code" state embeddedSignup.js's connect() now distinguishes (see that
// file's incompleteErr handling). Deliberately takes no `code` field at
// all — there isn't one to send, and none is accepted, so this route is
// structurally impossible to confuse with a real connect attempt. Nothing
// downstream of this (token exchange, WABA subscription, phone
// registration) can run without a code, so this can only ever record the
// state, never complete a connection.
router.post('/whatsapp/connect-incomplete', asyncHandler(async (req, res) => {
  const clientId = req.clientId;
  const { waba_id } = wabaConnectIncompleteSchema.parse(req.body);

  await wabasRepo.upsertForClient(clientId, {
    waba_id,
    status: 'incomplete_meta_linked',
  });
  await auditLogRepo.record({
    actor_type: 'client',
    actor_id: clientId,
    action: 'whatsapp_connect_incomplete',
    target: `${clientId}: waba_id ${waba_id}`,
  });
  res.json({ recorded: true });
}));

module.exports = router;
