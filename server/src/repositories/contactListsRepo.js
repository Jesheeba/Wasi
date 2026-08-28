async function create(db, clientId, { name, source }) {
  const { rows } = await db.query(
    `insert into contact_lists (client_id, name, source) values ($1, $2, coalesce($3, 'csv_import')) returning *`,
    [clientId, name, source || null]
  );
  return rows[0];
}

async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    `select cl.*, coalesce(m.count, 0)::int as member_count
     from contact_lists cl
     left join (select contact_list_id, count(*) as count from contact_list_members group by contact_list_id) m
       on m.contact_list_id = cl.id
     where cl.client_id = $1
     order by cl.created_at desc`,
    [clientId]
  );
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query('select * from contact_lists where client_id = $1 and id = $2', [clientId, id]);
  return rows[0] || null;
}

// Dedup against existing contacts by phone (same upsert-by-phone semantics
// as contactsRepo.upsertByPhone, reused rather than reimplemented): a CSV
// row whose phone already exists as a contact is linked to the existing
// contact row (never creates a duplicate contact), a new phone creates one.
// Membership itself is deduped by contact_list_members' own
// unique(contact_list_id, contact_id) constraint via ON CONFLICT DO NOTHING
// — re-importing the same file (or a file with overlapping rows) is safe
// to re-run, not an error.
async function addMembersFromRows(db, clientId, contactListId, rows) {
  let added = 0;
  for (const row of rows) {
    const { rows: existing } = await db.query(
      'select id from contacts where client_id = $1 and phone = $2',
      [clientId, row.phone]
    );
    let contactId = existing[0]?.id;
    if (!contactId) {
      const { rows: created } = await db.query(
        `insert into contacts (client_id, name, phone, status) values ($1, $2, $3, 'Active') returning id`,
        [clientId, row.name, row.phone]
      );
      contactId = created[0].id;
    }
    const { rowCount } = await db.query(
      `insert into contact_list_members (contact_list_id, contact_id) values ($1, $2) on conflict do nothing`,
      [contactListId, contactId]
    );
    if (rowCount > 0) added++;
  }
  return added;
}

module.exports = { create, listByClientId, findById, addMembersFromRows };
