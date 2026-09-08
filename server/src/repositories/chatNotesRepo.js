// PLAN.md item 3 — internal notes with @mention. Every read resolves
// author_team_member_id/mentioned_team_member_ids into {id, name} shapes
// (per the plan's own verify text: "confirm it's returned with the mention
// resolved to a name") rather than leaving the caller to look names up
// separately — the raw id columns stay in the response too, for anything
// that needs them directly.

async function resolveNames(db, clientId, notes) {
  if (notes.length === 0) return [];

  const ids = new Set();
  for (const note of notes) {
    if (note.author_team_member_id) ids.add(note.author_team_member_id);
    for (const id of note.mentioned_team_member_ids || []) ids.add(id);
  }

  let nameById = {};
  if (ids.size > 0) {
    const { rows } = await db.query(
      'select id, name from team_members where client_id = $1 and id = any($2::uuid[])',
      [clientId, [...ids]]
    );
    nameById = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  return notes.map((note) => ({
    ...note,
    author: note.author_team_member_id
      ? { id: note.author_team_member_id, name: nameById[note.author_team_member_id] || null }
      : null,
    mentions: (note.mentioned_team_member_ids || []).map((id) => ({ id, name: nameById[id] || null })),
  }));
}

async function list(db, clientId, chatId) {
  const { rows } = await db.query(
    'select * from chat_notes where client_id = $1 and chat_id = $2 order by created_at asc',
    [clientId, chatId]
  );
  return resolveNames(db, clientId, rows);
}

async function create(db, clientId, chatId, { authorTeamMemberId, body, mentions }) {
  const { rows } = await db.query(
    `insert into chat_notes (client_id, chat_id, author_team_member_id, body, mentioned_team_member_ids)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [clientId, chatId, authorTeamMemberId || null, body, mentions || []]
  );
  const [resolved] = await resolveNames(db, clientId, rows);
  return resolved;
}

module.exports = { list, create };
