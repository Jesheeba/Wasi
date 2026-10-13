// AI agent unit 0.4 (docs/ai-agent/SPEC.md section 6, IMPLEMENTATION.md):
// the durable queue of agent turns. One row per inbound message the agent
// should consider; processed by services/aiAgentRunner.js.
//
// DDL is SPEC section 6's, unchanged. The queue follows the
// webhook_deliveries / forwardRunner pattern on purpose (lease-at-insert,
// claim by pushing next_attempt_at forward, backoff, terminal state), NOT the
// three runners whose failure path never advances their "checked at" column
// (BUILD_PLAN 3.14). Two deliberate differences from forwardRunner, both
// about being bounded under failure:
//   - attempt_count is incremented when a job is CLAIMED, not only when its
//     handler reports failure, so a job whose worker keeps dying mid-flight
//     (crash, deploy, OOM) still runs out of attempts instead of being
//     re-claimed forever with a counter that never moves.
//   - terminal completion is guarded by the attempt number it was claimed
//     under, so a slow worker whose lease expired cannot overwrite the
//     result of the attempt that replaced it.
//
// Platform-internal, like alert_events / failed_consent_writes: only the
// privileged pool (the runner) touches it, never a tenant-scoped route, so it
// gets NO grant to wasi_app and needs no RLS policy. Every query against it
// must scope by client_id explicitly. test/aiJobs.test.js asserts the absence
// of the grant, so adding one later is a deliberate act.
//
// Retention: finished rows are purged by the runner after a few days (see
// aiJobsRepo.purgeFinished); nothing needs a finished job after that.
//
// ai_gate_log and the other AI tables are separate, later units.
exports.up = (pgm) => {
  pgm.createTable('ai_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    conversation_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    inbound_message_id: { type: 'uuid', notNull: true, references: 'messages', onDelete: 'CASCADE' },
    status: {
      type: 'text', notNull: true, default: 'pending',
      check: "status in ('pending', 'processing', 'done', 'failed')",
    },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
  });

  // One job per inbound message: a redelivered webhook cannot enqueue it twice.
  pgm.createIndex('ai_jobs', 'inbound_message_id', { unique: true, name: 'ai_jobs_inbound_message_idx' });
  pgm.createIndex('ai_jobs', ['status', 'next_attempt_at'], { name: 'ai_jobs_due_idx' });
};

// In-flight work is real customer messages awaiting an answer: refuse to drop
// the table while any exist (same live-row guard discipline as 032/036/080/087).
exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    "select count(*)::int as count from ai_jobs where status in ('pending', 'processing')"
  );
  if (count > 0) {
    throw new Error(
      `Cannot roll back 088_ai_jobs: ${count} job(s) are still pending or processing. ` +
      `Drain or fail them first; dropping the table would silently discard customer messages awaiting an answer.`
    );
  }
  pgm.dropTable('ai_jobs');
};
