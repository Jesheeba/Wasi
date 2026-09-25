const KNOWN_PRODUCTION_DATABASES = require('../config/knownProductionDatabases');

// username+host+port+dbname, never the password — this is the part of a
// connection string that identifies WHICH database, not who can log into
// it, so it's safe to check into the repo (knownProductionDatabases.js) and
// compare against with no secret ever entering this module.
function fingerprint(databaseUrl) {
  if (!databaseUrl) return null;
  let url;
  try {
    url = new URL(databaseUrl);
  } catch (_err) {
    return null; // Unparseable — let the real pg client surface that error.
  }
  return `${url.username}@${url.hostname}:${url.port}${url.pathname}`;
}

// The magic value ALLOW_SHARED_PRODUCTION_DB must be set to, exactly, to
// bypass the guard. Deliberately not a bare 'true'/'1' — this has to be
// typed (or consciously pasted) on the command line for one invocation, not
// left sitting in .env where it would silently disarm the guard forever.
const OVERRIDE_TOKEN = 'yes-i-understand-the-risk';

// Refuses to proceed if DATABASE_URL fingerprints as a known-production
// database and this process isn't the real production deployment.
// NODE_ENV=production is set only in server/.env.production, loaded only by
// the actual VPS container (docker-compose.yml's env_file) — never by a
// local `npm test`, `node --test`, or an ad-hoc script — so it's the one
// reliable signal that this is genuinely production running for real, not
// something local pointed at production's connection string by mistake.
//
// There is deliberately no separate dev database (see
// memory/project_shared_dev_prod_db.md — the split was planned, then
// declined) — this IS the only database this app has. So an unconditional
// block would permanently brick every local test and script, not just
// prevent accidents. ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk
// is the deliberate, loud, per-invocation escape hatch: it still writes to
// the real database, so use it consciously, and it warns on every use so
// that stays visible instead of becoming an invisible habit.
// True under Node's own built-in test runner (node --test sets
// NODE_TEST_CONTEXT on every child process it spawns — confirmed directly,
// not assumed: reproduced with this exact repo's own `npm test` invocation,
// `node --test --test-concurrency=1`) or an explicit NODE_ENV=test. Checked
// as an OR of both signals since this project's own npm test script does
// NOT set NODE_ENV (and .env sets NODE_ENV=development, loaded by every
// test file's own dotenv.config() call) — NODE_TEST_CONTEXT is what
// actually fires today; NODE_ENV=test is honored too for a future/different
// test invocation method that sets it explicitly instead.
function isTestContext() {
  return process.env.NODE_ENV === 'test' || !!process.env.NODE_TEST_CONTEXT;
}

function assertNotProductionDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production') return;

  // Hard backstop, independent of the production-fingerprint check below —
  // a test run must never reach a real database at all, full stop, not even
  // via ALLOW_SHARED_PRODUCTION_DB. This project has no separate test
  // database today, so this throws unconditionally for any test that
  // actually calls pool.query()/pool.connect() (a stubs-only test — the
  // established pattern for new tests, see coexistenceEchoIngestion.test.js
  // — never reaches this at all, since it never calls either). Real
  // consequence, stated explicitly rather than discovered later: this DOES
  // currently break every existing test in this suite that deliberately
  // uses ALLOW_SHARED_PRODUCTION_DB against the shared instance (a
  // repeatedly-documented, real pattern this project has relied on — see
  // CLAUDE.md) — until TEST_DATABASE_URL is stood up, only newly-written
  // stubs-only tests can run under `npm test` without this throwing.
  if (isTestContext() && !process.env.TEST_DATABASE_URL) {
    throw new Error(
      'Refusing to connect: running under a test context (NODE_TEST_CONTEXT or NODE_ENV=test) ' +
      'with no TEST_DATABASE_URL set. This project has no separate test database — DATABASE_URL ' +
      'is the same instance as production — so a test must either (a) never call ' +
      'pool.query()/pool.connect() at all (stub every repo function it touches instead), or ' +
      '(b) set TEST_DATABASE_URL to a real, separate database before running. ' +
      'ALLOW_SHARED_PRODUCTION_DB is NOT honored here even if set — a test run must never reach ' +
      'production, full stop.'
    );
  }

  const fp = fingerprint(databaseUrl);
  if (!fp || !KNOWN_PRODUCTION_DATABASES.includes(fp)) return;

  if (process.env.ALLOW_SHARED_PRODUCTION_DB === OVERRIDE_TOKEN) {
    console.warn(
      `\n!!! ALLOW_SHARED_PRODUCTION_DB is set — proceeding against PRODUCTION (${fp}). ` +
      'This is real data. Prefer read-only SSH + docker exec when just inspecting state. !!!\n'
    );
    return;
  }

  throw new Error(
    `Refusing to connect: DATABASE_URL fingerprints as a KNOWN PRODUCTION database (${fp}). ` +
    'Tests and local scripts must not run against it by accident. If you genuinely need to ' +
    `(there is no separate dev database), set ALLOW_SHARED_PRODUCTION_DB=${OVERRIDE_TOKEN} for ` +
    'that one invocation — never in .env. For read-only inspection, prefer SSH + ' +
    '`docker exec wasi-crm ...` on the VPS instead, where NODE_ENV=production is already set. ' +
    'See memory/project_shared_dev_prod_db.md.'
  );
}

module.exports = { assertNotProductionDatabase, fingerprint };
