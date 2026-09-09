// PLAN.md item 15 — Meta conversation pricing / cost calculator.
// conversation_pricing is NOT a tenant table: no client_id, not RLS-scoped
// — it's global reference data Sirah's own admins enter, read by every
// client identically. Same shape as plans/template_library (migration
// 036's comment): admin-owned, select-only to the restricted wasi_app
// role, writes stay on the privileged pool via admin routes only.
//
// Shipped EMPTY on purpose (PLAN.md's own instruction, Revision 2): the
// reference spec's own figures (e.g. "~0.78 INR") are unverified and
// possibly stale — never seeded here or anywhere else. An admin enters
// real current rates through the new conversation-pricing admin route.
exports.up = (pgm) => {
  pgm.createTable('conversation_pricing', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    category: { type: 'text', notNull: true, check: "category in ('MARKETING','UTILITY','AUTHENTICATION','SERVICE')" },
    country_code: { type: 'text', notNull: true },
    rate_inr: { type: 'numeric(8,4)', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('conversation_pricing', 'conversation_pricing_category_country_unique', {
    unique: ['category', 'country_code'],
  });

  pgm.sql('grant select on conversation_pricing to wasi_app');
};

exports.down = async (pgm) => {
  // Same discipline as migration 036_template_library.js's down(): a real
  // (shared dev/prod) database, so a rollback run any time after an admin
  // has actually entered real rates would silently destroy that pricing
  // data with a bare DROP TABLE. Check first and fail loudly with the
  // count, rather than either silently dropping it or a bare Postgres error.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from conversation_pricing');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 066_conversation_pricing: conversation_pricing has ${count} real ` +
      `admin-entered rate(s). Export/back up this data first if it needs to be kept, then ` +
      `retry this rollback.`
    );
  }
  pgm.dropTable('conversation_pricing');
};
