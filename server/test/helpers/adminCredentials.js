// Admin login used by tests that need an admin JWT. Read from the environment
// so no real password is committed. The default matches server/src/db/seed.js's
// local-only default, so a freshly seeded LOCAL database works out of the box;
// production does not accept it (its admin password was rotated on 2026-10-09
// after the old seed value was found live in a public repo).
module.exports = {
  ADMIN_EMAIL: process.env.TEST_ADMIN_EMAIL || 'admin@wasi.local',
  ADMIN_PASSWORD: process.env.TEST_ADMIN_PASSWORD || 'dev-only-admin-password',
};
