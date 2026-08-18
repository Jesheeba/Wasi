const { pool } = require('../db/pool');

// The only writer of contacts.opt_in_status/opt_in_source/opt_in_at/opt_out_at
// — every other place that touches a contact (contactCreateSchema,
// contactUpdateSchema, the generic PATCH route) deliberately excludes these
// columns. A consent change always means both the contact's current state
// updates AND an immutable consent_events row gets appended in the same
// transaction — one without the other would leave either a status with no
// evidence, or evidence that never took effect.
//
// Deliberately NOT converted to the `db`-first-param convention (see
// tagsRepo.js) — this function manages its own atomic transaction, and its
// caller on the client-request path (routes/contacts.js) already runs
// inside the tenantContext middleware's own transaction on req.db. Reusing
// that connection here would mean a nested BEGIN (a no-op warning, not a
// real nested transaction) and a COMMIT/ROLLBACK that would prematurely end
// the *whole request's* transaction, not just this one write. Simpler and
// correct to keep this self-contained on its own privileged connection —
// the two writes inside are still atomic with each other, just not part of
// the outer request transaction.
async function recordEvent(clientId, contactId, { event, source, evidence }) {
  const client = await pool.connect();
  client.on('error', (err) => console.error('consentRepo: checked-out client error (non-fatal):', err.message));
  try {
    await client.query('BEGIN');

    const statusColumn = event === 'opted_in' ? 'opt_in_at' : 'opt_out_at';
    const { rows } = await client.query(
      `update contacts
       set opt_in_status = $3, opt_in_source = $4, ${statusColumn} = now()
       where client_id = $1 and id = $2
       returning *`,
      [clientId, contactId, event === 'opted_in' ? 'opted_in' : 'opted_out', source]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `insert into consent_events (client_id, contact_id, event, source, evidence)
       values ($1, $2, $3, $4, $5)`,
      [clientId, contactId, event, source, evidence ? JSON.stringify(evidence) : null]
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listEventsForContact(db, clientId, contactId) {
  const { rows } = await db.query(
    'select * from consent_events where client_id = $1 and contact_id = $2 order by created_at desc',
    [clientId, contactId]
  );
  return rows;
}

module.exports = { recordEvent, listEventsForContact };
