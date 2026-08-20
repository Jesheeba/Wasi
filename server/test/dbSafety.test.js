// Pure-function tests for the production-database guard (src/utils/
// dbSafety.js) — deliberately does NOT require src/db/pool.js or src/app.js,
// since importing either triggers the real guard against this machine's
// actual DATABASE_URL at module-load time (see pool.js). Testing the guard
// itself must not depend on what database happens to be configured right
// now, positive or negative.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertNotProductionDatabase, fingerprint } = require('../src/utils/dbSafety');

const PROD_URL = 'postgresql://postgres.exvoupxpocybjcxmkuac:secretpass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
const OTHER_URL = 'postgresql://postgres.someotherproject:secretpass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';

function withNodeEnv(value, fn) {
  const original = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
  }
}

test('fingerprint: identifies by username+host+port+dbname, never the password', () => {
  const fp = fingerprint(PROD_URL);
  assert.equal(fp, 'postgres.exvoupxpocybjcxmkuac@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
  assert.ok(!fp.includes('secretpass'), 'the password must never appear in the fingerprint');
});

test('fingerprint: null for missing or unparseable input', () => {
  assert.equal(fingerprint(undefined), null);
  assert.equal(fingerprint('not a url'), null);
});

test('assertNotProductionDatabase: throws for a known-production URL when NODE_ENV is not production', () => {
  withNodeEnv(undefined, () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
  withNodeEnv('development', () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
  withNodeEnv('test', () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
});

test('assertNotProductionDatabase: allows a known-production URL when NODE_ENV=production (the real deployment)', () => {
  withNodeEnv('production', () => {
    assert.doesNotThrow(() => assertNotProductionDatabase(PROD_URL));
  });
});

test('assertNotProductionDatabase: allows any URL not in the known-production list, regardless of NODE_ENV', () => {
  withNodeEnv(undefined, () => {
    assert.doesNotThrow(() => assertNotProductionDatabase(OTHER_URL));
  });
});
