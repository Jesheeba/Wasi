// Removes everything seedLandingDemo.js created. A single `delete from
// clients` cascades every child table (subscriptions, tags, contacts ->
// contact_tags, chats -> messages, broadcasts -> broadcast_recipients,
// team_members, automation_flows -> flow_nodes/flow_edges) — see migration
// 002/003/007/011/012/013/023/061's onDelete: 'CASCADE' on every one of
// these FKs back to clients.id.
//
// Guarded by matching BOTH the fixed id and the exact demo email, not just
// the id — belt and suspenders against this constant ever being reused for
// something else by mistake.
//
// Run (from server/):
//   ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk npx dotenv -e .env -- node src/db/teardownLandingDemo.js
require('dotenv').config();
const { pool } = require('./pool');

const DEMO_CLIENT_ID = 'f0000000-1111-4111-8111-111111111111';
const DEMO_CLIENT_EMAIL = 'demo+vetri-academy@wasi.local';

async function teardown() {
  try {
    const { rowCount } = await pool.query(
      'delete from clients where id = $1 and email = $2',
      [DEMO_CLIENT_ID, DEMO_CLIENT_EMAIL]
    );
    if (rowCount === 0) {
      console.log('Nothing to remove — demo client not found (already torn down, or never seeded).');
    } else {
      console.log(`Removed demo client ${DEMO_CLIENT_ID} (${DEMO_CLIENT_EMAIL}) and all its rows.`);
    }
  } finally {
    await pool.end();
  }
}

teardown().catch((err) => {
  console.error('Teardown failed:', err);
  process.exit(1);
});
