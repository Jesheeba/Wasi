// PLAN.md item 8 — multi-tag contacts, additive to contacts.tag_id (the
// permanent "primary tag", untouched by any function here).
async function listForContact(db, clientId, contactId) {
  const { rows } = await db.query(
    `select t.id, t.name, t.bg, t.color
     from contact_tags ct
     join tags t on t.id = ct.tag_id
     where ct.client_id = $1 and ct.contact_id = $2
     order by t.name`,
    [clientId, contactId]
  );
  return rows;
}

// ON CONFLICT DO NOTHING against the (contact_id, tag_id) primary key —
// attaching an already-attached tag is a safe no-op, not an error (same
// idempotent-import discipline as contactsRepo.importFromRows).
async function add(db, clientId, contactId, tagId) {
  await db.query(
    `insert into contact_tags (contact_id, tag_id, client_id)
     values ($1, $2, $3)
     on conflict (contact_id, tag_id) do nothing`,
    [contactId, tagId, clientId]
  );
}

async function remove(db, clientId, contactId, tagId) {
  const { rowCount } = await db.query(
    'delete from contact_tags where client_id = $1 and contact_id = $2 and tag_id = $3',
    [clientId, contactId, tagId]
  );
  return rowCount > 0;
}

module.exports = { listForContact, add, remove };
