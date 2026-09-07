// PLAN.md item 2 — gives `chats` the assignment/status columns the
// Unassigned/Mine/All/Resolved queue model needs; neither existed before
// this (chats had no agent-routing concept at all, tag_id-based only).
//
// The backfill below is the whole point of this migration, not an
// afterthought: a bare ADD COLUMN status DEFAULT 'open' would put every one
// of 6 live clients' entire chat history into one live Unassigned/Open
// queue at once. A chat only STAYS 'open' if it has a genuinely unanswered
// inbound message from the last 24 hours (the signal the user chose,
// replacing an earlier last_message_at-age draft of this migration) —
// everything else (already replied to, or just stale) backfills to
// 'resolved'. assigned_team_member_id stays NULL for every historical chat
// (there is no historical assignment data to backfill from) — expected,
// not a bug, since the backfill already keeps the initial Unassigned queue
// small.
//
// The inner "was this inbound answered" check uses >= , not a strict >,
// against the reply's sent_at — found live against this app's own demo
// seed data, not hypothetical: seed.js inserts an 'in' then 'out' message
// for each demo chat inside ONE transaction, and Postgres's now() is fixed
// for an entire transaction (transaction_timestamp(), not per-statement),
// so both messages land with the IDENTICAL sent_at. A strict > wrongly
// treated that as still-unanswered. >= correctly counts a reply at or after
// the inbound's own timestamp as addressing it — no real inbound and its
// real reply need to be distinguishable by more than a timestamp's
// resolution for the reply to count.
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    assigned_team_member_id: { type: 'uuid', references: 'team_members', onDelete: 'SET NULL' },
    status: { type: 'text', notNull: true, default: 'open', check: "status in ('open', 'resolved')" },
  });
  pgm.createIndex('chats', ['client_id', 'assigned_team_member_id']);
  pgm.createIndex('chats', ['client_id', 'status']);

  pgm.sql(`
    update chats c
    set status = 'resolved'
    where not exists (
      select 1 from messages m_in
      where m_in.chat_id = c.id
        and m_in.direction = 'in'
        and m_in.sent_at > now() - interval '24 hours'
        and not exists (
          select 1 from messages m_out
          where m_out.chat_id = c.id
            and m_out.direction = 'out'
            and m_out.sent_at >= m_in.sent_at
        )
    )
  `);
};

exports.down = async (pgm) => {
  // Live-row guard, same discipline as migrations 032/036/039/040 — refuse
  // if any chat has real post-migration triage state (a non-default status
  // or a real assignment), even though this means a rollback is very
  // likely to be refused almost immediately after real use begins.
  const [{ count }] = await pgm.db.select(
    "select count(*)::int as count from chats where status <> 'open' or assigned_team_member_id is not null"
  );
  if (count > 0) {
    throw new Error(
      `Cannot roll back 045_chat_assignment_status: ${count} chat(s) have real triage state ` +
      `(a non-default status or an assignment) since this migration ran. Rolling back would ` +
      `silently discard it — export/back up first if it needs to be kept, then retry.`
    );
  }

  pgm.dropIndex('chats', ['client_id', 'status']);
  pgm.dropIndex('chats', ['client_id', 'assigned_team_member_id']);
  pgm.dropColumns('chats', ['assigned_team_member_id', 'status']);
};
