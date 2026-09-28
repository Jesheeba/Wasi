// Pure unit coverage for sendabilityMessages.js — no DB, no Meta calls, no
// pool import at all (this module has none), matching
// sendabilityMonitorRunnerUnit.test.js's own "lazy require, pure function"
// discipline. Covers the "why can't my client send" banner's decision logic:
// which of blocked/limited/capped/nothing a given wabas row should produce,
// and that a known Meta error code gets its own real wording while an
// unknown one still gets something usable, never a blank.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeErrorCode, describeSendability, findWorstHealthEntity } = require('../src/utils/sendabilityMessages');

test('describeErrorCode: known codes get their own specific wording', () => {
  const paymentInfo = describeErrorCode(141006);
  assert.match(paymentInfo.headline, /payment method/i);
  assert.equal(paymentInfo.code, 141006);

  const verificationInfo = describeErrorCode(141010);
  assert.match(verificationInfo.headline, /verified/i);

  const permissionInfo = describeErrorCode(200);
  assert.match(permissionInfo.headline, /permission/i);
  assert.match(permissionInfo.action, /contact/i);
});

test('describeErrorCode: an unknown code gets a generic message, the raw code, and a support prompt — never blank', () => {
  const info = describeErrorCode(999999);
  assert.ok(info.headline.length > 0);
  assert.match(info.action, /contact/i);
  assert.equal(info.code, 999999);
});

test('describeErrorCode: a string code coerces to numeric for the lookup', () => {
  const info = describeErrorCode('141006');
  assert.match(info.headline, /payment method/i);
  assert.equal(info.code, 141006);
});

test('describeErrorCode: a null/undefined code still returns something usable', () => {
  const info = describeErrorCode(null);
  assert.ok(info.headline.length > 0);
  assert.equal(info.code, null);
});

test('findWorstHealthEntity: BLOCKED outranks LIMITED, AVAILABLE-only returns null', () => {
  assert.equal(findWorstHealthEntity(null), null);
  assert.equal(findWorstHealthEntity({ entities: [{ can_send_message: 'AVAILABLE' }] }), null);

  const limitedOnly = findWorstHealthEntity({ entities: [{ can_send_message: 'LIMITED', entity_type: 'PHONE_NUMBER' }] });
  assert.equal(limitedOnly.severity, 'limited');

  const mixed = findWorstHealthEntity({
    entities: [
      { can_send_message: 'LIMITED', entity_type: 'PHONE_NUMBER' },
      { can_send_message: 'BLOCKED', entity_type: 'BUSINESS', errors: [{ error_code: 141006 }] },
    ],
  });
  assert.equal(mixed.severity, 'blocked');
  assert.equal(mixed.entity.entity_type, 'BUSINESS');
});

test('describeSendability: sendable === false is always "blocked", using probe_error_code when health_status has nothing', () => {
  const info = describeSendability({ sendable: false, sendable_reason: 'Probe: OAuthException', probe_error_code: 200, health_status: null });
  assert.equal(info.severity, 'blocked');
  assert.equal(info.code, 200);
  assert.match(info.headline, /permission/i);
});

test('describeSendability: a BLOCKED health_status entity wins even when sendable/probe both look fine — the real 2026-09-18 payment-block case', () => {
  const waba = {
    sendable: true, // the probe alone said fine (permission-only, see sendabilityMonitorRunner.js)
    probe_error_code: null,
    health_status: {
      entities: [{ entity_type: 'BUSINESS', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'Payment method needed' }] }],
    },
  };
  const info = describeSendability(waba);
  assert.equal(info.severity, 'blocked');
  assert.equal(info.code, 141006);
  assert.match(info.headline, /payment method/i);
  assert.equal(info.rawReason, 'Payment method needed');
});

test('describeSendability: LIMITED (no BLOCKED anywhere) is "limited", distinct wording from "blocked"', () => {
  const waba = {
    sendable: true,
    health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED', errors: [{ error_code: 123 }] }] },
  };
  const info = describeSendability(waba);
  assert.equal(info.severity, 'limited');
  assert.match(info.headline, /limited/i);
  assert.doesNotMatch(info.headline, /payment method/i);
});

test('describeSendability: TIER_250 with no blocked/limited signal is the soft "capped" notice', () => {
  const info = describeSendability({ sendable: true, health_status: null, messaging_tier: 'TIER_250' });
  assert.equal(info.severity, 'capped');
  assert.match(info.headline, /250/);
});

test('describeSendability: a blocked/limited signal takes priority over the softer TIER_250 notice', () => {
  const info = describeSendability({
    sendable: false, sendable_reason: 'Probe: denied', probe_error_code: 200, messaging_tier: 'TIER_250',
  });
  assert.equal(info.severity, 'blocked');
});

test('describeSendability: sendable === null (never checked) is NOT a banner condition — no false alarm on a brand-new account', () => {
  assert.equal(describeSendability({ sendable: null, health_status: null, messaging_tier: null }), null);
});

test('describeSendability: a fully healthy, non-capped waba shows no banner at all', () => {
  assert.equal(describeSendability({
    sendable: true,
    health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] },
    messaging_tier: 'TIER_1K',
  }), null);
});

test('describeSendability: null/missing waba is not a banner condition either', () => {
  assert.equal(describeSendability(null), null);
  assert.equal(describeSendability(undefined), null);
});
