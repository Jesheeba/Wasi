const { Pool } = require('pg');

// Local dev Postgres (docker-compose / embedded-postgres) has no TLS listener;
// every hosted Postgres we deploy against (Supabase, Render, etc.) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

module.exports = { pool };
