const { z } = require('zod');
const { WEBHOOK_EVENT_TYPES } = require('./webhookEvents');

const uuid = z.string().uuid();

const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // Optional: admin-created clients (routes/clients.js) auto-generate this
  // from name, the same way registerSchema's self-signup path does.
  tenant_slug: z.string().min(1).optional(),
  status: z.enum(['pending_setup', 'payment_confirmed', 'active', 'suspended']).optional(),
  // Admin-created-client only. Never persisted as-is — routes/clients.js
  // hashes it before it reaches clientsRepo.create, and it's deliberately
  // excluded from clientUpdateSchema below so it can't reach
  // clientsRepo.update's dynamic set-clause (there is no `password` column,
  // only `password_hash`).
  password: z.string().min(8).optional(),
});

const clientUpdateSchema = clientCreateSchema.omit({ password: true }).partial();

const contactCreateSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  tag_id: uuid.optional(),
  status: z.string().optional(),
});

const contactUpdateSchema = contactCreateSchema.partial();

const chatCreateSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  contact_id: uuid.optional(),
  tag_id: uuid.optional(),
  unread_count: z.number().int().min(0).optional(),
});

const chatUpdateSchema = chatCreateSchema.partial();

// GAP_FIX_PLAN.md Phase E2 — team_member_id is nullable (not optional) so
// "assign to nobody" (unassign) is an explicit request, not indistinguishable
// from an omitted field.
const chatAssignSchema = z.object({
  team_member_id: uuid.nullable(),
});

// Outbound sends only — inbound messages arrive exclusively via the Meta
// webhook now (server/src/routes/metaWebhook.js), never through this route.
const messageSendSchema = z.object({
  type: z.enum(['text', 'template']).default('text'),
  body: z.string().min(1).optional(),
  templateName: z.string().optional(),
  templateLanguage: z.string().optional(),
  templateComponents: z.array(z.any()).optional(),
  // A specific uploaded media asset (see routes/templates.js's POST
  // /:id/header-media) to send instead of a media-header template's
  // approval-time default sample. Omitted -> falls back to that default.
  headerMediaAssetId: uuid.optional(),
}).refine(
  (data) => (data.type === 'text' ? Boolean(data.body) : Boolean(data.templateName)),
  { message: "body is required for type 'text'; templateName is required for type 'template'" }
);

const registerSchema = z.object({
  businessName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const checkoutSchema = z.object({
  plan: z.enum(['Starter', 'Growth', 'Scale']),
});

const wabaConnectSchema = z.object({
  code: z.string().min(1),
  waba_id: z.string().min(1),
  phone_number_id: z.string().min(1),
  // Set by embeddedSignup.js from which FINISH_* event Meta actually fired —
  // the one reliable signal for whether the business took the Coexistence
  // path (keeps their WhatsApp Business app) vs plain migration. Trusted as
  // sent, not re-derived here, since nothing else in this payload
  // distinguishes the two paths.
  via_coexistence: z.boolean().optional().default(false),
});

// Partial update, deliberately — every field is optional and the route
// forwards only whatever keys are actually present to Meta's POST
// (messaging_product + whatever's here). Sending the full object on every
// save would let an unset field (absent from a previous GET) overwrite real
// data on the live profile with nothing. profile_picture_handle is NOT a
// field here on purpose — the picture has its own endpoint/flow
// (routes/onboarding.js), so this schema can never carry it even by
// accident. Limits are Meta's real documented ones, not placeholders.
const businessProfileUpdateSchema = z.object({
  about: z.string().trim().max(139).optional(),
  address: z.string().trim().max(256).optional(),
  description: z.string().trim().max(512).optional(),
  email: z.string().trim().max(128).email().optional(),
  vertical: z.enum([
    'UNDEFINED', 'OTHER', 'AUTO', 'BEAUTY', 'APPAREL', 'EDU', 'ENTERTAIN',
    'EVENT_PLAN', 'FINANCE', 'GROCERY', 'GOVT', 'HOTEL', 'HEALTH',
    'NONPROFIT', 'PROF_SERVICES', 'RETAIL', 'TRAVEL', 'RESTAURANT', 'NOT_A_BIZ',
  ]).optional(),
  websites: z.array(z.string().trim().url().max(256)).max(2).optional(),
}).strict();

// Where one template parameter's value comes from — 'contact_field' reads a
// per-recipient value at send time (routes/broadcasts.js and
// broadcastRunner.js are the two places that need to agree on the field
// set; kept narrow to the two fields actually useful as message text,
// rather than exposing every contacts column), 'static' is fixed once at
// broadcast creation and used unchanged for every recipient.
const broadcastParamMappingSchema = z.object({
  source: z.enum(['contact_field', 'static']),
  field: z.enum(['name', 'phone']).optional(),
  value: z.string().optional(),
}).superRefine((val, ctx) => {
  if (val.source === 'contact_field' && !val.field) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source 'contact_field' requires a field ('name' or 'phone')" });
  }
  if (val.source === 'static' && !val.value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source 'static' requires a non-empty value" });
  }
});

const broadcastCreateSchema = z.object({
  title: z.string().min(1),
  tag_id: uuid.optional(),
  templateName: z.string().min(1),
  scheduled_date: z.string().optional(),
  // Keyed by parameter name (e.g. "customer_name"). Coverage against the
  // chosen template's actual {{params}} is checked in routes/broadcasts.js,
  // not here — this schema only validates the shape of whatever mappings
  // were supplied, since it doesn't have the template's text to check
  // against.
  paramMappings: z.record(z.string(), broadcastParamMappingSchema).optional(),
  // A specific uploaded media asset (see routes/templates.js's POST
  // /:id/header-media) this campaign sends instead of a media-header
  // template's approval-time default sample. Omitted -> that default.
  headerMediaAssetId: uuid.optional(),
});

// A rule either sends free text (action) or starts a flow (flow_id) — never
// both, never neither. Mirrors migration 023's
// automation_rules_action_xor_flow CHECK constraint at the validation
// layer, so a bad request 400s with a clear message instead of reaching
// Postgres and surfacing a raw constraint-violation error.
const automationRuleCreateSchema = z.object({
  title: z.string().min(1),
  trigger: z.string().min(1),
  action: z.string().min(1).optional(),
  flow_id: uuid.optional(),
}).superRefine((val, ctx) => {
  if (Boolean(val.action) === Boolean(val.flow_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide exactly one of "action" (send free text) or "flow_id" (start a flow), not both or neither.',
    });
  }
});

const automationRuleUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
});

const automationFlowCreateSchema = z.object({
  name: z.string().min(1),
});

const automationFlowUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  entry_node_id: uuid.optional(),
});

const flowNodeCreateSchema = z.object({
  type: z.enum(['send_text', 'send_interactive_buttons', 'send_template', 'delay', 'action', 'end']),
  // Shape depends on `type` — validated loosely here (any object) and left
  // to flowEngine.js's executeNode to interpret at send time (same
  // "loosely typed, interpreted by the engine" approach automation_rules'
  // action/trigger free-text fields already use, rather than a union
  // schema per node type this early — Stage 6 is the first UI ever built
  // for this, so the config shape is still likely to shift).
  config: z.record(z.string(), z.any()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const flowNodeUpdateSchema = z.object({
  config: z.record(z.string(), z.any()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const flowEdgeCreateSchema = z.object({
  from_node_id: uuid,
  to_node_id: uuid,
  condition_type: z.enum(['always', 'button_id', 'keyword', 'default', 'timeout']),
  condition_value: z.string().optional(),
  priority: z.number().int().optional(),
});

// Reordering only — see flowEdgesRepo.update's comment for why this is the
// one field editable in place rather than delete-and-recreate.
const flowEdgeUpdateSchema = z.object({
  priority: z.number().int(),
});

const templateButtonSchema = z.object({
  type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
  text: z.string().min(1).max(25),
  url: z.string().url().optional(),
  phone_number: z.string().min(1).optional(),
});

// Category-driven: Authentication's shape is fundamentally different from
// Utility/Marketing's (Meta generates that body text, not the author — see
// metaClient.js's buildTemplateCreatePayload), so this can't be one flat
// object with everything optional; the superRefine below enforces which
// fields actually apply to which category, not just presence/type.
//
// header.type accepts IMAGE/VIDEO/DOCUMENT as of the media-header feature —
// routes/templates.js is the real authoritative boundary for the actual
// upload requirement (a file is required for these three, checked there
// since multer populates req.file outside this JSON-only schema).
const messageTemplateCreateSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_]+$/, 'Template name must be lowercase letters, numbers, and underscores only'),
  category: z.enum(['Marketing', 'Utility', 'Authentication']),
  language: z.string().min(1).default('en_US'),

  // Utility/Marketing only.
  body: z.string().min(1).max(1024).optional(),
  // Meta requires a real example per named parameter, not just recommends
  // one — see templateParams.js's defaultExampleFor comment for what this
  // replaced (an auto-derived-from-the-name guess, never author-supplied).
  bodyParamExamples: z.record(z.string()).optional(),
  header: z.object({
    type: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
    text: z.string().max(60).optional(),
  }).optional(),
  footer: z.string().max(60).optional(),
  buttons: z.array(templateButtonSchema).max(10).optional(),

  // Authentication only.
  codeExpirationMinutes: z.number().int().positive().max(90).optional(),
  addSecurityDisclaimer: z.boolean().optional(),
  otpButtonType: z.enum(['COPY_CODE']).optional(),
}).superRefine((data, ctx) => {
  if (data.category === 'Authentication') {
    if (data.body || data.header || data.footer || data.buttons) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Authentication templates cannot have a custom body, header, footer, or buttons — Meta generates that text automatically.',
      });
    }
    return;
  }

  if (!data.body) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'Body is required.' });
    return;
  }

  // Deliberately NOT checking bodyParamExamples coverage here: extracting
  // "every {{...}} in the body" at the schema layer can't yet tell a
  // numbered {{1}} from a real named parameter (that distinction is
  // validateTemplateText's job), so doing the coverage check here produced
  // a confusing "sample value required for: 1" instead of the correct
  // "numbered parameters aren't allowed" — and did it via a raw ZodError,
  // bypassing the route's friendly {error, details: [string,...]} shape
  // entirely. routes/templates.js checks sample-value coverage itself,
  // after validateTemplateText has already confirmed the body's params are
  // well-formed named ones.

  if (data.header?.type === 'TEXT' && !data.header.text) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['header'], message: 'Header text is required when header type is TEXT.' });
  }

  if (data.buttons?.length) {
    const urlCount = data.buttons.filter((b) => b.type === 'URL').length;
    const phoneCount = data.buttons.filter((b) => b.type === 'PHONE_NUMBER').length;
    if (urlCount > 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'At most 2 URL buttons allowed.' });
    if (phoneCount > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'At most 1 phone number button allowed.' });
    for (const b of data.buttons) {
      if (b.type === 'URL' && !b.url) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'A URL button requires a url.' });
      if (b.type === 'PHONE_NUMBER' && !b.phone_number) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'A phone number button requires a phone_number.' });
    }
  }
});

const templateStatusUpdateSchema = z.object({
  status: z.enum(['approved', 'pending', 'rejected']),
});

const supportTicketCreateSchema = z.object({
  subject: z.string().min(1),
  message: z.string().min(1),
});

const ticketStatusUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
});

const teamMemberCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
});

const contactAttributeCreateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'number', 'date', 'boolean']).optional(),
});

const paymentLinkCreateSchema = z.object({
  title: z.string().min(1),
  amount_inr: z.number().int().positive(),
});

const walletRechargeSchema = z.object({
  amount_inr: z.number().int().positive(),
});

// events is required, not defaulted — see migration
// 015_explicit_forward_events.js for why: a subscription that doesn't say
// which events it wants isn't implicitly "all of them," it's invalid.
const clientWebhookSchema = z.object({
  callback_url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

const hubForwardConfigSchema = z.object({
  forward_to_url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

const tagCreateSchema = z.object({
  name: z.string().min(1),
  bg: z.string().optional(),
  color: z.string().optional(),
});

// Self-signup client's own key management (GAP_FIX_PLAN.md Phase C2) —
// client_id is never accepted here, unlike admin.js's equivalent route: a
// client can only ever create a key for itself (req.clientId, from its own
// JWT), so there's nothing to validate-against-mismatch the way
// apiMessageSendSchema's client_id defense-in-depth check does.
const apiKeyCreateSchema = z.object({
  app_name: z.string().min(1).max(100),
});

// Hub API send endpoint (build plan Phase 5) — client_id is required in the
// body (not just resolved from the API key) as a defense-in-depth sanity
// check: routes/apiV1Messages.js rejects the request if it doesn't match
// the key's own client_id, catching a caller that's confused about which
// key it's using rather than silently acting on the wrong tenant.
const apiMessageSendSchema = z.object({
  client_id: uuid,
  to: z.string().min(1),
  type: z.enum(['text', 'template']).default('text'),
  template: z.string().optional(),
  params: z.record(z.any()).optional(),
  body: z.string().optional(),
  // A media-header template only. The calling CRM's own document/image/video
  // for this one send (server/src/services/mediaHeaderService.js's
  // resolveMediaIdFromUrl fetches it, uploads it to Meta, and sends with the
  // resulting id) — the alternative to first uploading through this app's UI.
  headerMediaUrl: z.string().url().startsWith('https://').optional(),
}).refine(
  (data) => (data.type === 'text' ? Boolean(data.body) : Boolean(data.template)),
  { message: "body is required for type 'text'; template is required for type 'template'" }
);

// Deliberately its own schema, not part of contactUpdateSchema — consent
// changes require a source (an explicit declaration, an inbound STOP, etc.)
// and go through consentRepo.recordEvent so the change and its evidence are
// always written together. See server/src/repositories/consentRepo.js.
const consentEventCreateSchema = z.object({
  event: z.enum(['opted_in', 'opted_out']),
  source: z.string().min(1),
  evidence: z.record(z.any()).optional(),
});

module.exports = {
  uuid,
  clientCreateSchema,
  clientUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  chatCreateSchema,
  chatUpdateSchema,
  chatAssignSchema,
  messageSendSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  checkoutSchema,
  wabaConnectSchema,
  businessProfileUpdateSchema,
  broadcastCreateSchema,
  automationRuleCreateSchema,
  automationRuleUpdateSchema,
  automationFlowCreateSchema,
  automationFlowUpdateSchema,
  flowNodeCreateSchema,
  flowNodeUpdateSchema,
  flowEdgeCreateSchema,
  flowEdgeUpdateSchema,
  messageTemplateCreateSchema,
  templateStatusUpdateSchema,
  supportTicketCreateSchema,
  ticketStatusUpdateSchema,
  tagCreateSchema,
  apiKeyCreateSchema,
  teamMemberCreateSchema,
  contactAttributeCreateSchema,
  paymentLinkCreateSchema,
  walletRechargeSchema,
  clientWebhookSchema,
  hubForwardConfigSchema,
  consentEventCreateSchema,
  apiMessageSendSchema,
};
