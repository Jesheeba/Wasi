// Independent QA finding (build plan Phase 4, 2026-08-28): subscribing the
// identical target_url twice for the same client created two independent
// zapier_subscriptions rows, and metaWebhook.js's enqueueForwards enqueues
// one delivery per matching row — proven to cause real double-delivery of
// the same WhatsApp message to the same Zap. A unique constraint on
// (client_id, target_url, event) makes a repeat subscribe idempotent
// (zapierSubscriptionsRepo.create is updated alongside this to upsert on
// conflict) rather than accumulating duplicates.
exports.up = (pgm) => {
  pgm.addConstraint('zapier_subscriptions', 'zapier_subscriptions_unique_target', {
    unique: ['client_id', 'target_url', 'event'],
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('zapier_subscriptions', 'zapier_subscriptions_unique_target');
};
