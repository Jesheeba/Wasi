async function list(db, clientId) {
  const { rows } = await db.query(
    'select * from contacts where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from contacts where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function create(db, clientId, { name, phone, tag_id, status }) {
  const { rows } = await db.query(
    `insert into contacts (client_id, name, phone, tag_id, status)
     values ($1, $2, $3, $4, coalesce($5, 'Active'))
     returning *`,
    [clientId, name, phone, tag_id || null, status]
  );
  return rows[0];
}

async function update(db, clientId, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(db, clientId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await db.query(
    `update contacts set ${setClause} where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query(
    'delete from contacts where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

async function findByPhone(db, clientId, phone) {
  const { rows } = await db.query(
    'select * from contacts where client_id = $1 and phone = $2',
    [clientId, phone]
  );
  return rows[0] || null;
}

// Inbound webhook messages carry a phone + display name + Meta's wa_id, but
// no guarantee we've seen this sender before — create the contact record on
// first contact, keep it as-is (don't overwrite an agent-edited name) after.
// Only ever called from metaWebhook.js, on the privileged connection.
async function upsertByPhone(db, clientId, { phone, name, wa_id }) {
  const existing = await findByPhone(db, clientId, phone);
  if (existing) {
    if (wa_id && existing.wa_id !== wa_id) {
      const { rows } = await db.query(
        'update contacts set wa_id = $3 where client_id = $1 and id = $2 returning *',
        [clientId, existing.id, wa_id]
      );
      return rows[0];
    }
    return existing;
  }
  const { rows } = await db.query(
    `insert into contacts (client_id, name, phone, wa_id, status)
     values ($1, $2, $3, $4, 'Active')
     returning *`,
    [clientId, name || phone, phone, wa_id || null]
  );
  return rows[0];
}

// PLAN.md item 6 — general contacts CSV import (unlocks the Contacts view's
// already-present-but-disabled Import button). Same atomic
// `INSERT ... ON CONFLICT (client_id, phone) DO UPDATE` pattern
// contactListsRepo.addMembersFromRows already established and its own
// comment documents as the fix for a real TOCTOU race a SELECT-then-INSERT
// approach had (two concurrent imports creating the same new phone could
// both pass a SELECT, then the second INSERT would hit the unique
// constraint uncaught) — deliberately NOT reusing upsertByPhone below,
// which still has that older SELECT-then-conditional-write shape (fine for
// its own single-message-at-a-time inbound-webhook caller, not something
// worth carrying into a new bulk-import path). The DO UPDATE clause is a
// no-op (sets a column to its own existing value), purely so this never
// errors on a re-imported/overlapping file — every valid CSV row always
// succeeds, whether it creates a new contact or matches an existing one by
// phone, which is why the route can just report validRows.length as the
// import count rather than needing this to report per-row new-vs-matched.
//
// Returns [{id, phone}] for every row (new or matched) — item 8's
// tag-on-import wiring (routes/contacts.js) needs the real contact id per
// row to attach that row's parsed `tags`, which lives in the CALLING route
// (not here) since tag find-or-create/attach is a separate repo
// (tagsRepo/contactTagsRepo) and this function stays single-purpose.
async function importFromRows(db, clientId, rows) {
  const results = [];
  for (const row of rows) {
    const { rows: [contact] } = await db.query(
      `insert into contacts (client_id, name, phone, status)
       values ($1, $2, $3, 'Active')
       on conflict (client_id, phone) do update set phone = contacts.phone
       returning id, phone`,
      [clientId, row.name, row.phone]
    );
    results.push(contact);
  }
  return results;
}

module.exports = { list, findById, create, update, remove, findByPhone, upsertByPhone, importFromRows };
