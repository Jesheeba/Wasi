// Delay/timeout poller for the flow engine — same shape as
// broadcastRunner.js/forwardRunner.js: setInterval tick, atomic
// claim-batch-then-release, execute unlocked (may call out to Meta),
// finalize with its own atomic write. Without this, a contact sitting at a
// delay node or an un-replied send_interactive_buttons node with a timeout
// edge would stay 'active' forever — nothing else in the codebase ever
// looks at contact_flow_state.due_at.
const { pool } = require('../db/pool');
const contactFlowStateRepo = require('../repositories/contactFlowStateRepo');
const contactsRepo = require('../repositories/contactsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const flowEngine = require('./flowEngine');
const logger = require('../utils/logger');
const { captureException } = require('../utils/errorTracking');

const TICK_MS = 5000;
const BATCH_SIZE = 25;
const ADVANCE_CONCURRENCY = 5;

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

async function advanceOne(row) {
  const base = { clientId: row.client_id, contactId: row.contact_id, expectedNodeId: row.current_node_id };
  try {
    const contact = await contactsRepo.findById(pool, row.client_id, row.contact_id);
    if (!contact) {
      // Contact deleted mid-flight (flow_nodes/edges/contact_flow_state all
      // cascade-delete with the client, but a single contact row can be
      // removed independently) — nothing left to message, end the flow.
      await contactFlowStateRepo.finalizeProcessing(pool, { ...base, nodeId: row.current_node_id, status: 'cancelled' });
      return;
    }
    const chat = await chatsRepo.findOrCreateByContact(pool, row.client_id, contact);
    const rest = await flowEngine.advanceDueNode(pool, row.client_id, contact, chat, row);
    await contactFlowStateRepo.finalizeProcessing(pool, { ...base, ...rest });
  } catch (err) {
    logger.error({ err, contactId: row.contact_id, clientId: row.client_id }, 'flowRunner: advanceOne failed');
    captureException(err);
    // Resolve the claim one way or another — leaving it 'processing'
    // forever (or worse, throwing back to a caller that never retries)
    // would mean this contact never gets reclaimed by the 5-minute stuck-row
    // sweep in claimDueBatch either, since that sweep only fires for rows
    // still sitting in 'processing', which this already is. 'stalled' here
    // is the same "visible failure, not silent" outcome runToRest uses for
    // an execution error mid-flow.
    await contactFlowStateRepo.finalizeProcessing(pool, { ...base, nodeId: row.current_node_id, status: 'stalled' }).catch(() => {});
  }
}

async function tick() {
  try {
    const batch = await contactFlowStateRepo.claimDueBatch(pool, BATCH_SIZE);
    if (batch.length > 0) {
      await runWithConcurrency(batch, ADVANCE_CONCURRENCY, advanceOne);
    }
  } catch (err) {
    logger.error({ err }, 'flowRunner tick failed');
    captureException(err);
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

module.exports = { start, stop, tick, advanceOne };
