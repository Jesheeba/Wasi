exports.up = (pgm) => {
  pgm.addColumn('admin_users', {
    password_hash: { type: 'text', notNull: true, default: '' },
  });
  pgm.alterColumn('admin_users', 'password_hash', { default: null });
};

exports.down = (pgm) => {
  pgm.dropColumn('admin_users', 'password_hash');
};
