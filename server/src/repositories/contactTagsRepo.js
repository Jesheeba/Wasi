// PLAN.md item 8 - multi-tag contacts, additive to contacts.tag_id (the
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

// ON CONFLICT DO NOTHING against the (contact_id, tag_id) primary key -
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

// Every contact's attached tag ids, for the Contacts list (one query, not
// one per contact). Kept out of contactsRepo.list so the Hub API's
// GET /api/v1/contacts response shape is unchanged.
async function tagIdsByContact(db, clientId) {
  const { rows } = await db.query(
    `select contact_id, array_agg(tag_id) as tag_ids
     from contact_tags where client_id = $1 group by contact_id`,
    [clientId]
  );
  return new Map(rows.map((r) => [r.contact_id, r.tag_ids]));
}

// Bulk add: only ids that belong to this client are tagged (the join on
// contacts filters out foreign or deleted ids). Returns how many contacts
// newly got the tag; already-tagged ones are a no-op.
async function addMany(db, clientId, contactIds, tagId) {
  const { rowCount } = await db.query(
    `insert into contact_tags (contact_id, tag_id, client_id)
     select c.id, $3, c.client_id from contacts c
     where c.client_id = $1 and c.id = any($2::uuid[])
     on conflict (contact_id, tag_id) do nothing`,
    [clientId, contactIds, tagId]
  );
  return rowCount;
}

// Bulk remove: detaches the chip AND clears it as the primary tag
// (contacts.tag_id), otherwise the tag would still show and still match
// tag-targeted broadcasts, so "Remove tag" would look like it did nothing.
// Returns how many contacts had the tag (either form).
async function removeMany(db, clientId, contactIds, tagId) {
  const { rows } = await db.query(
    `with detached as (
       delete from contact_tags
       where client_id = $1 and contact_id = any($2::uuid[]) and tag_id = $3
       returning contact_id
     ), cleared as (
       update contacts set tag_id = null
       where client_id = $1 and id = any($2::uuid[]) and tag_id = $3
       returning id as contact_id
     )
     select count(distinct contact_id)::int as n
     from (select contact_id from detached union all select contact_id from cleared) x`,
    [clientId, contactIds, tagId]
  );
  return rows[0].n;
}

module.exports = { listForContact, add, remove, tagIdsByContact, addMany, removeMany };
