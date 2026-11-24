// Custom form builder (build-docs/features/custom-forms.md), server side.
// AC1-AC6. Pure functions, plus the API on a local test DB with Meta faked.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tpl = require('../src/utils/whatsappFlowTemplates');

const ALL_TYPES = [
  { type: 'text', label: 'Name' },
  { type: 'long_text', label: 'Tell us more', required: false },
  { type: 'email', label: 'Email' },
  { type: 'phone', label: 'Phone' },
  { type: 'number', label: 'Age' },
  { type: 'date', label: 'Preferred date' },
  { type: 'choice', label: 'City', options: ['Chennai', 'Madurai'] },
  { type: 'radio', label: 'How did you hear about us?', options: ['Instagram', 'Friend'] },
  { type: 'checkbox', label: 'Interested in', options: ['NEET', 'JEE', 'TNPSC'] },
];

test('AC1 a blank form with every question type builds the right Meta components', () => {
  const { config, errors } = tpl.normalizeConfig('custom', { title: 'Admissions', submitLabel: 'Send', fields: ALL_TYPES });
  assert.deepEqual(errors, []);
  assert.equal(tpl.KINDS.custom.category, 'OTHER');
  const json = tpl.buildFlowJson('custom', config);
  assert.equal(json.screens[0].id, 'FORM');
  const kids = json.screens[0].layout.children;
  assert.deepEqual(kids.map((c) => [c.type, c['input-type'] ?? null]), [
    ['TextInput', 'text'], ['TextArea', null], ['TextInput', 'email'], ['TextInput', 'phone'], ['TextInput', 'number'],
    ['DatePicker', null], ['Dropdown', null], ['RadioButtonsGroup', null], ['CheckboxGroup', null], ['Footer', null],
  ]);
  assert.deepEqual(kids[8]['data-source'], [{ id: 'opt_1', title: 'NEET' }, { id: 'opt_2', title: 'JEE' }, { id: 'opt_3', title: 'TNPSC' }]);
  assert.equal(kids[1].required, false);
  const footer = kids[9];
  assert.deepEqual(Object.keys(footer['on-click-action'].payload), config.fields.map((f) => f.key), 'every answer is submitted');
});

test('AC2 forms saved before the builder (per-key object) still build, read and export the same', () => {
  const legacy = { title: 'Get in touch', submitLabel: 'Submit', fields: { interest: { type: 'choice', label: 'Course', required: true, options: ['NEET', 'JEE'] }, name: { type: 'text', label: 'Full name', required: true }, email: { type: 'email', label: 'Email', required: false }, notes: { type: 'text', label: 'Anything else?', required: false } } };
  const list = tpl.fieldList(legacy, 'lead');
  assert.deepEqual(list.map((f) => f.key), ['name', 'email', 'interest', 'notes'], "template's order, not jsonb's");
  const names = tpl.buildFlowJson('lead', legacy).screens[0].layout.children.map((c) => c.name).filter(Boolean);
  assert.deepEqual(names, ['name', 'email', 'interest', 'notes']);
  const rows = tpl.describeResponse({ kind: 'lead', config: legacy }, { interest: 'opt_2', name: 'Asha', flow_token: 'x' });
  assert.deepEqual(rows, [{ key: 'name', label: 'Full name', value: 'Asha' }, { key: 'interest', label: 'Course', value: 'JEE' }]);
  // Old API callers still send per-key edits.
  const { config, errors } = tpl.normalizeConfig('lead', { fields: { interest: { options: ['NEET', 'JEE'] } } });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.fields.find((f) => f.key === 'interest').options, ['NEET', 'JEE']);
});

test('AC3 invalid questions return every reason', () => {
  const { errors } = tpl.normalizeConfig('custom', { fields: [
    { type: 'nope', label: 'x' },
    { type: 'text', label: '' },
    { type: 'text', label: 'This label is far too long' },
    { type: 'radio', label: 'Pick', options: [] },
    { type: 'checkbox', label: 'Many', options: Array.from({ length: 21 }, (_, i) => `o${i}`) },
    { type: 'choice', label: 'Dup', options: ['A', 'a'] },
  ] });
  assert.deepEqual(errors, [
    'Question 1 has an unknown type.',
    'Question 2 needs some text.',
    '"This label is far too long" is too long: labels can be 20 characters at most.',
    '"Pick" needs at least one option.',
    '"Many" can have 20 options at most.',
    '"Dup" has duplicate options.',
  ]);
  assert.deepEqual(tpl.normalizeConfig('custom', { fields: [] }).errors, ['Add at least one question.']);
  const tooMany = Array.from({ length: 21 }, () => ({ type: 'text', label: 'Q' }));
  assert.ok(tpl.normalizeConfig('custom', { fields: tooMany }).errors.includes('A form can have 20 questions at most.'));
  // Single/multiple choice labels may be 30 characters, Meta's limit for them.
  assert.deepEqual(tpl.normalizeConfig('custom', { fields: [{ type: 'radio', label: 'How did you hear about us?', options: ['A'] }] }).errors, []);
});

test('AC4 keys are kept on edit; missing, invalid and duplicate keys are assigned', () => {
  const { config } = tpl.normalizeConfig('custom', { fields: [
    { key: 'q1', type: 'text', label: 'A' },
    { type: 'text', label: 'B' },
    { key: 'q1', type: 'text', label: 'C' },
    { key: 'Bad Key!', type: 'text', label: 'D' },
    { key: 'course', type: 'text', label: 'E' },
  ] });
  assert.deepEqual(config.fields.map((f) => f.key), ['q1', 'q2', 'q3', 'q4', 'course']);
});

test('AC5 multiple-choice answers (one id or a list of ids) read as the option text', () => {
  const { config } = tpl.normalizeConfig('custom', { fields: ALL_TYPES });
  const flow = { kind: 'custom', config };
  const key = (label) => config.fields.find((f) => f.label === label).key;
  const rows = tpl.describeResponse(flow, { [key('Interested in')]: ['opt_1', 'opt_3'], [key('How did you hear about us?')]: 'opt_2', [key('Age')]: 17 });
  assert.deepEqual(rows.map((r) => r.value), ['17', 'Friend', 'NEET, TNPSC']);
  assert.equal(tpl.describeResponse(flow, { [key('Interested in')]: 'opt_2' })[0].value, 'JEE');
});

// ---------- API (local test DB) ----------
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');
const whatsappFlowsRepo = require('../src/repositories/whatsappFlowsRepo');
const EMAIL = `test-suite-customforms-${Date.now()}@wasi.local`;
let server, base, token, clientId;
const metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push({ url: u, body: opts.body });
    const body = /\/flows$/.test(u) ? { id: `META_${metaCalls.length}` } : { success: true, validation_errors: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  const reg = await realFetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__customforms', email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(
    `insert into wabas (client_id, waba_id, phone_number_id, access_token_encrypted, status) values ($1, $3, $4, $2, 'connected')`,
    [clientId, encrypt('TOKEN'), `__test_suite__cf_waba_${Date.now()}`, '__test_suite__cf_phone']);
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

test('AC1/AC6 API: question types listed; a custom form is created with its own questions; CSV and contact fields use them', async () => {
  const qt = await api('/api/whatsapp-flows/question-types').then((r) => r.json());
  assert.equal(qt.maxFields, 20);
  assert.equal(qt.types.radio.maxLabel, 30);
  assert.equal(qt.types.radio.maxOptions, 20);

  const before = metaCalls.length;
  const bad = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Bad', kind: 'custom', config: { fields: [] } }) });
  assert.equal(bad.status, 400);
  assert.equal(metaCalls.length, before, 'nothing sent to Meta');

  const res = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Admissions', kind: 'custom', config: { title: 'Admissions', fields: [{ type: 'text', label: 'Student name' }, { type: 'checkbox', label: 'Courses', options: ['NEET', 'JEE'] }] } }) });
  assert.equal(res.status, 201);
  const form = await res.json();
  assert.deepEqual(form.config.fields.map((f) => [f.key, f.type]), [['q1', 'text'], ['q2', 'checkbox']]);
  const created = JSON.parse(metaCalls.filter((c) => /\/flows$/.test(c.url)).pop().body);
  assert.deepEqual(created.categories, ['OTHER']);
  assert.deepEqual(JSON.parse(created.flow_json).screens[0].layout.children.map((c) => c.type), ['TextInput', 'CheckboxGroup', 'Footer']);

  const map = await api(`/api/whatsapp-flows/${form.id}/attribute-map`, { method: 'PUT', body: JSON.stringify({ map: { q1: null, q2: null } }) });
  assert.equal(map.status, 200);
  const unknown = await api(`/api/whatsapp-flows/${form.id}/attribute-map`, { method: 'PUT', body: JSON.stringify({ map: { name: null } }) });
  assert.equal(unknown.status, 400, 'only this form\'s own questions');

  await whatsappFlowsRepo.recordResponse(pool, { clientId, flowId: form.id, flowToken: `wasi_flow:${form.id}`, response: { q1: 'Asha', q2: ['opt_1', 'opt_2'] } });
  const csv = await api(`/api/whatsapp-flows/${form.id}/responses.csv`).then((r) => r.text());
  const [header, row] = csv.split(/\r?\n/);
  assert.match(header, /Student name,Courses/);
  assert.match(row, /Asha,"?NEET, JEE"?/);
});
