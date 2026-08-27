// Admin panel gets a "Delete" action for API keys, distinct from the
// existing "Revoke" (revoked_at). Revoke disables a key (the consuming app
// loses access) but leaves it visible in the list, forever, as a record.
// Delete additionally hides it from that list — but stays a soft tombstone
// (deleted_at), not a hard row delete, so audit_log entries referencing this
// key id (api_key_created/revoked/deleted) keep resolving to a real row and
// the credential's full lifecycle stays reconstructable for compliance.

exports.up = (pgm) => {
  pgm.addColumns('api_keys', {
    deleted_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('api_keys', ['deleted_at']);
};
