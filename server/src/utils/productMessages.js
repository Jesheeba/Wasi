// Product messages from a Meta Commerce catalog
// (build-docs/features/catalog-product-messages.md). Pure: validates input
// and builds the `interactive` object Meta expects. Limits from Meta's
// catalog docs (checked 2026-11-23); where Meta doesn't state one, a
// conservative cap is used and named here.
const MAX_LIST_ITEMS = 30; // Meta: up to 30 products per multi-product message
const MAX_SECTIONS = 10; // historical Meta limit; current docs don't restate it
const SECTION_TITLE_MAX = 24;
const BODY_MAX = 1024;
const FOOTER_MAX = 60;
const HEADER_MAX = 60; // not stated for product_list; same as other interactive headers

const skuList = (raw) => (Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/))
  .map((s) => String(s).trim()).filter(Boolean);

// Returns { interactive, summary } or { error }.
function buildProductInteractive(input = {}, catalogId) {
  if (!catalogId) return { error: 'Set your Meta catalog ID on the Ecommerce page first.' };
  const body = String(input.body || '').trim();
  const footer = String(input.footer || '').trim();
  if (body.length > BODY_MAX) return { error: `The message can be ${BODY_MAX} characters at most.` };
  if (footer.length > FOOTER_MAX) return { error: `The footer can be ${FOOTER_MAX} characters at most.` };
  const withText = (obj) => {
    if (body) obj.body = { text: body };
    if (footer) obj.footer = { text: footer };
    return obj;
  };

  if (input.kind === 'product') {
    const sku = String(input.sku || '').trim();
    if (!sku) return { error: 'Enter the product\'s SKU (retailer ID) from your catalog.' };
    return { interactive: withText({ type: 'product', action: { catalog_id: catalogId, product_retailer_id: sku } }), summary: `product ${sku}` };
  }

  if (input.kind === 'product_list') {
    const header = String(input.header || '').trim();
    if (!header) return { error: 'A product list needs a heading.' };
    if (header.length > HEADER_MAX) return { error: `The heading can be ${HEADER_MAX} characters at most.` };
    if (!body) return { error: 'A product list needs a message.' };
    const sections = (input.sections || []).map((sec) => ({ title: String(sec.title || '').trim(), skus: [...new Set(skuList(sec.skus))] }))
      .filter((sec) => sec.skus.length);
    if (!sections.length) return { error: 'Add at least one SKU.' };
    if (sections.length > MAX_SECTIONS) return { error: `Up to ${MAX_SECTIONS} sections.` };
    const total = sections.reduce((n, sec) => n + sec.skus.length, 0);
    if (total > MAX_LIST_ITEMS) return { error: `Up to ${MAX_LIST_ITEMS} products in one message (you have ${total}).` };
    for (const sec of sections) {
      if (sections.length > 1 && !sec.title) return { error: 'Each section needs a title when there is more than one.' };
      if (sec.title.length > SECTION_TITLE_MAX) return { error: `Section titles can be ${SECTION_TITLE_MAX} characters at most.` };
    }
    return {
      interactive: withText({
        type: 'product_list',
        header: { type: 'text', text: header },
        action: {
          catalog_id: catalogId,
          sections: sections.map((sec) => ({ title: sec.title || header.slice(0, SECTION_TITLE_MAX), product_items: sec.skus.map((sku) => ({ product_retailer_id: sku })) })),
        },
      }),
      summary: `${total} products`,
    };
  }

  if (input.kind === 'catalog') {
    if (!body) return { error: 'A catalog message needs a message.' };
    const thumb = String(input.thumbnailSku || '').trim();
    return {
      interactive: withText({
        type: 'catalog_message',
        action: { name: 'catalog_message', ...(thumb ? { parameters: { thumbnail_product_retailer_id: thumb } } : {}) },
      }),
      summary: 'catalog',
    };
  }
  return { error: 'Choose a product, a product list or your whole catalog.' };
}

// Inbound cart (type "order") as readable chat text.
function describeOrder(order = {}) {
  const items = (order.product_items || []).map((i) => `${i.quantity} x ${i.product_retailer_id}${i.item_price != null ? ` @ ${i.item_price} ${i.currency || ''}`.trimEnd() : ''}`);
  const total = (order.product_items || []).reduce((n, i) => n + (Number(i.item_price) || 0) * (Number(i.quantity) || 0), 0);
  const currency = order.product_items?.[0]?.currency || '';
  const lines = ['Cart sent', ...items];
  if (total) lines.push(`Total: ${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${currency}`.trimEnd());
  if (order.text) lines.push(`Note: ${order.text}`);
  return lines.join('\n');
}

module.exports = { buildProductInteractive, describeOrder, MAX_LIST_ITEMS };
