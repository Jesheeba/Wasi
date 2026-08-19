// Prompted by an admin_users row (ops@wasi.local, role platform_admin) found
// live in the database with no traceable origin: POST /admin-users never
// wrote to audit_log, so there was no record of who created it, when, or
// from where — created_at on admin_users itself was the only timestamp
// available, and nothing tied it to an actor or a request. Creating an admin
// account grants durable, high-privilege access, so it's exactly the action
// that must be traceable after the fact. actor_id/actor_type/created_at
// already answer "who" and "when" once the route actually calls
// auditLogRepo.record (routes/admin.js); actor_ip answers "from where" and
// didn't exist as a column at all.
exports.up = (pgm) => {
  pgm.addColumns('audit_log', {
    actor_ip: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('audit_log', ['actor_ip']);
};
