// Generalizes template_media_cache from "one cached sample per template" into
// "a library of uploaded media assets per template" — the media-header
// investigation (see migration 028's comment) found that the approval-time
// sample was the ONLY media ever sendable for a media-header template: every
// send path forcibly reused it, with no way to send a different file. This
// keeps that row as the default/fallback (is_default) while allowing
// additional non-default rows a send can point at instead.
//
// The unique(template_id) constraint from 028 only allowed one row per
// template; dropped in favor of a partial unique index that keeps exactly
// one default row per template while permitting unlimited non-default ones.
exports.up = (pgm) => {
  pgm.dropConstraint('template_media_cache', 'template_media_cache_template_id_key', { ifExists: true });

  pgm.addColumns('template_media_cache', {
    is_default: { type: 'boolean', notNull: true, default: false },
  });
  // Every existing row was seeded as the approval sample — backfill before
  // the default-only paths (findByTemplateId) start filtering on this.
  pgm.sql('update template_media_cache set is_default = true');

  pgm.createIndex('template_media_cache', 'template_id', {
    unique: true,
    where: 'is_default',
    name: 'template_media_cache_one_default_per_template',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('template_media_cache', 'template_id', { name: 'template_media_cache_one_default_per_template' });
  pgm.dropColumns('template_media_cache', ['is_default']);
  pgm.addConstraint('template_media_cache', 'template_media_cache_template_id_key', {
    unique: 'template_id',
  });
};
