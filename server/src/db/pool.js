const { Pool } = require('pg');
const { assertNotProductionDatabase } = require('../utils/dbSafety');

// Throws immediately (before any query, before any test even starts) if
// DATABASE_URL points at a known-production database and this isn't the
// real production process. See dbSafety.js.
assertNotProductionDatabase();

// Local dev Postgres (docker-compose / embedded-postgres) has no TLS listener;
// every hosted Postgres we deploy against (Supabase, Render, etc.) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // No timeout here means a hung TCP handshake (a network blip against
  // Supabase's Supavisor pooler — the same class of transient drop
  // pool.on('error') below already handles for idle connections) blocks
  // whoever called pool.connect() until the OS's own TCP timeout gives up,
  // which can be minutes. Confirmed live: server/src/middleware/
  // tenantContext.js now calls pool.connect() on every client-authenticated
  // request (previously only a handful of call sites did), so this gap went
  // from rare to something a single test run actually hit. Failing fast
  // means the request errors out and the caller can see/retry it, instead
  // of an Express request hanging with no visible cause.
  connectionTimeoutMillis: 10_000,
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
