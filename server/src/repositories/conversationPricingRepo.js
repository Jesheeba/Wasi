const { pool } = require('../db/pool');

async function list() {
  const { rows } = await pool.query(
    'select * from conversation_pricing order by category asc, country_code asc'
  );
  return rows;
}

// Upsert by the table's own unique (category, country_code) pair — an
// admin re-entering a rate for a pair that already exists updates it in
// place, matching this codebase's established "re-entering = updating"
// precedent (tagsRepo.findOrCreateByName) rather than erroring on conflict.
async function upsert({ category, countryCode, rateInr }) {
  const { rows } = await pool.query(
    `insert into conversation_pricing (category, country_code, rate_inr)
     values ($1, $2, $3)
     on conflict (category, country_code)
     do update set rate_inr = excluded.rate_inr, updated_at = now()
     returning *`,
    [category, countryCode, rateInr]
  );
  return rows[0];
}

async function remove(id) {
  const { rowCount } = await pool.query('delete from conversation_pricing where id = $1', [id]);
  return rowCount > 0;
}

// Used by GET /api/analytics/cost-estimate — a plain select against the
// restricted wasi_app role works fine here (table-level SELECT grant,
// migration 055, no RLS: conversation_pricing isn't a tenant table).
async function findRate(db, category, countryCode) {
  const { rows } = await db.query(
    'select rate_inr from conversation_pricing where category = $1 and country_code = $2',
    [category, countryCode]
  );
  return rows[0]?.rate_inr ?? null;
}

module.exports = { list, upsert, remove, findRate };
