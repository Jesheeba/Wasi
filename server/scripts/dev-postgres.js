// Local-only Postgres, no Docker/admin required. Used on machines where Docker
// Desktop needs WSL2 that isn't installed. Prefer `npm run db:up` (Docker) when
// available — this is the fallback documented in README.md.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const dataDir = path.join(__dirname, '..', '.pgdata');
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'crm',
  password: 'crm_dev_pw',
  port: 5432,
  persistent: true,
});

async function main() {
  // initialise() runs initdb, which fails on a non-empty data directory —
  // only run it the first time (no PG_VERSION file yet means uninitialised).
  const alreadyInitialised = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (!alreadyInitialised) await pg.initialise();
  await pg.start();
  await pg.createDatabase('crm_dev').catch(() => {});
  console.log('Embedded Postgres running on port 5432 (db: crm_dev, user: crm)');
  console.log('Press Ctrl+C to stop.');
}

process.on('SIGINT', async () => {
  await pg.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pg.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error('Failed to start embedded Postgres:', err);
  process.exit(1);
});
