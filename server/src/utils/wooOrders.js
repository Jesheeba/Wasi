// Pure helpers for WooCommerce order events
// (build-docs/features/woocommerce-integration.md). No I/O here.

// WooCommerce core order statuses (no "shipped" in core; stores that add
// custom statuses simply have no rule for them, logged as no_rule).
const STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
const TRIGGERS = [
  { trigger: 'order_created', label: 'Order placed' },
  ...STATUSES.map((s) => ({ trigger: `status_${s}`, label: `Status: ${s.replace('-', ' ')}` })),
];
const isTrigger = (t) => TRIGGERS.some((x) => x.trigger === t);

// Fields a template variable can be filled from.
const ORDER_FIELDS = [
  { key: 'customer_name', label: 'Customer full name' },
  { key: 'first_name', label: 'Customer first name' },
  { key: 'order_number', label: 'Order number' },
  { key: 'order_total', label: 'Order total (e.g. 1,250.00)' },
  { key: 'currency', label: 'Currency (e.g. INR)' },
  { key: 'order_status', label: 'Order status' },
  { key: 'items', label: 'Items (e.g. "2 x T-shirt, 1 x Cap")' },
  { key: 'order_date', label: 'Order date' },
  { key: 'payment_method', label: 'Payment method' },
  { key: 'shipping_city', label: 'Shipping city' },
];
const isOrderField = (k) => ORDER_FIELDS.some((f) => f.key === k);

// Country calling codes for the billing countries we can safely convert a
// local number for. Anything else must already be in international form.
const CALLING_CODES = { IN: '91' };

// Returns digits in international form (no "+"), or null with a reason.
function normalizePhone(raw, country) {
  const input = String(raw || '').trim();
  if (!input) return { phone: null, reason: 'Order has no billing phone number' };
  const hadPlus = input.startsWith('+') || input.startsWith('00');
  let digits = input.replace(/\D/g, '');
  if (input.startsWith('00')) digits = digits.slice(2);
  const cc = CALLING_CODES[(country || 'IN').toUpperCase()];
  if (hadPlus) {
    if (digits.length >= 10 && digits.length <= 15) return { phone: digits };
  } else if (cc && digits.length === 10) {
    return { phone: cc + digits };
  } else if (cc && digits.length === 11 && digits.startsWith('0')) {
    return { phone: cc + digits.slice(1) };
  } else if (cc && digits.length === 12 && digits.startsWith(cc)) {
    return { phone: digits };
  } else if (!cc && digits.length >= 11 && digits.length <= 15) {
    return { phone: digits };
  }
  return { phone: null, reason: `Could not turn "${input}" into an international WhatsApp number` };
}

function fieldsFromOrder(order = {}) {
  const b = order.billing || {};
  const first = String(b.first_name || '').trim();
  const name = `${first} ${String(b.last_name || '').trim()}`.trim();
  const total = Number(order.total);
  return {
    customer_name: name || 'Customer',
    first_name: first || name || 'Customer',
    order_number: String(order.number ?? order.id ?? ''),
    order_total: Number.isFinite(total) ? total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(order.total ?? ''),
    currency: String(order.currency || ''),
    order_status: String(order.status || '').replace('-', ' '),
    items: (order.line_items || []).map((i) => `${i.quantity} x ${i.name}`).join(', ').slice(0, 200) || '-',
    order_date: order.date_created ? new Date(order.date_created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
    payment_method: String(order.payment_method_title || order.payment_method || ''),
    shipping_city: String(order.shipping?.city || b.city || ''),
  };
}

// order.created -> order_created; order.updated -> status_<status>. The
// dedupe key makes each (order, trigger) send at most once, because
// WooCommerce fires order.updated on every edit, not just status changes.
function triggerFor(topic, order) {
  if (!order || order.id == null) return null;
  if (topic === 'order.created') return { trigger: 'order_created', dedupeKey: `order:${order.id}:created` };
  if (topic === 'order.updated' && order.status) return { trigger: `status_${order.status}`, dedupeKey: `order:${order.id}:status:${order.status}` };
  return null;
}

// Template variables -> values. Every variable needs a mapped field; a
// missing or empty value becomes "-" because Meta rejects empty parameters.
function buildParamValues(variables, paramMap, fields) {
  const values = {};
  const missing = [];
  for (const v of variables) {
    const key = paramMap?.[v];
    if (!key || !isOrderField(key)) { missing.push(v); continue; }
    const value = String(fields[key] ?? '').trim();
    values[v] = value || '-';
  }
  return { values, missing };
}

module.exports = { STATUSES, TRIGGERS, isTrigger, ORDER_FIELDS, isOrderField, normalizePhone, fieldsFromOrder, triggerFor, buildParamValues };
