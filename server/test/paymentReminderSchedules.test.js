// Admin monthly schedule: due-date logic and the run path. Stubs only (the
// repo's DB guard refuses tests that reach the shared database). Nothing is
// sent to Meta.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/services/paymentReminderRunner');
const schedulesRepo = require('../src/repositories/paymentReminderSchedulesRepo');
const clientsRepo = require('../src/repositories/clientsRepo');
const auditLogRepo = require('../src/repositories/auditLogRepo');
const paymentNotificationService = require('../src/services/paymentNotificationService');

const real = {
  claim: schedulesRepo.claimForDate, summary: schedulesRepo.recordSummary,
  listActive: clientsRepo.listActive, update: clientsRepo.update,
  audit: auditLogRepo.record, send: paymentNotificationService.sendAndLog,
};
afterEach(() => {
  schedulesRepo.claimForDate = real.claim; schedulesRepo.recordSummary = real.summary;
  clientsRepo.listActive = real.listActive; clientsRepo.update = real.update;
  auditLogRepo.record = real.audit; paymentNotificationService.sendAndLog = real.send;
});

// 10:30 India time on 15 Oct 2026 == 05:00 UTC.
const IST_15_OCT_1030 = new Date('2026-10-15T05:00:00Z');
const sched = (o = {}) => ({ id: 's1', enabled: true, day_of_month: 15, send_hour: 10, last_run_on: null, ...o });

test('isScheduleDue: right day and hour reached, not yet run today', () => {
  assert.equal(runner.isScheduleDue(sched(), IST_15_OCT_1030), true);
});

test('isScheduleDue: wrong day, hour not reached, disabled, or already run today are all not due', () => {
  assert.equal(runner.isScheduleDue(sched({ day_of_month: 16 }), IST_15_OCT_1030), false);
  assert.equal(runner.isScheduleDue(sched({ send_hour: 11 }), IST_15_OCT_1030), false);
  assert.equal(runner.isScheduleDue(sched({ enabled: false }), IST_15_OCT_1030), false);
  assert.equal(runner.isScheduleDue(sched({ last_run_on: '2026-10-15' }), IST_15_OCT_1030), false);
  // a run from last month doesn't block this month
  assert.equal(runner.isScheduleDue(sched({ last_run_on: '2026-09-15' }), IST_15_OCT_1030), true);
});

test('isScheduleDue: catches up later the same day if the exact hour was missed', () => {
  const lateEvening = new Date('2026-10-15T15:00:00Z'); // 20:30 IST
  assert.equal(runner.isScheduleDue(sched(), lateEvening), true);
});

test('isScheduleDue: day 31 falls back to the last day of a shorter month', () => {
  const nov30 = new Date('2026-11-30T06:00:00Z'); // 11:30 IST, November has 30 days
  assert.equal(runner.isScheduleDue(sched({ day_of_month: 31 }), nov30), true);
  assert.equal(runner.isScheduleDue(sched({ day_of_month: 31 }), new Date('2026-11-29T06:00:00Z')), false);
});

test('uses India time, not UTC, for the date: 23:00 UTC on the 14th is already the 15th in IST', () => {
  const lateUtc = new Date('2026-10-14T23:00:00Z'); // 04:30 IST on the 15th
  assert.equal(runner.isScheduleDue(sched({ send_hour: 4 }), lateUtc), true);
});

test('runScheduleIfDue: sends to each active client, skips one already reminded today, records the summary', async () => {
  const sent = []; let summary; const stamped = [];
  schedulesRepo.claimForDate = async () => ({ id: 's1' });
  schedulesRepo.recordSummary = async (id, s) => { summary = s; };
  clientsRepo.listActive = async () => [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', last_reminder_sent_on: '2026-10-15' },
    { id: 'c', name: 'C' },
  ];
  clientsRepo.update = async (db, id, f) => { stamped.push(id); };
  auditLogRepo.record = async () => {};
  paymentNotificationService.sendAndLog = async (client, opts) => {
    sent.push([client.id, opts.trigger]);
    return client.id === 'c' ? { ok: false, error: 'x' } : { ok: true };
  };
  const result = await runner.runScheduleIfDue(sched(), IST_15_OCT_1030, {});
  assert.deepEqual(result, { total: 3, sent: 1, failed: 1, skipped: 1 });
  assert.deepEqual(sent, [['a', 'admin_schedule'], ['c', 'admin_schedule']]);
  assert.match(summary, /1 sent, 1 failed, 1 already reminded/);
  assert.deepEqual(stamped, ['a', 'c']);
});

test('runScheduleIfDue: losing the once-per-day claim sends nothing', async () => {
  let called = false;
  schedulesRepo.claimForDate = async () => null;
  clientsRepo.listActive = async () => { called = true; return []; };
  assert.equal(await runner.runScheduleIfDue(sched(), IST_15_OCT_1030, {}), null);
  assert.equal(called, false);
});
