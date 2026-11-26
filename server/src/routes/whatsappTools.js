// WhatsApp account tools (build-docs/features/whatsapp-quick-wins.md):
// QR codes / short links, ice breakers + commands + welcome message, and the
// green tick (Official Business Account) application. Admin/Manager only.
// Settings that Meta owns are read live from Meta, not cached.
const { Router } = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { pool } = require('../db/pool');
const auditLogRepo = require('../repositories/auditLogRepo');

const router = Router();
router.use(requireRole('Admin', 'Manager'));

const noEmoji = (v) => !/\p{Extended_Pictographic}/u.test(v);

async function conn(req, res) {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    res.status(409).json({ error: 'Connect your WhatsApp number first.' });
    return null;
  }
  return { waba, token: decrypt(waba.access_token_encrypted) };
}

function metaFailure(res, err, fallback) {
  const m = err.metaError;
  const detail = m && (m.error_user_title || m.error_user_msg) ? [m.error_user_title, m.error_user_msg].filter(Boolean).join(' - ') : err.message;
  return res.status(502).json({ error: fallback, detail });
}

// ---------- QR codes ----------
const qrMessage = z.string().trim().min(1, 'Enter the message the customer will send').max(140, 'Messages can be 140 characters at most');

router.get('/qr-codes', asyncHandler(async (req, res) => {
  const { rows } = await req.db.query(
    'select id, code, prefilled_message, deep_link_url, qr_image_url, created_at from whatsapp_qr_codes where client_id = $1 order by created_at desc',
    [req.clientId]
  );
  res.json(rows);
}));

router.post('/qr-codes', asyncHandler(async (req, res) => {
  const message = qrMessage.parse(req.body?.message);
  const c = await conn(req, res);
  if (!c) return;
  let created;
  try {
    created = await metaClient.createQrCode(c.waba.phone_number_id, c.token, message);
  } catch (err) {
    return metaFailure(res, err, 'WhatsApp did not create the QR code');
  }
  const { rows } = await req.db.query(
    `insert into whatsapp_qr_codes (client_id, code, prefilled_message, deep_link_url, qr_image_url)
     values ($1, $2, $3, $4, $5) returning id, code, prefilled_message, deep_link_url, qr_image_url, created_at`,
    [req.clientId, created.code, created.prefilled_message || message, created.deep_link_url, created.qr_image_url || null]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/qr-codes/:code', asyncHandler(async (req, res) => {
  const message = qrMessage.parse(req.body?.message);
  const c = await conn(req, res);
  if (!c) return;
  try {
    await metaClient.updateQrCode(c.waba.phone_number_id, c.token, req.params.code, message);
  } catch (err) {
    return metaFailure(res, err, 'WhatsApp did not update the QR code');
  }
  const { rows } = await req.db.query(
    `update whatsapp_qr_codes set prefilled_message = $3, updated_at = now() where client_id = $1 and code = $2
     returning id, code, prefilled_message, deep_link_url, qr_image_url, created_at`,
    [req.clientId, req.params.code, message]
  );
  if (!rows[0]) return res.status(404).json({ error: 'QR code not found' });
  res.json(rows[0]);
}));

router.delete('/qr-codes/:code', asyncHandler(async (req, res) => {
  const c = await conn(req, res);
  if (!c) return;
  try {
    await metaClient.deleteQrCode(c.waba.phone_number_id, c.token, req.params.code);
  } catch (err) {
    // Already removed in WhatsApp Manager: remove our copy too.
    if (!/does not exist|not found|invalid parameter/i.test(err.message)) return metaFailure(res, err, 'WhatsApp did not delete the QR code');
  }
  await req.db.query('delete from whatsapp_qr_codes where client_id = $1 and code = $2', [req.clientId, req.params.code]);
  res.status(204).send();
}));

// ---------- Ice breakers, commands, welcome message ----------
const automationSchema = z.object({
  enableWelcomeMessage: z.boolean(),
  prompts: z.array(z.string().trim().min(1).max(80, 'Ice breakers can be 80 characters at most').refine(noEmoji, 'Ice breakers cannot contain emoji'))
    .max(4, 'Up to 4 ice breakers'),
  commands: z.array(z.object({
    name: z.string().trim().transform((v) => v.replace(/^\//, ''))
      .pipe(z.string().min(1).max(32, 'Command names can be 32 characters at most').regex(/^[a-z0-9_]+$/i, 'Command names can use letters, numbers and _ only')),
    description: z.string().trim().min(1).max(256, 'Descriptions can be 256 characters at most').refine(noEmoji, 'Descriptions cannot contain emoji'),
  })).max(30, 'Up to 30 commands'),
});

router.get('/conversational-automation', asyncHandler(async (req, res) => {
  const c = await conn(req, res);
  if (!c) return;
  try {
    const a = await metaClient.getConversationalAutomation(c.waba.phone_number_id, c.token);
    res.json({
      enableWelcomeMessage: Boolean(a.enable_welcome_message),
      prompts: a.prompts || [],
      commands: (a.commands || []).map((x) => ({ name: x.command_name, description: x.command_description })),
    });
  } catch (err) {
    metaFailure(res, err, 'Could not load these settings from WhatsApp');
  }
}));

router.put('/conversational-automation', asyncHandler(async (req, res) => {
  const input = automationSchema.parse(req.body);
  const names = input.commands.map((x) => x.name.toLowerCase());
  if (new Set(names).size !== names.length) return res.status(400).json({ error: 'Each command name can only be used once.' });
  const c = await conn(req, res);
  if (!c) return;
  try {
    await metaClient.setConversationalAutomation(c.waba.phone_number_id, c.token, {
      enableWelcomeMessage: input.enableWelcomeMessage,
      prompts: input.prompts,
      commands: input.commands.map((x) => ({ command_name: x.name, command_description: x.description })),
    });
  } catch (err) {
    return metaFailure(res, err, 'WhatsApp did not save these settings');
  }
  res.json(input);
}));

// ---------- Marketing message activity sharing (marketing-messages-api.md) ----------
// Whether Meta may use delivery/read/click data from this client's Marketing
// messages sent via the Marketing Messages API. Read: Admin/Manager (router
// gate). Change: Owner/Admin only - a data-sharing decision for the business.
async function mmSharingState(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  const { rows: [last] } = await pool.query(
    `select action, actor_type, created_at from audit_log
     where action in ('mm_activity_sharing_on', 'mm_activity_sharing_off') and target like $1
     order by created_at desc limit 1`,
    [`${clientId}:%`]
  );
  return {
    connected: Boolean(waba),
    enabled: waba?.mm_activity_sharing === true,
    mmApiOn: waba?.mm_api_enabled === true,
    changedAt: last?.created_at || null,
    changedBy: last ? (last.actor_type === 'team_member' ? 'a team member' : 'the account owner') : null,
  };
}

router.get('/mm-activity-sharing', asyncHandler(async (req, res) => {
  res.json(await mmSharingState(req.clientId));
}));

router.put('/mm-activity-sharing', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  await pool.query('update wabas set mm_activity_sharing = $1 where id = $2', [enabled, waba.id]);
  await auditLogRepo.record({
    actor_type: req.actorType === 'team_member' ? 'team_member' : 'client',
    actor_id: req.actorType === 'team_member' ? req.actorId : req.clientId,
    action: enabled ? 'mm_activity_sharing_on' : 'mm_activity_sharing_off',
    target: `${req.clientId}: waba ${waba.waba_id}`,
  });
  res.json(await mmSharingState(req.clientId));
}));

// ---------- Green tick ----------
router.get('/green-tick', asyncHandler(async (req, res) => {
  const c = await conn(req, res);
  if (!c) return;
  const onBusinessApp = c.waba.registration_is_on_biz_app === true;
  if (onBusinessApp) return res.json({ eligible: false, reason: 'business_app', status: null });
  try {
    const oba = await metaClient.getOfficialBusinessAccount(c.waba.phone_number_id, c.token);
    res.json({ eligible: true, status: oba.oba_status || 'NOT_STARTED' });
  } catch (err) {
    metaFailure(res, err, 'Could not load the green tick status from WhatsApp');
  }
}));

const httpsUrl = z.string().trim().url('Enter a full web address').refine((v) => /^https?:\/\//i.test(v), 'Use a web address starting with https://');
const obaSchema = z.object({
  websiteUrl: httpsUrl,
  country: z.string().trim().min(2).max(60),
  language: z.string().trim().max(40).optional().default(''),
  parentBrand: z.string().trim().max(200).optional().default(''),
  supportingLinks: z.array(httpsUrl).min(5, 'Add at least 5 links about your business (news, social pages, reviews)').max(10, 'Up to 10 links'),
  notes: z.string().trim().max(1000).optional().default(''),
});

router.post('/green-tick', asyncHandler(async (req, res) => {
  const input = obaSchema.parse(req.body);
  const c = await conn(req, res);
  if (!c) return;
  if (c.waba.registration_is_on_biz_app === true) {
    return res.status(409).json({ error: 'Numbers that also use the WhatsApp Business app can\'t apply for the green tick. Meta Verified (in the app) is the option for them.' });
  }
  const fields = {
    business_website_url: input.websiteUrl,
    primary_country_of_operation: input.country,
    supporting_links: input.supportingLinks,
    ...(input.language ? { primary_language: input.language } : {}),
    ...(input.parentBrand ? { parent_business_or_brand: input.parentBrand } : {}),
    ...(input.notes ? { additional_supporting_information: input.notes } : {}),
  };
  try {
    const result = await metaClient.applyOfficialBusinessAccount(c.waba.phone_number_id, c.token, fields);
    res.json({ submitted: true, status: result.updated_status?.oba_status || 'PENDING', message: result.message || null });
  } catch (err) {
    metaFailure(res, err, 'WhatsApp did not accept the application');
  }
}));

module.exports = router;
