// "Continue with Google" (build-docs/features/google-login.md): the stable
// Google account id (the ID token's `sub`) a client signs in with. Email can
// change on a Google account; `sub` never does, so it is the link.
//
// Nullable (password-only accounts have none) and unique when present, so one
// Google account can belong to one Wasi client only.
//
// Grants: deliberately NOT added to wasi_app's column-level SELECT on clients
// (migrations 013/043/069). Only routes/auth.js reads it, on the privileged
// pool, and clientsRepo's SAFE_COLUMNS does not include it - so the "new
// clients column without the grant" trap (CLAUDE.md, migration 069) does not
// apply. If a tenant-scoped read ever needs it, extend the grant then.
exports.up = (pgm) => {
  pgm.addColumns('clients', { google_sub: { type: 'text' } });
  pgm.createIndex('clients', 'google_sub', { unique: true, where: 'google_sub is not null', name: 'clients_google_sub_unique' });
};

// Dropping it only unlinks Google sign-in; those accounts keep working via
// "Forgot password" (which sets a password), so no data is lost.
exports.down = (pgm) => {
  pgm.dropIndex('clients', 'google_sub', { name: 'clients_google_sub_unique' });
  pgm.dropColumns('clients', ['google_sub']);
};
