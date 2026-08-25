#!/usr/bin/env node
// One-time cutover between SECRET_STORE backends (server/src/utils/
// encryption.js) — decrypts every wabas.access_token_encrypted value
// under the OLD backend and re-encrypts it under the NEW one. Necessary
// because encryption.js does NOT auto-detect which backend produced a
// given stored value or try both — switching SECRET_STORE on a database
// that still has rows encrypted under the other backend breaks decryption
// for those rows outright (every send, template action, business-profile
// call, etc. for that client starts failing).
//
// This script goes through db/pool.js like everything else in this app,
// so dbSafety.js's production guard applies exactly as it does to
// db:migrate/db:seed — if DATABASE_URL fingerprints as a known production
// database, this refuses to run unless ALLOW_SHARED_PRODUCTION_DB is set
// for that one invocation. That guard is necessary but not sufficient
// here: this rewrites every client's live WABA access token, so on top of
// it, this script also requires its own explicit ROTATE_CONFIRM flag
// (below) — getting this wrong doesn't just risk an accident, it risks a
// production outage for every connected client at once.
//
// Usage:
//   ROTATE_FROM=env ROTATE_TO=supabase_vault ROTATE_DRY_RUN=1 node scripts/rotate-secret-store.js
//     — dry run: decrypts under ROTATE_FROM, encrypts under ROTATE_TO,
//       reports what WOULD change, writes nothing. Always run this first.
//   ROTATE_FROM=env ROTATE_TO=supabase_vault ROTATE_CONFIRM=yes-rotate-tokens node scripts/rotate-secret-store.js
//     — the real thing. Writes the new ciphertext/reference for every row.
//
// After this completes successfully (zero failures), flip SECRET_STORE to
// ROTATE_TO in the environment and restart the app — not before, and not
// automatically by this script, since that's a separate deploy step this
// script has no business making for you.
require('dotenv').config();
const wabasRepo = require('../src/repositories/wabasRepo');
const { pool } = require('../src/db/pool');
const envKeyStore = require('../src/utils/secretStores/envKeyStore');
const supabaseVaultStore = require('../src/utils/secretStores/supabaseVaultStore');

const STORES = { env: envKeyStore, supabase_vault: supabaseVaultStore };
const CONFIRM_TOKEN = 'yes-rotate-tokens';

async function main() {
  const fromName = process.env.ROTATE_FROM;
  const toName = process.env.ROTATE_TO;
  const dryRun = Boolean(process.env.ROTATE_DRY_RUN);
  const confirmed = process.env.ROTATE_CONFIRM === CONFIRM_TOKEN;

  if (!fromName || !toName) {
    throw new Error('Set ROTATE_FROM and ROTATE_TO (one of: ' + Object.keys(STORES).join(', ') + ').');
  }
  if (fromName === toName) {
    throw new Error('ROTATE_FROM and ROTATE_TO are the same — nothing to rotate.');
  }
  const from = STORES[fromName];
  const to = STORES[toName];
  if (!from || !to) {
    throw new Error(`Unknown store name(s) — expected one of: ${Object.keys(STORES).join(', ')}.`);
  }
  if (!dryRun && !confirmed) {
    throw new Error(
      `This writes a new access token reference for every connected WABA. ` +
      `Run with ROTATE_DRY_RUN=1 first, then re-run with ROTATE_CONFIRM=${CONFIRM_TOKEN} once you've reviewed it.`
    );
  }

  const wabas = await wabasRepo.listAllWithClient();
  const withToken = wabas.filter((w) => w.access_token_encrypted);
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Rotating ${withToken.length} WABA token(s) from "${fromName}" to "${toName}"...`);

  let succeeded = 0;
  const failures = [];
  for (const waba of withToken) {
    try {
      const plainText = await from.decrypt(waba.access_token_encrypted);
      const newValue = await to.encrypt(plainText);
      if (!dryRun) {
        await pool.query('update wabas set access_token_encrypted = $1 where id = $2', [newValue, waba.id]);
      }
      succeeded += 1;
      console.log(`  OK  ${waba.client_name} (waba ${waba.waba_id})`);
    } catch (err) {
      failures.push({ waba, err });
      console.error(`  FAIL  ${waba.client_name} (waba ${waba.waba_id}): ${err.message}`);
    }
  }

  console.log(`\n${succeeded}/${withToken.length} succeeded, ${failures.length} failed.`);
  if (failures.length) {
    console.error(
      '\nDo NOT flip SECRET_STORE while any row failed — those clients\' tokens are still only ' +
      `readable under "${fromName}". Investigate the failures above, or leave SECRET_STORE=${fromName} until they're resolved.`
    );
    process.exitCode = 1;
  } else if (dryRun) {
    console.log(`\nDry run clean. Re-run with ROTATE_CONFIRM=${CONFIRM_TOKEN} (no ROTATE_DRY_RUN) to actually write.`);
  } else {
    console.log(`\nAll rows rotated. Set SECRET_STORE=${toName} and restart the app.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
