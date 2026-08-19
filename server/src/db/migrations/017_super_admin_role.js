// Phase 6 Part A — a distinct super-admin role for cross-tenant operational
// visibility (client health, templates, volume, API keys, failures across
// ALL clients — see routes/superAdmin.js). Deliberately not a boolean flag
// on an existing admin_users row: it's a new role value gated behind its
// OWN JWT token type ('super_admin', signed by signSuperAdminToken in
// utils/auth.js and checked by middleware/requireSuperAdminAuth.js) and its
// OWN login route (routes/superAdminAuth.js), issued only to admin_users
// rows whose role is exactly 'platform_admin'. A leaked/misused regular
// 'admin' token can't reach super-admin routes regardless of its role
// claim, because the middleware checks token type, not just role.
exports.up = (pgm) => {
  pgm.dropConstraint('admin_users', 'admin_users_role_check');
  pgm.addConstraint('admin_users', 'admin_users_role_check', {
    check: "role in ('super_admin', 'support', 'billing', 'platform_admin')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('admin_users', 'admin_users_role_check');
  pgm.addConstraint('admin_users', 'admin_users_role_check', {
    check: "role in ('super_admin', 'support', 'billing')",
  });
};
