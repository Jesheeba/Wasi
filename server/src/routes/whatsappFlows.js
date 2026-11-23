// WhatsApp Flows ("Forms") - build-docs/features/whatsapp-flows.md.
// Lifecycle on Meta: create as DRAFT (JSON inline) -> optional edits (DRAFT
// only) -> publish -> deprecate. A published flow can't be edited or deleted
// on Meta, so "edit" of a published form is a duplicate. Static flows only.
const { Router } = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const whatsappFlowsRepo = require('../repositories/whatsappFlowsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { encrypt, decrypt } = require('../utils/encryption');
const liveBooking = require('../utils/flowLiveBooking');
const tpl = require('../utils/whatsappFlowTemplates');

const router = Router();
const manage = requireRole('Admin', 'Manager');

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['lead', 'booking', 'survey', 'booking_live']),
  config: z.record(z.any()).optional(),
});
const updateSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), config: z.record(z.any()).optional() });
function metaFailure(res, err, fallback) {
  const meta = err.metaError;
  const detail = meta && (meta.error_user_title || meta.error_user_msg)
    ? [meta.error_user_title, meta.error_user_msg].filter(Boolean).join(' - ')
    : err.message;
  return res.status(502).json({ error: fallback, detail, metaError: meta || null });
}

function validationText(errors) {
  if (!Array.isArray(errors) || !errors.length) return null;
  return errors.map((e) => e.message || e.error).filter(Boolean).join('; ').slice(0, 1000);
}

async function wabaWithToken(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) return null;
  return { waba, token: decrypt(waba.access_token_encrypted) };
}

// Live forms (booking_live): Meta encrypts calls to Wasi's endpoint with a
// per-number RSA key. Created and uploaded once, the first time it's needed;
// the private half is stored encrypted. The endpoint URL must be public https.
async function ensureLiveFormSetup(conn) {
  const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('This Wasi server has no public https address (APP_URL), so WhatsApp cannot reach live forms.');
  if (!conn.waba.flows_private_key_encrypted) {
    const { publicKey, privateKey } = liveBooking.generateKeyPair();
    await metaClient.uploadFlowsPublicKey(conn.waba.phone_number_id, conn.token, publicKey);
    await wabasRepo.setFlowsKey(conn.waba.id, encrypt(privateKey));
  }
  return base;
}

const shape = (f) => ({ ...f, kindLabel: tpl.KINDS[f.kind]?.label, screen: tpl.KINDS[f.kind]?.screen });

router.get('/kinds', (req, res) => {
  res.json(Object.entries(tpl.KINDS).map(([kind, k]) => ({ kind, label: k.label, defaults: k.defaults })));
});

router.get('/', asyncHandler(async (req, res) => {
  const flows = await whatsappFlowsRepo.list(req.db, req.clientId);
  res.json(flows.map(shape));
}));

// Creates the local row, then the DRAFT on Meta. Shared by create and duplicate.
async function createForm(req, res, input) {
  const { config, errors } = tpl.normalizeConfig(input.kind, input.config);
  if (errors.length) return res.status(400).json({ error: 'Fix the form fields first', details: errors });
  const conn = await wabaWithToken(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number before creating forms.' });

  const flow = await whatsappFlowsRepo.create(req.db, req.clientId, { name: input.name, kind: input.kind, config });
  const flowJson = tpl.buildFlowJson(input.kind, config);
  try {
    const endpointUri = tpl.KINDS[input.kind].endpoint ? `${await ensureLiveFormSetup(conn)}/webhooks/flows/${flow.id}` : undefined;
    const created = await metaClient.createFlow(conn.waba.waba_id, conn.token, {
      name: input.name, categories: [tpl.KINDS[input.kind].category], flowJson, endpointUri,
    });
    const saved = await whatsappFlowsRepo.update(req.db, req.clientId, flow.id, {
      meta_flow_id: created.id, flow_json: flowJson, status: 'draft', last_error: validationText(created.validation_errors),
    });
    return res.status(201).json(shape(saved));
  } catch (err) {
    await whatsappFlowsRepo.update(req.db, req.clientId, flow.id, { flow_json: flowJson, last_error: err.message });
    return metaFailure(res, err, 'Meta did not accept the form');
  }
}

router.post('/', manage, asyncHandler(async (req, res) => createForm(req, res, createSchema.parse(req.body))));

router.put('/:id', manage, asyncHandler(async (req, res) => {
  const input = updateSchema.parse(req.body);
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  if (flow.status !== 'draft') {
    return res.status(409).json({ error: 'A published form can\'t be changed on WhatsApp. Duplicate it and publish the copy instead.' });
  }
  const { config, errors } = tpl.normalizeConfig(flow.kind, input.config ?? flow.config);
  if (errors.length) return res.status(400).json({ error: 'Fix the form fields first', details: errors });
  const flowJson = tpl.buildFlowJson(flow.kind, config);
  const fields = { config, flow_json: flowJson, ...(input.name ? { name: input.name } : {}) };
  if (flow.meta_flow_id) {
    const conn = await wabaWithToken(req.clientId);
    if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
    try {
      const up = await metaClient.updateFlowJson(flow.meta_flow_id, conn.token, flowJson);
      fields.last_error = validationText(up.validation_errors);
    } catch (err) {
      return metaFailure(res, err, 'Meta did not accept the change');
    }
  }
  res.json(shape(await whatsappFlowsRepo.update(req.db, req.clientId, flow.id, fields)));
}));

router.post('/:id/duplicate', manage, asyncHandler(async (req, res) => {
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  return createForm(req, res, { name: `${flow.name} (copy)`.slice(0, 100), kind: flow.kind, config: flow.config });
}));

router.post('/:id/publish', manage, asyncHandler(async (req, res) => {
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  if (flow.status !== 'draft' || !flow.meta_flow_id) return res.status(409).json({ error: 'Only a draft form that WhatsApp accepted can be published.' });
  if (flow.last_error) return res.status(409).json({ error: 'Fix the problems WhatsApp reported before publishing.', detail: flow.last_error });
  const conn = await wabaWithToken(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  try {
    await metaClient.publishFlow(flow.meta_flow_id, conn.token);
  } catch (err) {
    return metaFailure(res, err, 'WhatsApp did not publish the form');
  }
  res.json(shape(await whatsappFlowsRepo.update(req.db, req.clientId, flow.id, { status: 'published', published_at: new Date().toISOString(), last_error: null })));
}));

router.post('/:id/deprecate', manage, asyncHandler(async (req, res) => {
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  if (flow.status !== 'published') return res.status(409).json({ error: 'Only a published form can be retired.' });
  const conn = await wabaWithToken(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  try {
    await metaClient.deprecateFlow(flow.meta_flow_id, conn.token);
  } catch (err) {
    return metaFailure(res, err, 'WhatsApp did not retire the form');
  }
  res.json(shape(await whatsappFlowsRepo.update(req.db, req.clientId, flow.id, { status: 'deprecated' })));
}));

// Draft: deleted on Meta, then here. Published: must be retired first (Meta
// can't delete it). Retired: removed from Wasi only; responses are kept.
router.delete('/:id', manage, asyncHandler(async (req, res) => {
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  if (flow.status === 'published') return res.status(409).json({ error: 'Retire this form before deleting it. People may still have it open.' });
  if (flow.status === 'draft' && flow.meta_flow_id) {
    const conn = await wabaWithToken(req.clientId);
    if (conn) {
      try {
        await metaClient.deleteFlow(flow.meta_flow_id, conn.token);
      } catch (err) {
        // Already gone on Meta is fine; anything else stops the local delete.
        if (!/does not exist|not found|nonexisting/i.test(err.message)) return metaFailure(res, err, 'WhatsApp did not delete the form');
      }
    }
  }
  await whatsappFlowsRepo.remove(req.db, req.clientId, flow.id);
  res.status(204).send();
}));

router.get('/:id/responses', asyncHandler(async (req, res) => {
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  const rows = await whatsappFlowsRepo.listResponses(req.db, req.clientId, flow.id);
  res.json(rows.map((r) => ({
    id: r.id, createdAt: r.created_at, chatId: r.chat_id, contactName: r.contact_name, phone: r.phone,
    answers: tpl.describeResponse(flow, r.response),
  })));
}));

module.exports = router;
