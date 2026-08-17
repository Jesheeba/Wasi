const { z } = require('zod');

const uuid = z.string().uuid();

const clientCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  tenant_slug: z.string().min(1),
  status: z.enum(['pending_setup', 'payment_confirmed', 'active', 'suspended']).optional(),
});

const clientUpdateSchema = clientCreateSchema.partial();

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

// Outbound sends only — inbound messages arrive exclusively via the Meta
// webhook now (server/src/routes/metaWebhook.js), never through this route.
const messageSendSchema = z.object({
  type: z.enum(['text', 'template']).default('text'),
  body: z.string().min(1).optional(),
  templateName: z.string().optional(),
  templateLanguage: z.string().optional(),
  templateComponents: z.array(z.any()).optional(),
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
});

const broadcastCreateSchema = z.object({
  title: z.string().min(1),
  tag_id: uuid.optional(),
  templateName: z.string().min(1),
  scheduled_date: z.string().optional(),
});

const automationRuleCreateSchema = z.object({
  title: z.string().min(1),
  trigger: z.string().min(1),
  action: z.string().min(1),
});

const messageTemplateCreateSchema = z.object({
  name: z.string().min(1),
  category: z.enum(['Marketing', 'Utility', 'Authentication']),
  body: z.string().min(1),
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

const clientWebhookSchema = z.object({
  callback_url: z.string().url(),
});

const tagCreateSchema = z.object({
  name: z.string().min(1),
  bg: z.string().optional(),
  color: z.string().optional(),
});

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
  messageSendSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  checkoutSchema,
  wabaConnectSchema,
  broadcastCreateSchema,
  automationRuleCreateSchema,
  messageTemplateCreateSchema,
  templateStatusUpdateSchema,
  supportTicketCreateSchema,
  ticketStatusUpdateSchema,
  tagCreateSchema,
  teamMemberCreateSchema,
  contactAttributeCreateSchema,
  paymentLinkCreateSchema,
  walletRechargeSchema,
  clientWebhookSchema,
  consentEventCreateSchema,
};
