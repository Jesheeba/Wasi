// PLAN.md item 7 — per-contact custom attribute values.
async function listForContact(db, clientId, contactId) {
  const { rows } = await db.query(
    `select v.attribute_id as "attributeId", a.name, a.type, v.value
     from contact_attribute_values v
     join contact_attributes a on a.id = v.attribute_id
     where v.client_id = $1 and v.contact_id = $2
     order by a.name`,
    [clientId, contactId]
  );
  return rows;
}

// Upsert on (contact_id, attribute_id) — migration 049's unique constraint.
// Value format is already validated by the route (validateContactAttributeValue,
// against the attribute's declared type) before this is ever called.
async function upsert(db, clientId, contactId, attributeId, value) {
  const { rows } = await db.query(
    `insert into contact_attribute_values (client_id, contact_id, attribute_id, value)
     values ($1, $2, $3, $4)
     on conflict (contact_id, attribute_id) do update set value = excluded.value, updated_at = now()
     returning attribute_id as "attributeId", value`,
    [clientId, contactId, attributeId, value]
  );
  return rows[0];
}

module.exports = { listForContact, upsert };
