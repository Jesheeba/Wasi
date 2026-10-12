#!/usr/bin/env node
// Backfills chats.last_inbound_at (migration 086) from messages:
//   max(messages.sent_at) where direction = 'in', per chat.
//
//   node scripts/backfill-last-inbound-at.js            # dry run, read-only
//   node scripts/backfill-last-inbound-at.js --apply    # writes
//   --batch-size=N (default 500)
//
// Properties the AI agent work depends on (IMPLEMENTATION.md unit 0.1):
// - Re-runnable and monotonic: only fills rows where last_inbound_at is
//   still null, never overwrites. A chat that received a live inbound
//   message (stamped by chatsRepo.insertInbound) while this runs is left
//   alone, so the script can never move a window backwards.
// - Batched by chat id (keyset), so no single statement holds locks across
//   the whole table.
// - Chats with no inbound message stay null on purpose. Null means "unknown"
//   and every reader must treat it as window closed.
// - Dry run is the default and runs inside `begin read only`, so a bare
//   invocation can never write. Never use a session-level SET over
//   DATABASE_URL (CLAUDE.md): the transaction-mode pooler leaks it.
//
// Runs against whatever DATABASE_URL points at, through src/db/pool.js's
// guard: against the shared production database it refuses unless
// NODE_ENV=production (the real VPS container) or the explicit
// ALLOW_SHARED_PRODUCTION_DB override is set for that one invocation.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../src/db/pool');

function parseArgs(argv) {
  const out = { apply: false, batchSize: 500 };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg.startsWith('--batch-size=')) out.batchSize = Number(arg.split('=')[1]);
  }
  if (!Number.isInteger(out.batchSize) || out.batchSize < 1 || out.batchSize > 5000) {
    throw new Error('--batch-size must be an integer between 1 and 5000');
  }
  return out;
}

async function counts(client) {
  const { rows } = await client.query(
    `select
       (select count(*) from chats)::int as chats_total,
       (select count(*) from chats where last_inbound_at is not null)::int as chats_with_value,
       (select count(*) from chats c where c.last_inbound_at is null
          and exists (select 1 from messages m where m.chat_id = c.id and m.direction = 'in'))::int as chats_fillable`
  );
  return rows[0];
}

async function run({ batchSize }) {
  const client = await pool.connect();
  try {
    const before = await counts(client);
    console.log('before:', before);

    let updated = 0;
    let lastId = null;
    for (;;) {
      const { rows: ids } = await client.query(
        `select id from chats where ($1::uuid is null or id > $1::uuid) order by id limit $2`,
        [lastId, batchSize]
      );
      if (ids.length === 0) break;
      lastId = ids[ids.length - 1].id;
      const { rowCount } = await client.query(
        `update chats c
            set last_inbound_at = agg.ts
           from (select m.chat_id, max(m.sent_at) as ts
                   from messages m
                  where m.chat_id = any($1::uuid[]) and m.direction = 'in'
                  group by m.chat_id) agg
          where c.id = agg.chat_id and c.last_inbound_at is null`,
        [ids.map((r) => r.id)]
      );
      updated += rowCount;
    }

    const after = await counts(client);
    console.log('after: ', after);
    console.log(
      `updated ${updated} chat(s); ${after.chats_with_value} of ${after.chats_total} chats now have a value; ` +
      `${after.chats_total - after.chats_with_value} left null (no inbound message, or none yet).`
    );
  } finally {
    client.release();
  }
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // Dry run is read-only at the transaction level, not just by convention.
  (async () => {
    if (!args.apply) {
      const client = await pool.connect();
      try {
        await client.query('begin read only');
        const before = await counts(client);
        await client.query('rollback');
        console.log('before:', before);
        console.log(`DRY RUN: would fill up to ${before.chats_fillable} chat(s) of ${before.chats_total}. Re-run with --apply to write.`);
      } finally {
        client.release();
      }
    } else {
      await run(args);
    }
  })()
    .then(() => pool.end())
    .catch((err) => {
      console.error('backfill failed:', err.message);
      process.exit(1);
    });
}

module.exports = { parseArgs };
