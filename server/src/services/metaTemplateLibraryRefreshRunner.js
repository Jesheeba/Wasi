// Meta Official Template Library refresh (build plan Phase 2b, Phase 0
// decision: server-wide cache, admin-triggered + periodic refresh, never
// fetched live per client request). Same setInterval-poller shape as every
// other background worker in this file's sibling services (broadcastRunner,
// forwardRunner) — but a much longer tick, since the underlying data (Meta's
// own template catalog) changes on the order of weeks, not seconds.
const { pool } = require('../db/pool');
const wabasRepo = require('../repositories/wabasRepo');
const metaTemplateLibraryRepo = require('../repositories/metaTemplateLibraryRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

const TICK_MS = 60 * 60 * 1000; // hourly check
const REFRESH_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Does the real Meta fetch + upsert, callable directly by the admin
// "Refresh now" route (routes/admin.js) bypassing the staleness check, and
// by tick() below when the cache has actually gone stale. Only ever
// requests/stores category UTILITY entries and only ever refreshes the
// zero-variable subset a client can actually use in v1 (Phase 0 decision,
// see migration 042's comment) — parameterized entries are simply never
// fetched, not fetched-then-filtered, since there's no reason to cache
// content v1 never surfaces.
async function refreshNow() {
  const waba = await wabasRepo.findAnyConnected();
  if (!waba) {
    throw new Error('No connected WABA available to fetch the Meta template library — connect at least one client\'s WhatsApp Business Account first.');
  }
  const accessToken = decrypt(waba.access_token_encrypted);

  const catalog = await metaClient.listTemplateLibraryCatalog(accessToken, {});
  const utilityEntries = catalog.filter((entry) => entry.category === 'UTILITY');

  const entries = utilityEntries.map((entry) => ({
    meta_library_id: entry.id,
    name: entry.name,
    category: entry.category,
    language: entry.language,
    topic: entry.topic || null,
    usecase: entry.usecase || null,
    industry: entry.industry || null,
    header_text: entry.header || null,
    body: entry.body,
    footer_text: entry.footer || null,
    buttons_json: entry.buttons || null,
    body_params: entry.body_params || [],
  }));

  const count = await metaTemplateLibraryRepo.upsertBatch(pool, entries);
  // Removes any cached row Meta no longer lists in this fetch (Auditor/QA
  // finding — upsertBatch alone never deleted anything). Scoped to the
  // UTILITY entries this fetch actually saw, not the raw unfiltered
  // catalog — a MARKETING entry was never cached in the first place (see
  // the filter above), so it must never be "pruned" here either.
  await metaTemplateLibraryRepo.pruneMissing(pool, entries.map((e) => e.meta_library_id));
  await metaTemplateLibraryRepo.recordRefreshSuccess(pool, count);
  return count;
}

async function tick() {
  try {
    const meta = await metaTemplateLibraryRepo.getRefreshMeta(pool);
    const isStale = !meta?.last_refreshed_at ||
      (Date.now() - new Date(meta.last_refreshed_at).getTime()) > REFRESH_STALE_AFTER_MS;
    if (!isStale) return;

    await refreshNow();
  } catch (err) {
    console.error('metaTemplateLibraryRefreshRunner tick failed (will retry next tick):', err.message);
    try {
      await metaTemplateLibraryRepo.recordRefreshFailure(pool, err.message);
    } catch (recordErr) {
      console.error('metaTemplateLibraryRefreshRunner: failed to record the failure itself:', recordErr.message);
    }
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}
function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, refreshNow };
