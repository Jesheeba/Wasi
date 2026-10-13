// Test harness: a REAL, throwaway Postgres for the tests that cannot be
// stubs. This project has no separate test database and src/db/pool.js refuses
// any test that touches the shared instance (utils/dbSafety.js), so
// concurrency behaviour (FOR UPDATE SKIP LOCKED, leases, two workers racing)
// was previously untestable here: stubs cannot race.
//
// startEmbeddedPostgres() boots an embedded-postgres server in a temp
// directory on a free port, applies EVERY migration in src/db/migrations (so a
// new migration is also exercised against the full chain), and returns its
// URL. A test sets DATABASE_URL and TEST_DATABASE_URL to that URL BEFORE it
// requires src/db/pool, which is what dbSafety requires of a test that
// connects. Nothing here ever sees the shared database: the URL is localhost
// on an ephemeral port in a directory deleted on stop().
//
// Cost: roughly 10-25 s to boot and migrate. Use one instance per test file.
// Postgres version is whatever the embedded-postgres package ships (18.x beta
// at the time of writing); production is 17.x, so a result here is evidence
// for the SQL's logic, not a statement about 17-specific planner behaviour.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startEmbeddedPostgres({ migrate = true } = {}) {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasi-testpg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'crm', password: 'crm_pw', port, persistent: false,
    // Quiet: postgres is chatty and a test run should not be.
    onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('wasi_test');
  const url = `postgres://crm:crm_pw@localhost:${port}/wasi_test`;

  if (migrate) {
    const { runner } = require('node-pg-migrate');
    await runner({
      databaseUrl: url,
      dir: path.join(__dirname, '..', '..', 'src', 'db', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      count: Infinity,
      log: () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }

  return {
    url,
    async stop() {
      try { await pg.stop(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

module.exports = { startEmbeddedPostgres };
