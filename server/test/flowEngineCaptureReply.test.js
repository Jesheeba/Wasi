// flowEngine.js's captureReply() is the one DB-touching piece of the
// capture_reply node type that's still cheap to unit-test with a fake db
// (same "route on SQL shape" pattern flowValidation.test.js already uses)
// rather than deferring to a live end-to-end check — it's a pure decision
// tree (5 branches) once its two repo calls are stubbed, no Meta API or
// real Postgres involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureReply } = require('../src/services/flowEngine');

const CLIENT_ID = 'client-1';
const CONTACT = { id: 'contact-1', name: 'Priya' };

function fakeDb({ attributesById = {}, upserts = [] }) {
  return {
    async query(sql, params) {
      if (/from contact_attributes\b/.test(sql)) {
        const id = params[1];
        const row = attributesById[id];
        return { rows: row ? [row] : [] };
      }
      if (/insert into contact_attribute_values/.test(sql)) {
        const [, contactId, attributeId, value] = params;
        upserts.push({ contactId, attributeId, value });
        return { rows: [{ attributeId, value }] };
      }
      throw new Error(`fakeDb: unexpected query: ${sql}`);
    },
  };
}

function node(attributeId) {
  return { id: 'n1', config: { body: 'What is your name?', attribute_id: attributeId } };
}

test('captureReply: no attribute configured — skipped, not stored', async () => {
  const db = fakeDb({});
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, { id: 'n1', config: {} }, 'Priya Sharma');
  assert.equal(outcome.captured, false);
  assert.equal(outcome.reason, 'no_attribute_configured');
});

test('captureReply: attribute was deleted after the flow was built — skipped', async () => {
  const db = fakeDb({ attributesById: {} });
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, node('ghost-attr'), 'Priya Sharma');
  assert.equal(outcome.captured, false);
  assert.equal(outcome.reason, 'attribute_no_longer_exists');
});

test('captureReply: an empty/whitespace-only reply is not stored', async () => {
  const db = fakeDb({ attributesById: { 'attr-1': { id: 'attr-1', name: 'full_name', type: 'text' } } });
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, node('attr-1'), '   ');
  assert.equal(outcome.captured, false);
  assert.equal(outcome.reason, 'empty_reply');
});

test('captureReply: a reply that does not match the attribute\'s declared type is not stored', async () => {
  const upserts = [];
  const db = fakeDb({ attributesById: { 'attr-1': { id: 'attr-1', name: 'age', type: 'number' } }, upserts });
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, node('attr-1'), 'twenty five');
  assert.equal(outcome.captured, false);
  assert.equal(outcome.reason, 'value_does_not_match_attribute_type');
  assert.equal(upserts.length, 0);
});

test('captureReply: a valid text reply is trimmed and stored against the configured attribute', async () => {
  const upserts = [];
  const db = fakeDb({ attributesById: { 'attr-1': { id: 'attr-1', name: 'full_name', type: 'text' } }, upserts });
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, node('attr-1'), '  Priya Sharma  ');
  assert.equal(outcome.captured, true);
  assert.equal(outcome.attributeId, 'attr-1');
  assert.equal(outcome.value, 'Priya Sharma');
  assert.deepEqual(upserts, [{ contactId: 'contact-1', attributeId: 'attr-1', value: 'Priya Sharma' }]);
});

test('captureReply: a valid number reply against a number-typed attribute is stored', async () => {
  const upserts = [];
  const db = fakeDb({ attributesById: { 'attr-2': { id: 'attr-2', name: 'age', type: 'number' } }, upserts });
  const outcome = await captureReply(db, CLIENT_ID, CONTACT, node('attr-2'), '25');
  assert.equal(outcome.captured, true);
  assert.equal(upserts[0].value, '25');
});
