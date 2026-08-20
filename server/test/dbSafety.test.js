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

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name]; else process.env[name] = original;
  }
}

function withNodeEnv(value, fn) {
  withEnv('NODE_ENV', value, fn);
}

// These tests assert the blocking behavior specifically — must run with
// ALLOW_SHARED_PRODUCTION_DB unset regardless of what the invoking shell
// happens to have set (e.g. a real local test run using the override to
// reach the actual shared DB — see the last test below for that path).
function withBlockingConditions(nodeEnvValue, fn) {
  withEnv('ALLOW_SHARED_PRODUCTION_DB', undefined, () => withNodeEnv(nodeEnvValue, fn));
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
  withBlockingConditions(undefined, () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
  withBlockingConditions('development', () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
  withBlockingConditions('test', () => {
    assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
  });
});

test('assertNotProductionDatabase: allows a known-production URL when NODE_ENV=production (the real deployment)', () => {
  withBlockingConditions('production', () => {
    assert.doesNotThrow(() => assertNotProductionDatabase(PROD_URL));
  });
});

test('assertNotProductionDatabase: allows any URL not in the known-production list, regardless of NODE_ENV', () => {
  withBlockingConditions(undefined, () => {
    assert.doesNotThrow(() => assertNotProductionDatabase(OTHER_URL));
  });
});

test('assertNotProductionDatabase: ALLOW_SHARED_PRODUCTION_DB bypasses the block only with the exact token', () => {
  withNodeEnv(undefined, () => {
    withEnv('ALLOW_SHARED_PRODUCTION_DB', 'true', () => { // wrong value — must not bypass
      assert.throws(() => assertNotProductionDatabase(PROD_URL), /KNOWN PRODUCTION database/);
    });
    withEnv('ALLOW_SHARED_PRODUCTION_DB', 'yes-i-understand-the-risk', () => {
      assert.doesNotThrow(() => assertNotProductionDatabase(PROD_URL));
    });
  });
});
