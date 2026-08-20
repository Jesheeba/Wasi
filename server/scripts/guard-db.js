#!/usr/bin/env node
// db:migrate / db:migrate:down / db:seed run node-pg-migrate / seed.js
// directly — neither goes through src/db/pool.js, so they don't get the
// guard wired in there. Run as a preceding step in package.json instead.
require('dotenv').config();
const { assertNotProductionDatabase } = require('../src/utils/dbSafety');

try {
  assertNotProductionDatabase();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
