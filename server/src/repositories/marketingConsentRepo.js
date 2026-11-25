// Account-level marketing consent attestation (migration 111). Append-only:
// the latest row per client is the current state.

async function getCurrent(db, clientId) {
  const { rows } = await db.query(
    `select event, statement_version, statement_text, actor_type, actor_id, created_at
       from marketing_consent_attestations
      where client_id = $1
      order by created_at desc, id desc
      limit 1`,
    [clientId]
  );
  return rows[0] || null;
}

async function isAttested(db, clientId) {
  const current = await getCurrent(db, clientId);
  return current?.event === 'attested';
}

async function record(db, clientId, { event, statementVersion, statementText, actorType, actorId }) {
  const { rows } = await db.query(
    `insert into marketing_consent_attestations (client_id, event, statement_version, statement_text, actor_type, actor_id)
     values ($1, $2, $3, $4, $5, $6)
     returning event, statement_version, statement_text, actor_type, actor_id, created_at`,
    [clientId, event, statementVersion, statementText, actorType, actorId || null]
  );
  return rows[0];
}

module.exports = { getCurrent, isAttested, record };
