// Unit 0.4 (docs/ai-agent/IMPLEMENTATION.md): ai_jobs and its runner.
//
// REAL POSTGRES, not stubs: single-claim safety, leases and two workers
// racing cannot be shown with stubs. test/support/embeddedPostgres.js boots a
// throwaway embedded Postgres on an ephemeral port and applies every
// migration. This file never touches the shared database: the pools below are
// raw pg Pools pointed at that instance, and the repo/runner take `db` as a
// parameter, so src/db/pool.js's guard is never involved.
//
// The five tests the runbook requires are J1-J5 in the titles so they can be
// reported individually; the rest are supporting tests for failure modes that
// would otherwise be silent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { startEmbeddedPostgres } = require('./support/embeddedPostgres');

let pgServer;
let poolA;
let poolB;
let admin; // a third pool for seeding and inspection
let repo;
let runnerModule;
let seed;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  pgServer = await startEmbeddedPostgres();
  poolA = new Pool({ connectionString: pgServer.url, max: 5 });
  poolB = new Pool({ connectionString: pgServer.url, max: 5 });
  admin = new Pool({ connectionString: pgServer.url, max: 5 });
  repo = require('../src/repositories/aiJobsRepo');
  runnerModule = require('../src/services/aiAgentRunner');

  const client = (await admin.query(
    `insert into clients (name, email, password_hash, tenant_slug) values ('AI jobs test', 'aijobs@test.local', 'x', 'aijobs') returning id`
  )).rows[0];
  const contact = (await admin.query(
    `insert into contacts (client_id, name, phone) values ($1, 'C', '919000000001') returning id`, [client.id]
  )).rows[0];
  const chat = (await admin.query(
    `insert into chats (client_id, contact_id, name) values ($1, $2, 'C') returning id`, [client.id, contact.id]
  )).rows[0];

  let counter = 0;
  seed = {
    clientId: client.id,
    chatId: chat.id,
    // A real inbound message row (the FK target); returns its id.
    async message() {
      counter += 1;
      const { rows } = await admin.query(
        `insert into messages (chat_id, client_id, direction, body, meta_message_id, status)
         values ($1, $2, 'in', 'hi', $3, 'delivered') returning id`,
        [chat.id, client.id, `wamid.AIJOBS.${counter}.${Date.now()}`]
      );
      return rows[0].id;
    },
    // A job row in an exact state, bypassing enqueue's leasing.
    async job({ status = 'pending', attemptCount = 0, dueInSeconds = -1, ageHours = 0 } = {}) {
      const messageId = await this.message();
      const { rows } = await admin.query(
        `insert into ai_jobs (client_id, conversation_id, inbound_message_id, status, attempt_count, next_attempt_at, created_at)
         values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision), now() - make_interval(hours => $7::int))
         returning *`,
        [client.id, chat.id, messageId, status, attemptCount, dueInSeconds, ageHours]
      );
      return rows[0];
    },
    async get(id) { return (await admin.query('select * from ai_jobs where id = $1', [id])).rows[0]; },
    async auditRowsFor(jobId) {
      return (await admin.query(
        `select * from audit_log where action = 'ai_job_failed' and target like $1`, [`%${jobId}%`]
      )).rows;
    },
  };
});

after(async () => {
  await Promise.all([poolA, poolB, admin].filter(Boolean).map((p) => p.end().catch(() => {})));
  if (pgServer) await pgServer.stop();
});

// Runner wired to a real pool, with test-speed timings and a scripted handler.
function runnerOn(pool, handler, extra = {}) {
  return runnerModule.createAiAgentRunner({
    db: pool, handler, backoffSeconds: [0, 0, 0], leaseSeconds: 60, logger: { error() {}, log() {} }, ...extra,
  });
}

// =============================================================================
// THE FIVE REQUIRED TESTS
// =============================================================================

test('J1: a job can be enqueued, arrives leased and counted as attempt 1, and a redelivered webhook cannot enqueue it twice', async () => {
  const messageId = await seed.message();
  const input = { clientId: seed.clientId, conversationId: seed.chatId, inboundMessageId: messageId };

  const job = await repo.enqueue(admin, input);
  assert.ok(job && job.id);
  assert.equal(job.status, 'processing');
  assert.equal(job.attempt_count, 1);
  assert.ok(new Date(job.next_attempt_at).getTime() > Date.now() + 60_000, 'leased: not due, so the tick cannot race the immediate attempt');
  assert.equal(job.client_id, seed.clientId);
  assert.equal(job.inbound_message_id, messageId);

  assert.equal(await repo.enqueue(admin, input), null, 'second enqueue for the same inbound message is a no-op');
  const { rows } = await admin.query('select count(*)::int n from ai_jobs where inbound_message_id = $1', [messageId]);
  assert.equal(rows[0].n, 1);

  // And a freshly leased job is invisible to a claim until its lease expires.
  assert.deepEqual(await repo.claimDueBatch(poolA, 10), []);
});

test('J2: two concurrent runners claim one job EXACTLY ONCE', async (t) => {
  await t.test('end to end: two runner instances ticking at the same instant run the handler once', async () => {
    const job = await seed.job();
    const calls = [];
    const handler = async (j) => { calls.push(j.id); await sleep(80); };
    const a = runnerOn(poolA, handler);
    const b = runnerOn(poolB, handler);
    await Promise.all([a.tick(), b.tick()]);
    assert.deepEqual(calls, [job.id], 'the handler ran for this job exactly once');
    const row = await seed.get(job.id);
    assert.equal(row.status, 'done');
    assert.equal(row.attempt_count, 1);
  });

  await t.test('40 randomised races on a single due job: the claim count is always exactly 1', async () => {
    for (let i = 0; i < 40; i += 1) {
      const job = await seed.job();
      const [x, y] = await Promise.all([repo.claimDueBatch(poolA, 10), repo.claimDueBatch(poolB, 10)]);
      const mine = [...x, ...y].filter((r) => r.id === job.id);
      assert.equal(mine.length, 1, `trial ${i}: job claimed ${mine.length} times`);
      // Leave nothing due for the next trial.
      await admin.query(`update ai_jobs set status = 'done' where id = $1`, [job.id]);
    }
  });

  await t.test('deterministic: a row locked by another in-flight claim is SKIPPED, not waited on and not double-claimed', async () => {
    const job = await seed.job();
    const holder = await poolA.connect();
    let resolvedWhileLocked = false;
    let other;
    try {
      await holder.query('begin');
      const locked = await holder.query('select id from ai_jobs where id = $1 for update', [job.id]);
      assert.equal(locked.rowCount, 1);
      // Start the second claim WITHOUT awaiting it, give it time, then look.
      // Awaiting it directly would hang this test forever if the claim ever
      // blocked on the lock (which is the failure being tested for), because
      // the lock is only released further down.
      const pending = repo.claimDueBatch(poolB, 10).then((rows) => { resolvedWhileLocked = true; return rows; });
      await sleep(1000);
      assert.equal(resolvedWhileLocked, true, 'the second claim must return while the row is still locked (skipped), not wait for it');
      other = await pending;
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    assert.equal(other.filter((r) => r.id === job.id).length, 0, 'the locked row was skipped, not double-claimed');
    await admin.query(`update ai_jobs set status = 'done' where id = $1`, [job.id]);
  });

  await t.test('bulk: 4 workers draining 60 due jobs claim each job exactly once and never exceed the batch limit', async () => {
    await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
    const ids = [];
    for (let i = 0; i < 60; i += 1) ids.push((await seed.job()).id);

    const pools = [poolA, poolB, admin, poolA];
    const claimedBy = pools.map(() => []);
    await Promise.all(pools.map(async (pool, w) => {
      for (;;) {
        const batch = await repo.claimDueBatch(pool, 7);
        assert.ok(batch.length <= 7, `batch of ${batch.length} exceeded the limit of 7`);
        if (batch.length === 0) return;
        claimedBy[w].push(...batch.map((r) => r.id));
      }
    }));
    const all = claimedBy.flat();
    assert.equal(all.length, 60, 'every job was claimed');
    assert.equal(new Set(all).size, 60, 'and none was claimed twice');
    assert.deepEqual([...new Set(all)].sort(), [...ids].sort());
    await admin.query(`update ai_jobs set status = 'done' where status = 'processing'`);
  });
});

test('J3: a job claimed and abandoned becomes reclaimable once its lease expires, and a stale worker cannot overwrite the new attempt', async () => {
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
  const job = await seed.job();

  const first = await repo.claimDueBatch(poolA, 10, { leaseSeconds: 1 });
  assert.equal(first.length, 1);
  assert.equal(first[0].attempt_count, 1);

  assert.deepEqual(await repo.claimDueBatch(poolB, 10, { leaseSeconds: 1 }), [], 'still leased: not claimable');

  await sleep(1300); // the worker "crashed": it never reports a result
  const second = await repo.claimDueBatch(poolB, 10, { leaseSeconds: 60 });
  assert.equal(second.length, 1, 'reclaimable after the lease expired');
  assert.equal(second[0].id, job.id);
  assert.equal(second[0].attempt_count, 2, 'the abandoned attempt still counted');

  // The first worker was only slow, not dead. Its late result must be ignored.
  assert.equal(await repo.markDone(poolA, first[0]), false, 'stale attempt 1 cannot complete the job');
  const failedStale = await repo.markFailedAttempt(poolA, first[0], 'late failure');
  assert.equal(failedStale.applied, false, 'nor can it fail it');
  assert.equal((await seed.get(job.id)).status, 'processing', 'attempt 2 still owns the job');

  assert.equal(await repo.markDone(poolB, second[0]), true, 'the live attempt completes it');
  assert.equal((await seed.get(job.id)).status, 'done');
});

test('J4: a job that fails repeatedly reaches a terminal state and STOPS retrying', async () => {
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
  const job = await seed.job();
  let calls = 0;
  const runner = runnerOn(poolA, async () => { calls += 1; throw new Error('model API 503'); });

  for (let i = 0; i < 8; i += 1) await runner.tick(); // far more ticks than attempts

  const row = await seed.get(job.id);
  assert.equal(calls, 3, 'the handler ran exactly MAX_ATTEMPTS times, then never again');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempt_count, 3);
  assert.equal(row.last_error, 'model API 503');
  assert.ok(row.finished_at, 'finished_at is set');
  assert.deepEqual(await repo.claimDueBatch(poolA, 10), [], 'a failed job is never claimable again');

  // The crash-loop variant: workers that die without ever reporting. Without
  // counting attempts at CLAIM time this would be re-claimed forever.
  const crashy = await seed.job();
  const claims = [];
  for (let i = 0; i < 6; i += 1) {
    const got = await repo.claimDueBatch(poolA, 10, { leaseSeconds: 0 });
    claims.push(...got.filter((r) => r.id === crashy.id));
  }
  assert.equal(claims.length, 3, 'claimed MAX_ATTEMPTS times and no more, with no result ever reported');
  const swept = await repo.sweepExhausted(poolA);
  assert.deepEqual(swept.map((r) => r.id), [crashy.id]);
  assert.equal((await seed.get(crashy.id)).status, 'failed');
});

test('J5: audit rows are written on state TRANSITIONS only: one terminal row, never one per attempt', async () => {
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);

  // (a) fails every attempt: three attempts, ONE audit row, at the terminal transition.
  const failing = await seed.job();
  const runnerFail = runnerOn(poolA, async () => { throw new Error('always fails'); });
  for (let i = 0; i < 5; i += 1) await runnerFail.tick();
  const rows = await seed.auditRowsFor(failing.id);
  assert.equal(rows.length, 1, `expected 1 audit row for 3 attempts, got ${rows.length}`);
  assert.equal(rows[0].actor_type, 'system');
  assert.match(rows[0].target, new RegExp(`^${seed.clientId}: job ${failing.id}`));
  assert.match(rows[0].target, /always fails/);

  // (b) fails once then succeeds: a retry is not a transition worth a row.
  const flaky = await seed.job();
  let n = 0;
  const runnerFlaky = runnerOn(poolA, async () => { n += 1; if (n === 1) throw new Error('blip'); });
  await runnerFlaky.tick();
  await runnerFlaky.tick();
  assert.equal((await seed.get(flaky.id)).status, 'done');
  assert.equal((await seed.auditRowsFor(flaky.id)).length, 0);

  // (c) succeeds first time: no row at all.
  const fine = await seed.job();
  await runnerOn(poolA, async () => {}).tick();
  assert.equal((await seed.get(fine.id)).status, 'done');
  assert.equal((await seed.auditRowsFor(fine.id)).length, 0);
});

// =============================================================================
// SUPPORTING TESTS
// =============================================================================

test('a job older than the 24-hour window is failed, not retried, and the handler never runs', async () => {
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
  const stale = await seed.job({ ageHours: 25 });
  let calls = 0;
  await runnerOn(poolA, async () => { calls += 1; }).tick();
  const row = await seed.get(stale.id);
  assert.equal(calls, 0);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error, 'window_expired');
  assert.equal((await seed.auditRowsFor(stale.id)).length, 1);
});

test('purgeFinished removes old finished rows and nothing else', async () => {
  const oldDone = await seed.job({ status: 'done' });
  const oldFailed = await seed.job({ status: 'failed' });
  const recentDone = await seed.job({ status: 'done' });
  const pending = await seed.job({ status: 'pending' });
  await admin.query(`update ai_jobs set finished_at = now() - interval '9 days' where id = any($1)`, [[oldDone.id, oldFailed.id]]);
  await admin.query(`update ai_jobs set finished_at = now() where id = $1`, [recentDone.id]);

  const removed = await repo.purgeFinished(poolA, { olderThanDays: 7 });
  assert.equal(removed, 2);
  assert.equal(await seed.get(oldDone.id), undefined);
  assert.equal(await seed.get(oldFailed.id), undefined);
  assert.ok(await seed.get(recentDone.id));
  assert.ok(await seed.get(pending.id));
});

test('ai_jobs is platform-internal: wasi_app (the tenant role) has no privilege on it', async () => {
  const { rows } = await admin.query(
    `select has_table_privilege('wasi_app', 'ai_jobs', 'select') as sel,
            has_table_privilege('wasi_app', 'ai_jobs', 'insert') as ins,
            has_table_privilege('wasi_app', 'ai_jobs', 'update') as upd,
            has_table_privilege('wasi_app', 'ai_jobs', 'delete') as del`
  );
  assert.deepEqual(rows[0], { sel: false, ins: false, upd: false, del: false });
});

test('migration 088 down is refused while jobs are pending or processing, and allowed once drained', async () => {
  const migration = require('../src/db/migrations/088_ai_jobs');
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
  await seed.job({ status: 'pending' });
  const pgm = (dropped) => ({
    db: { select: async (sql) => (await admin.query(sql)).rows },
    dropTable: (name) => dropped.push(name),
  });

  await assert.rejects(() => migration.down(pgm([])), /Cannot roll back 088_ai_jobs: 1 job\(s\)/);
  await admin.query(`update ai_jobs set status = 'done' where status in ('pending', 'processing')`);
  const dropped = [];
  await migration.down(pgm(dropped));
  assert.deepEqual(dropped, ['ai_jobs']);
});
