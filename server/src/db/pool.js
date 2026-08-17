const { Pool } = require('pg');

// Local dev Postgres (docker-compose / embedded-postgres) has no TLS listener;
// every hosted Postgres we deploy against (Supabase, Render, etc.) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// pg.Pool re-emits a dropped idle connection (e.g. Supabase's pooler closing
// one after its idle timeout — normal, expected behavior on their end) as an
// 'error' event on the pool itself. Node's EventEmitter treats 'error' as a
// special case: with no listener attached, it throws as an uncaught
// exception and crashes the whole process. Confirmed live — this crashed the
// server twice during Phase 2 verification, each time silently, with no
// auto-recovery until a file change triggered --watch to restart it. The
// pool discards the dead client and reconnects on the next query either way;
// this handler's only job is to stop that from being fatal.
pool.on('error', (err) => {
  console.error('pg pool: idle client error (non-fatal, pool recovers automatically):', err.message);
});

module.exports = { pool };
