// Product messages (build-docs/features/catalog-product-messages.md).
// wabas.commerce_catalog_id: the Meta Commerce catalog connected to this
// WABA, used as catalog_id in product / product_list messages. Set by the
// client (typed in, or found via GET /{WABA_ID}/product_catalogs when Meta
// allows it). Read/written via wabasRepo on the privileged pool only, so the
// column-level wasi_app SELECT grant on wabas (013) needs no change.
exports.up = (pgm) => {
  pgm.addColumns('wabas', { commerce_catalog_id: { type: 'text' } });
};

// A reference to a catalog Meta owns; the client can re-enter it.
exports.down = (pgm) => {
  pgm.dropColumns('wabas', ['commerce_catalog_id']);
};
