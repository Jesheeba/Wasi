// Sets a new password for one admin_users or clients row, prompting for it
// with hidden input so it never lands in shell history, an env var, or a
// transcript. Bumps token_version (every JWT issued before this stops
// working) and writes an audit_log row that records THAT it happened, never
// the value.
//
//   node scripts/set-password.js admin admin@wasi.local
//   node scripts/set-password.js client demo@wasi.local
//
// Deliberate manual production operation: reads DATABASE_URL from
// server/.env and does not go through dbSafety's test-only guard.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const TABLES = { admin: 'admin_users', client: 'clients' };
const MIN_LENGTH = 14;

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Run this in an interactive terminal (stdin is not a TTY).'));
    process.stdout.write(label);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  const [kind, email] = process.argv.slice(2);
  const table = TABLES[kind];
  if (!table || !email) {
    console.error('Usage: node scripts/set-password.js <admin|client> <email>');
    process.exit(2);
  }
  const first = await promptHidden(`New password for ${email} (min ${MIN_LENGTH} chars): `);
  if (first.length < MIN_LENGTH) { console.error(`Too short (min ${MIN_LENGTH}). Nothing changed.`); process.exit(1); }
  const second = await promptHidden('Repeat it: ');
  if (first !== second) { console.error('Did not match. Nothing changed.'); process.exit(1); }

  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query('begin');
    const r = await db.query(
      `update ${table} set password_hash = $1, token_version = token_version + 1 where lower(email) = lower($2) returning id`,
      [await bcrypt.hash(first, 10), email]
    );
    if (r.rowCount !== 1) throw new Error(`Expected exactly 1 ${table} row for ${email}, matched ${r.rowCount}. Nothing changed.`);
    await db.query(
      `insert into audit_log (actor_type, action, target) values ('system', 'password_set_manually', $1)`,
      [`${kind}: ${email}`]
    );
    await db.query('commit');
    console.log(`Password updated for ${email}; existing sessions revoked.`);
  } catch (err) {
    await db.query('rollback').catch(() => {});
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
