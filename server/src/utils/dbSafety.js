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

// Refuses to proceed if DATABASE_URL fingerprints as a known-production
// database and this process isn't the real production deployment.
// NODE_ENV=production is set only in server/.env.production, loaded only by
// the actual VPS container (docker-compose.yml's env_file) — never by a
// local `npm test`, `node --test`, or an ad-hoc script — so it's the one
// reliable signal that this is genuinely production running for real, not
// something local pointed at production's connection string by mistake.
function assertNotProductionDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production') return;
  const fp = fingerprint(databaseUrl);
  if (fp && KNOWN_PRODUCTION_DATABASES.includes(fp)) {
    throw new Error(
      `Refusing to connect: DATABASE_URL fingerprints as a KNOWN PRODUCTION database (${fp}). ` +
      'Tests and local scripts must never run against it. If you genuinely need to inspect ' +
      'production, do it read-only via SSH + `docker exec wasi-crm ...` on the VPS, where ' +
      'NODE_ENV=production is already set — never from a local process. See ' +
      'memory/project_shared_dev_prod_db.md for the incident this guard prevents.'
    );
  }
}

module.exports = { assertNotProductionDatabase, fingerprint };
