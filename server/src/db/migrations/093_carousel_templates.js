// Carousel templates (build-docs/features/carousel-templates.md). `cards`
// is nullable jsonb, same convention as 091's limited_time_offer - only a
// carousel template sets it, every other (the overwhelming majority)
// leaves it null. `card_index` on template_media_cache is nullable too:
// null means "the template's own top-level media" (today's existing
// single-header meaning, unchanged), a number means "card N's media" for
// a carousel template.
exports.up = (pgm) => {
  pgm.addColumns('message_templates', {
    cards: { type: 'jsonb' },
  });
  pgm.addColumns('template_media_cache', {
    card_index: { type: 'integer' },
  });

  // migration 030's template_media_cache_one_default_per_template index
  // enforces "one default row per template_id" - correct for a single
  // media header, but a carousel template needs one default row PER
  // CARD. Replaced with an index on (template_id, coalesce(card_index,
  // -1)) instead of just (template_id): coalesce is required because
  // Postgres treats every NULL as distinct in a unique index, so a plain
  // (template_id, card_index) index would let unlimited is_default rows
  // through for every existing non-carousel template (card_index always
  // NULL there) - the exact invariant this index exists to enforce.
  pgm.dropIndex('template_media_cache', 'template_id', { name: 'template_media_cache_one_default_per_template' });
  pgm.sql(`
    create unique index template_media_cache_one_default_per_card
    on template_media_cache (template_id, coalesce(card_index, -1))
    where is_default
  `);
};

exports.down = (pgm) => {
  pgm.sql('drop index if exists template_media_cache_one_default_per_card');
  pgm.createIndex('template_media_cache', 'template_id', {
    unique: true,
    where: 'is_default',
    name: 'template_media_cache_one_default_per_template',
  });
  pgm.dropColumns('template_media_cache', ['card_index']);
  pgm.dropColumns('message_templates', ['cards']);
};
