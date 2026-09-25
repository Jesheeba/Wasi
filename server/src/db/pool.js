const { Pool } = require('pg');
const { assertNotProductionDatabase } = require('../utils/dbSafety');

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

// Safety guard moved from require-time to call-time (2026-09-25) — a
// stubs-only test that requires this module transitively (e.g. via a route
// file it imports, or via a repo module whose functions it then replaces
// entirely with stubs before calling anything) used to be unable to load at
// all in this shared-prod-DB environment, even though it poses zero real
// risk: it never actually calls .query()/.connect(). Confirmed by grep
// before making this change: pool.query() and pool.connect() are the ONLY
// two ways any code in this repo ever reaches the database — no other file
// constructs its own Pool, no lower-level API is used anywhere — so
// wrapping exactly these two public entry points gives the identical
// protection at the moment real I/O would actually happen, not weaker
// protection deferred to whenever it's convenient. Holding a reference to
// `pool`, or requiring this module and never calling either method, is now
// free.
//
// Checked once, not on every call — process.env doesn't change mid-process,
// so re-running the parse/fingerprint/env-var check on every single query
// would be pure overhead, and (more importantly) would make
// ALLOW_SHARED_PRODUCTION_DB's loud warning banner print on every query
// instead of once per process, which would bury a real production
// investigation session's own output in noise.
let dbSafetyChecked = false;
function ensureDbSafety() {
  if (dbSafetyChecked) return;
  assertNotProductionDatabase();
  dbSafetyChecked = true;
}

const originalQuery = pool.query.bind(pool);
const originalConnect = pool.connect.bind(pool);
pool.query = (...args) => {
  ensureDbSafety();
  return originalQuery(...args);
};
pool.connect = (...args) => {
  ensureDbSafety();
  return originalConnect(...args);
};

module.exports = { pool };
