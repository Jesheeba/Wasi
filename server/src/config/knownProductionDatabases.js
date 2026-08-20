// Non-secret connection fingerprints (username + host + port + database
// name — NEVER the password) for databases that must never be touched by a
// test run or a local ad-hoc script. See ../utils/dbSafety.js for how this
// is enforced, and memory/project_shared_dev_prod_db.md (auto-memory) for
// the incident that made this necessary: local dev's DATABASE_URL pointed
// at this exact database, and a local diagnostic script briefly wrote a
// test row into it before being caught.
//
// Add a fingerprint here the moment a database becomes production. Remove
// one only once that database is fully decommissioned or repurposed as a
// non-production database — never while it's still serving real traffic.
module.exports = [
  // wasi.sirahagents.com production DB (Supabase project exvoupxpocybjcxmkuac,
  // ap-south-1 pooler). As of 2026-08-20, server/.env (local dev) points at
  // this SAME database — there is no separate dev database yet, so this
  // guard is expected to block local tests/scripts until that split happens.
  // Once it does, remove this comment and update the fingerprint list to
  // match: this entry stays (it's still production), and dev's .env moves
  // to a different project entirely.
  'postgres.exvoupxpocybjcxmkuac@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
];
