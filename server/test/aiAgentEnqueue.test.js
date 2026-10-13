// Unit 0.4: the ENQUEUE DECISION (aiAgentRunner.enqueueIfEligible). Stubs only,
// no database: aiJobsRepo is replaced on its singleton, `db` is a throwaway
// object that fails the test if anything queries it.
//
// The trap this file exists for: deciding with `!outcome.handled`. handled is
// false for 'unmatched_input' (an active flow is waiting) and 'flow_error',
// and in both the agent must stay silent. The decision must be
// flowEngine.agentMayAnswer, an allow-list of one outcome. Every outcome the
// flow engine can return is enumerated here, and the mutation check for this
// unit swaps the decision to `!handled` and expects this file to fail.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiJobsRepo = require('../src/repositories/aiJobsRepo');
const { createAiAgentRunner } = require('../src/services/aiAgentRunner');

const restores = [];
function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  restores.push(() => { obj[name] = original; });
}
afterEach(() => { while (restores.length) restores.pop()(); });

const forbiddenDb = { query: async () => { throw new Error('this test must not touch the database'); } };
const INPUT = { clientId: 'client-1', conversationId: 'chat-1', inboundMessageId: 'msg-1' };
const quiet = { error() {}, log() {} };

function runnerWith({ eligible = true } = {}) {
  const handled = [];
  const runner = createAiAgentRunner({
    db: forbiddenDb,
    isEligible: async () => eligible,
    handler: async (job) => { handled.push(job.id); },
    logger: quiet,
  });
  const enqueued = [];
  stub(aiJobsRepo, 'enqueue', async (db, row) => {
    enqueued.push(row);
    return { id: 'job-1', client_id: row.clientId, created_at: new Date(), attempt_count: 1 };
  });
  stub(aiJobsRepo, 'markDone', async () => true);
  return { runner, enqueued, handled };
}

const OUTCOMES_THE_AGENT_MUST_NOT_ANSWER = [
  { handled: true, how: 'flow_continued' },
  { handled: true, how: 'flow_capture_reply' },
  { handled: true, how: 'rule_started_flow' },
  { handled: true, how: 'rule_text_reply' },
  { handled: true, how: 'rule_text_reply_failed' },
  { handled: true, how: 'rule_flow_start_failed' },
  { handled: false, how: 'unmatched_input' },
  { handled: false, how: 'flow_error', error: 'boom' },
  { handled: false, how: 'an_outcome_added_next_year' },
  undefined,
  null,
  {},
];

test('E1: nothing engaged ({handled:false, how:null}) is the ONLY outcome that enqueues', async () => {
  const { runner, enqueued, handled } = runnerWith();
  const result = await runner.enqueueIfEligible({ ...INPUT, flowOutcome: { handled: false, how: null } });
  assert.deepEqual(result, { enqueued: true, jobId: 'job-1' });
  assert.deepEqual(enqueued, [INPUT]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ['job-1'], 'the immediate attempt fired');
});

test('E2: every other outcome stays silent, including the handled:false ones a `!handled` check would let through', async () => {
  for (const flowOutcome of OUTCOMES_THE_AGENT_MUST_NOT_ANSWER) {
    const { runner, enqueued } = runnerWith();
    const result = await runner.enqueueIfEligible({ ...INPUT, flowOutcome });
    assert.equal(result.enqueued, false, `must not enqueue for ${JSON.stringify(flowOutcome)}`);
    assert.equal(enqueued.length, 0, `no job row for ${JSON.stringify(flowOutcome)}`);
    assert.match(result.reason, /^flow_/, 'the reason names the flow outcome, for the gate log');
  }
});

test('E3: a client with no agent is never enqueued, even when nothing engaged (the feature is invisible when off)', async () => {
  const { runner, enqueued } = runnerWith({ eligible: false });
  const result = await runner.enqueueIfEligible({ ...INPUT, flowOutcome: { handled: false, how: null } });
  assert.deepEqual(result, { enqueued: false, reason: 'agent_not_available' });
  assert.equal(enqueued.length, 0);
});

test('E4: the DEFAULT runner (what production gets today) enqueues nothing for anyone', async () => {
  const { createAiAgentRunner: make } = require('../src/services/aiAgentRunner');
  const runner = make({ db: forbiddenDb, logger: quiet }); // default isEligible
  stub(aiJobsRepo, 'enqueue', async () => { throw new Error('must not be called'); });
  const result = await runner.enqueueIfEligible({ ...INPUT, flowOutcome: { handled: false, how: null } });
  assert.deepEqual(result, { enqueued: false, reason: 'agent_not_available' });
});

test('E5: a redelivered message (enqueue returns null) is reported as a duplicate and starts no second attempt', async () => {
  const { runner, handled } = runnerWith();
  stub(aiJobsRepo, 'enqueue', async () => null);
  const result = await runner.enqueueIfEligible({ ...INPUT, flowOutcome: { handled: false, how: null } });
  assert.deepEqual(result, { enqueued: false, reason: 'duplicate' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, []);
});

test('E6: the poller is not started unless AI_AGENT_RUNNER_ENABLED=true (source check of index.js)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /if \(process\.env\.AI_AGENT_RUNNER_ENABLED === 'true'\) aiAgentRunner\.start\(\);/);
  assert.equal((src.match(/aiAgentRunner\.start\(\)/g) || []).length, 1, 'started in exactly one place, behind the flag');
});

test('E7: the enqueue decision is flowEngine.agentMayAnswer and not a boolean on `handled` (source check)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const strip = (s) => s.replace(/\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'aiAgentRunner.js'), 'utf8'));
  assert.match(src, /flowEngine\.agentMayAnswer\(flowOutcome\)/);
  assert.doesNotMatch(src, /!\s*flowOutcome\.handled|flowOutcome\.handled\s*===?\s*false/, 'never decide on the handled boolean');
});
