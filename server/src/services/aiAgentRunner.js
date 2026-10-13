// AI agent runner (docs/ai-agent/SPEC.md section 5, IMPLEMENTATION.md unit
// 0.4): consumes the ai_jobs queue (migration 088). Same shape as
// forwardRunner.js and for the same reasons: a Postgres-backed queue polled on
// an interval, claimed with FOR UPDATE SKIP LOCKED, leased at insert so the
// immediate attempt and the periodic tick cannot both work one job, bounded
// retries with backoff, a terminal 'failed' state. It deliberately does NOT
// copy sendabilityMonitorRunner / messagingTierRefreshRunner /
// metaTemplateLibraryRefreshRunner (BUILD_PLAN 3.14): in those, only the
// success path advances the "checked at" column, so a failing row is due on
// every tick forever.
//
// THIS UNIT IS THE QUEUE AND THE RUNNER, NOT THE AGENT. The pipeline (gates,
// prompt, model call, send) is later units; it plugs in as `handler`. Until
// then the default handler throws, which is correct: nothing enqueues a job
// yet because the default `isEligible` says no client has an agent.
//
// "Invisible when off" (SPEC section 16.3, point 8) is enforced twice:
//   - enqueueIfEligible does nothing for a client with no agent (default), and
//   - index.js starts the poller only when AI_AGENT_RUNNER_ENABLED=true.
//
// Runs on the privileged pool, so every query is scoped explicitly.
const aiJobsRepo = require('../repositories/aiJobsRepo');
const flowEngine = require('./flowEngine');

const TICK_MS = 5000;
const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const PURGE_EVERY_MS = 60 * 60 * 1000;

async function notImplementedHandler() {
  throw new Error('AI agent pipeline is not implemented yet');
}
// Replaced in unit 1.1 by "does this client have an enabled agent with
// recorded consent". Until ai_agents exists, no client is eligible.
async function noClientIsEligible() {
  return false;
}

function createAiAgentRunner(options = {}) {
  const {
    handler = notImplementedHandler,
    isEligible = noClientIsEligible,
    leaseSeconds = aiJobsRepo.LEASE_SECONDS,
    maxAttempts = aiJobsRepo.MAX_ATTEMPTS,
    backoffSeconds = aiJobsRepo.BACKOFF_SECONDS,
    batchSize = BATCH_SIZE,
    concurrency = CONCURRENCY,
    tickMs = TICK_MS,
    windowMs = aiJobsRepo.WINDOW_MS,
    logger = console,
  } = options;
  // Resolved lazily so a test that injects `db` never loads the real pool.
  const getDb = () => options.db || require('../db/pool').pool;

  // One audit_log row per terminal failure, never per attempt. Retries are
  // console lines only, exactly like forwardRunner. Never throws: bookkeeping
  // must not turn into a second failure.
  async function recordTerminalFailure(job, reason) {
    try {
      await getDb().query(
        `insert into audit_log (actor_type, actor_id, action, target)
         values ('system', null, 'ai_job_failed', $1)`,
        [`${job.client_id}: job ${job.id} (inbound ${job.inbound_message_id}) failed after ${job.attempt_count} attempt(s): ${reason}`]
      );
    } catch (err) {
      logger.error('aiAgentRunner: could not record terminal failure (non-fatal):', err.message);
    }
  }

  async function processJob(job) {
    const db = getDb();

    if (Date.now() - new Date(job.created_at).getTime() > windowMs) {
      // The reply could no longer be sent: retrying cannot help.
      if (await aiJobsRepo.markFailedTerminal(db, job, 'window_expired')) {
        logger.error('aiAgent PERMANENT FAILURE:', { jobId: job.id, clientId: job.client_id, error: 'window_expired' });
        await recordTerminalFailure(job, 'window_expired');
      }
      return;
    }

    try {
      await handler(job);
      await aiJobsRepo.markDone(db, job);
    } catch (err) {
      const { applied, giveUp } = await aiJobsRepo.markFailedAttempt(db, job, err.message, { maxAttempts, backoffSeconds });
      if (!applied) return; // a newer attempt owns this job; this result is stale
      logger.error(giveUp ? 'aiAgent PERMANENT FAILURE:' : 'aiAgent retry scheduled:', {
        jobId: job.id, clientId: job.client_id, attempt: job.attempt_count, error: err.message,
      });
      if (giveUp) await recordTerminalFailure(job, err.message);
    }
  }

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

  let ticking = false;
  let lastPurgeAt = 0;
  async function tick() {
    if (ticking) return; // a slow tick must not stack a second on top of itself
    ticking = true;
    try {
      const db = getDb();
      for (const job of await aiJobsRepo.sweepExhausted(db, { maxAttempts })) {
        logger.error('aiAgent PERMANENT FAILURE:', { jobId: job.id, clientId: job.client_id, error: 'attempts exhausted' });
        await recordTerminalFailure(job, 'attempts exhausted without a result');
      }
      const batch = await aiJobsRepo.claimDueBatch(db, batchSize, { leaseSeconds, maxAttempts });
      if (batch.length > 0) await runWithConcurrency(batch, concurrency, processJob);

      if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
        lastPurgeAt = Date.now();
        await aiJobsRepo.purgeFinished(db);
      }
    } catch (err) {
      logger.error('aiAgentRunner tick failed:', err.message);
    } finally {
      ticking = false;
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(tick, tickMs);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Fire-and-forget, like forwardRunner.attemptImmediately: the row is already
  // leased by enqueue(), so the tick cannot take it concurrently. processJob
  // catches its own errors; the .catch is a backstop for a DB failure inside
  // the bookkeeping itself.
  function attemptImmediately(job) {
    processJob(job).catch((err) => {
      logger.error('aiAgentRunner: immediate attempt crashed unexpectedly:', { jobId: job.id, error: err.message });
    });
  }

  // The enqueue decision, called from routes/metaWebhook.js after the flow
  // engine has looked at the message. Returns { enqueued, reason?, jobId? }.
  // `reason` is for the gate log that arrives with ai_gate_log (SPEC
  // section 7); nothing consumes it yet.
  //
  // IT MUST DECIDE WITH flowEngine.agentMayAnswer, NOT `!outcome.handled`.
  // `handled` is false for 'unmatched_input' (an active flow is waiting) and
  // for 'flow_error', and in both the agent must stay silent. agentMayAnswer
  // is an allow-list of the single "nothing engaged" outcome, so any outcome
  // added later is silent by default. Do not "simplify" this to the boolean:
  // that reintroduces the fail-open behaviour the allow-list exists to stop.
  async function enqueueIfEligible({ clientId, conversationId, inboundMessageId, flowOutcome }) {
    if (!flowEngine.agentMayAnswer(flowOutcome)) {
      return { enqueued: false, reason: `flow_${flowOutcome && flowOutcome.how ? flowOutcome.how : 'unknown'}` };
    }
    if (!(await isEligible(clientId))) {
      return { enqueued: false, reason: 'agent_not_available' };
    }
    const job = await aiJobsRepo.enqueue(getDb(), { clientId, conversationId, inboundMessageId }, { leaseSeconds });
    if (!job) return { enqueued: false, reason: 'duplicate' };
    attemptImmediately(job);
    return { enqueued: true, jobId: job.id };
  }

  return { start, stop, tick, processJob, attemptImmediately, enqueueIfEligible };
}

const defaultRunner = createAiAgentRunner();
module.exports = { ...defaultRunner, createAiAgentRunner };
