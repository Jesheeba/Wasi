// contactsRepo.create/update must attach a primary tag to contact_tags too:
// segment-by-tag targeting (utils/segmentFilter.js) and the analytics tag
// counts read contact_tags only, so a contact with tag_id but no matching
// contact_tags row was invisible to both.
//
// Stubs only — this project's DB guard refuses any test that reaches the real
// database (see utils/dbSafety.js). The real SQL was checked separately inside
// a rolled-back transaction; this pins the statement shape so a refactor can't
// silently drop the contact_tags write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const contactsRepo = require('../src/repositories/contactsRepo');

function fakeDb(rows = [{ id: 'c1' }]) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } };
}

test('create with a tag inserts the contact and its contact_tags row in ONE statement', async () => {
  const db = fakeDb();
  await contactsRepo.create(db, 'client-1', { name: 'A', phone: '+911', tag_id: 'tag-1' });
  assert.equal(db.calls.length, 1, 'both writes must share a single statement (atomic)');
  assert.match(db.calls[0].sql, /insert into contacts/);
  assert.match(db.calls[0].sql, /insert into contact_tags/);
  assert.match(db.calls[0].sql, /on conflict \(contact_id, tag_id\) do nothing/);
  assert.equal(db.calls[0].params[3], 'tag-1');
});

test('create without a tag passes null (the contact_tags insert selects nothing)', async () => {
  const db = fakeDb();
  await contactsRepo.create(db, 'client-1', { name: 'A', phone: '+911' });
  assert.equal(db.calls[0].params[3], null);
  assert.match(db.calls[0].sql, /where tag_id is not null/);
});

test('update that sets tag_id also attaches it to contact_tags', async () => {
  const db = fakeDb();
  await contactsRepo.update(db, 'client-1', 'c1', { tag_id: 'tag-2' });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /update contacts set tag_id = \$3/);
  assert.match(db.calls[0].sql, /insert into contact_tags/);
});

test('update that does not touch tag_id, or clears it, never writes contact_tags', async () => {
  for (const fields of [{ name: 'New name' }, { tag_id: null }]) {
    const db = fakeDb();
    await contactsRepo.update(db, 'client-1', 'c1', fields);
    assert.doesNotMatch(db.calls[0].sql, /contact_tags/);
  }
});

test('update returns null when the contact does not exist', async () => {
  const db = fakeDb([]);
  assert.equal(await contactsRepo.update(db, 'client-1', 'nope', { tag_id: 'tag-2' }), null);
});
