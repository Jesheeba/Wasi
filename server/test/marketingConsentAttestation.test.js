// Account marketing consent attestation + Hub API opt-in
// (build-docs/features/marketing-consent-attestation.md). Test names map to
// that doc's acceptance criteria (AC1-AC8). Disposable client with no WABA,
// so nothing here can reach a real phone: a send that gets past the consent
// gate stops at waba_not_connected, which is how "allowed" is asserted.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const authTokensRepo = require('../src/repositories/authTokensRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const { ACCOUNT_CONSENT_STATEMENT, ACCOUNT_CONSENT_VERSION } = require('../src/utils/consentStatement');

const SUITE_PREFIX = '__test_suite__mktconsent_';
const PASSWORD = 'test-suite-password-12345';
let server;
let baseUrl;
let clientToken;
let testClientId;
let apiKey;
let apiKeyId;
let phoneSeq = 0;
const createdTeamMemberIds = [];

const authed = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const nextPhone = () => `9177${Date.now()}${phoneSeq++}`;

async function json(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: authed(token), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function createContact(phone) {
  return (await json('POST', '/api/contacts', clientToken, { name: 'Consent Contact', phone })).data;
}

async function createChat(contact) {
  return (await json('POST', '/api/chats', clientToken, { name: contact.name, phone: contact.phone, contact_id: contact.id })).data;
}

async function createTemplate(category) {
  const name = `${SUITE_PREFIX}t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const { data } = await json('POST', '/api/templates', clientToken, {
    name, category,
    body: 'Hello {{customer_name}}, thank you so much for reaching out to us today - we truly appreciate it!',
    bodyParamExamples: { customer_name: 'Riyaz' },
  });
  // No WABA here, so it stays a local draft; approve it so only consent is under test.
  await pool.query("update message_templates set status = 'approved' where id = $1", [data.id]);
  return data;
}

const sendTemplate = (chatId, templateName) =>
  json('POST', `/api/chats/${chatId}/messages`, clientToken, { type: 'template', templateName, templateLanguage: 'en_US' });

const setConsent = (contactId, event) =>
  json('POST', `/api/contacts/${contactId}/consent`, clientToken, { event, source: 'test_suite' });

const attest = (token, attested) => json('POST', '/api/marketing-consent', token, { attested });

async function teamMemberToken(role) {
  const { data: created } = await json('POST', '/api/team-members', clientToken, {
    name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role,
  });
  createdTeamMemberIds.push(created.id);
  const inviteToken = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);
  const res = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: `test-suite-mktconsent-${Date.now()}@wasi.local`, password: PASSWORD }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
  const key = await apiKeysRepo.create(pool, testClientId, `${SUITE_PREFIX}n8n`);
  apiKey = key.rawKey;
  apiKeyId = key.record.id;
});

after(async () => {
  if (createdTeamMemberIds.length) {
    await pool.query('delete from auth_tokens where subject_id = any($1::uuid[])', [createdTeamMemberIds]);
  }
  if (testClientId) {
    await pool.query("delete from audit_log where actor_type = 'client' and actor_id = $1", [testClientId]);
    await pool.query('delete from clients where id = $1', [testClientId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('AC1 + AC2 + AC4: unknown contact is blocked from Marketing until attested, then allowed; Utility unaffected throughout', async () => {
  const chat = await createChat(await createContact(nextPhone()));
  const marketing = await createTemplate('Marketing');
  const utility = await createTemplate('Utility');

  let res = await sendTemplate(chat.id, marketing.name);
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'consent_required');
  assert.match(res.data.error || res.data.message || JSON.stringify(res.data), /Marketing consent/);
  assert.equal((await sendTemplate(chat.id, utility.name)).data.code, 'waba_not_connected');

  assert.equal((await attest(clientToken, true)).status, 200);
  res = await sendTemplate(chat.id, marketing.name);
  assert.equal(res.data.code, 'waba_not_connected', 'past the consent gate once attested');
  assert.equal((await sendTemplate(chat.id, utility.name)).data.code, 'waba_not_connected');

  // Withdrawing blocks unknown contacts again on the next send.
  await attest(clientToken, false);
  assert.equal((await sendTemplate(chat.id, marketing.name)).data.code, 'consent_required');
});

test('AC3: an opted-out contact is refused Marketing with contact_opted_out, attested or not', async () => {
  const contact = await createContact(nextPhone());
  const chat = await createChat(contact);
  const marketing = await createTemplate('Marketing');
  await setConsent(contact.id, 'opted_out');

  assert.equal((await sendTemplate(chat.id, marketing.name)).data.code, 'contact_opted_out');
  await attest(clientToken, true);
  assert.equal((await sendTemplate(chat.id, marketing.name)).data.code, 'contact_opted_out');
  // Utility still goes to an opted-out contact (unchanged behaviour).
  assert.equal((await sendTemplate(chat.id, (await createTemplate('Utility')).name)).data.code, 'waba_not_connected');
  await attest(clientToken, false);
});

test('AC5: only Owner/Admin can attest; each change records the verbatim statement and an audit row', async () => {
  const agentToken = await teamMemberToken('Agent');
  const managerToken = await teamMemberToken('Manager');
  const adminToken = await teamMemberToken('Admin');

  assert.equal((await attest(agentToken, true)).status, 403);
  assert.equal((await attest(managerToken, true)).status, 403);
  assert.equal((await json('POST', '/api/marketing-consent', clientToken, { attested: 'yes' })).status, 400);

  const viewAsAgent = await json('GET', '/api/marketing-consent', agentToken);
  assert.equal(viewAsAgent.status, 200, 'any role can read the state');
  assert.equal(viewAsAgent.data.statement.text, ACCOUNT_CONSENT_STATEMENT);

  const byAdmin = await attest(adminToken, true);
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.data.attested, true);
  assert.equal(byAdmin.data.current.actor_type, 'team_member');
  assert.ok(byAdmin.data.contacts && typeof byAdmin.data.contacts.unknown === 'number');

  const byOwner = await attest(clientToken, false);
  assert.equal(byOwner.data.attested, false);
  assert.equal(byOwner.data.current.actor_type, 'owner');

  const { rows } = await pool.query(
    'select event, statement_text, statement_version, actor_type, actor_id from marketing_consent_attestations where client_id = $1 order by created_at desc limit 2',
    [testClientId]
  );
  assert.deepEqual(rows.map((r) => r.event), ['withdrawn', 'attested']);
  assert.ok(rows.every((r) => r.statement_text === ACCOUNT_CONSENT_STATEMENT && r.statement_version === ACCOUNT_CONSENT_VERSION));
  assert.equal(rows[0].actor_id, null, 'owner has no team_members id');
  assert.ok(rows[1].actor_id, 'team member id recorded');

  const audit = await pool.query(
    "select action from audit_log where actor_type = 'client' and actor_id = $1 and action like 'marketing_consent_%'",
    [testClientId]
  );
  assert.ok(audit.rows.some((r) => r.action === 'marketing_consent_attested'));
  assert.ok(audit.rows.some((r) => r.action === 'marketing_consent_withdrawn'));
});

test('AC6: POST /api/v1/contacts/consent records opt-in/out via the Hub API; opt-out stays sticky', async () => {
  const phone = nextPhone();
  let res = await json('POST', '/api/v1/contacts/consent', apiKey, { phone, status: 'opted_in' });
  assert.equal(res.status, 400, 'method is required for opted_in');

  res = await json('POST', '/api/v1/contacts/consent', apiKey, { phone, status: 'opted_in', method: 'website_form', note: 'signup form' });
  assert.equal(res.status, 200);
  assert.equal(res.data.opt_in_status, 'opted_in');

  const { rows: events } = await pool.query(
    'select event, source, actor_type, actor_id, evidence from consent_events where client_id = $1 and contact_id = $2',
    [testClientId, res.data.id]
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'hub_api');
  assert.equal(events[0].actor_type, 'api_key');
  assert.equal(events[0].actor_id, apiKeyId);
  assert.equal(events[0].evidence.method, 'website_form');
  assert.ok(events[0].evidence.statement);

  res = await json('POST', '/api/v1/contacts/consent', apiKey, { phone, status: 'opted_out' });
  assert.equal(res.data.opt_in_status, 'opted_out');
  res = await json('POST', '/api/v1/contacts/consent', apiKey, { phone, status: 'opted_in', method: 'website_form' });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'contact_opted_out');
});

test('AC7: POST /api/v1/messages with optIn records the opt-in then sends; for an opted-out contact nothing is sent', async () => {
  const marketing = await createTemplate('Marketing');
  const base = { client_id: testClientId, type: 'template', template: marketing.name, params: { customer_name: 'Riyaz' } };

  // Without optIn and without attestation, the unknown contact is refused.
  const phone = nextPhone();
  let res = await json('POST', '/api/v1/messages', apiKey, { ...base, to: phone });
  assert.equal(res.data.error.code, 'consent_required');

  res = await json('POST', '/api/v1/messages', apiKey, { ...base, to: phone, optIn: { method: 'bogus' } });
  assert.equal(res.status, 400);

  res = await json('POST', '/api/v1/messages', apiKey, { ...base, to: phone, optIn: { method: 'existing_customer_agreement' } });
  assert.equal(res.data.error.code, 'waba_not_connected', 'consent recorded, so the send passed the consent gate');
  const { rows: [contact] } = await pool.query('select id, opt_in_status from contacts where client_id = $1 and phone = $2', [testClientId, phone]);
  assert.equal(contact.opt_in_status, 'opted_in');

  // Opted-out contact + optIn: refused, and no message row is written.
  const outPhone = nextPhone();
  await json('POST', '/api/v1/contacts/consent', apiKey, { phone: outPhone, status: 'opted_out' });
  res = await json('POST', '/api/v1/messages', apiKey, { ...base, to: outPhone, optIn: { method: 'website_form' } });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'contact_opted_out');
  const { rows: [{ n }] } = await pool.query(
    `select count(*)::int n from messages m join chats c on c.id = m.chat_id
       join contacts ct on ct.id = c.contact_id where ct.client_id = $1 and ct.phone = $2`,
    [testClientId, outPhone]
  );
  assert.equal(n, 0);
});

test('AC8: broadcast skips (not fails) an opted-out recipient; with attestation unknown recipients are sent to', async () => {
  const { data: tag } = await json('POST', '/api/tags', clientToken, { name: `${SUITE_PREFIX}tag_${Date.now()}`, bg: '#EEEEEE', color: '#111111' });
  const unknown = (await json('POST', '/api/contacts', clientToken, { name: 'U', phone: nextPhone(), tag_id: tag.id })).data;
  const optedOut = (await json('POST', '/api/contacts', clientToken, { name: 'O', phone: nextPhone(), tag_id: tag.id })).data;
  await setConsent(optedOut.id, 'opted_out');
  await attest(clientToken, true);

  const marketing = await createTemplate('Marketing');
  const { data: created } = await json('POST', '/api/broadcasts', clientToken, {
    title: `${SUITE_PREFIX}b_${Date.now()}`, templateName: marketing.name, tag_id: tag.id,
    paramMappings: { customer_name: { source: 'contact_field', field: 'name' } },
  });
  assert.equal(created.recipient_count, 2);
  assert.equal(created.consentWarning, null, '1 of 2 skipped is not a majority');

  await broadcastRunner.processBroadcast(created);
  const { rows } = await pool.query(
    'select contact_id, status, error_reason from broadcast_recipients where broadcast_id = $1', [created.id]
  );
  const byContact = Object.fromEntries(rows.map((r) => [r.contact_id, r]));
  assert.equal(byContact[optedOut.id].status, 'skipped');
  assert.match(byContact[optedOut.id].error_reason, /opted out/i);
  // Unknown recipient was attempted (fails only for the missing WABA).
  assert.equal(byContact[unknown.id].status, 'failed');
  await attest(clientToken, false);
});
