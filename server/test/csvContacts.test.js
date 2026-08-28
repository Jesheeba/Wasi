// Pure-function tests for utils/csvContacts.js — no DB, no server (same
// reasoning as dbSafety.test.js/apiV1ErrorHandler.test.js). This is the
// actual enforcement of "malformed rows are rejected visibly, never
// silently dropped" (wasi-master-plan.md §8.3) — every row asserted
// accounted for in exactly one of validRows/errors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCsvLine, normalizePhone, isValidPhone, parseContactsCsv } = require('../src/utils/csvContacts');

test('parseCsvLine: plain comma-separated fields', () => {
  assert.deepEqual(parseCsvLine('Priya,919876543210'), ['Priya', '919876543210']);
});

test('parseCsvLine: quoted field containing a comma', () => {
  assert.deepEqual(parseCsvLine('"Sharma, Priya",919876543210'), ['Sharma, Priya', '919876543210']);
});

test('parseCsvLine: escaped double-quote inside a quoted field', () => {
  assert.deepEqual(parseCsvLine('"Priya ""The Boss"" Sharma",919876543210'), ['Priya "The Boss" Sharma', '919876543210']);
});

test('normalizePhone: strips spaces, hyphens, parens, and a leading +', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('(919) 876-5432'), '9198765432');
  assert.equal(normalizePhone('919876543210'), '919876543210');
});

test('isValidPhone: accepts 10-15 digits, rejects everything else', () => {
  assert.equal(isValidPhone('919876543210'), true);
  assert.equal(isValidPhone('9198765432'), true); // 10 digits, minimum
  assert.equal(isValidPhone('123456789012345'), true); // 15 digits, maximum
  assert.equal(isValidPhone('12345'), false); // too short
  assert.equal(isValidPhone('1234567890123456'), false); // too long
  assert.equal(isValidPhone('91987654321a'), false); // non-digit
  assert.equal(isValidPhone(''), false);
});

test('parseContactsCsv: happy path, header in either column order', () => {
  const csv = 'name,phone\nPriya,919876543210\nRavi,919812345678';
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(errors.length, 0);
  assert.deepEqual(validRows, [
    { name: 'Priya', phone: '919876543210' },
    { name: 'Ravi', phone: '919812345678' },
  ]);
});

test('parseContactsCsv: phone-first column order also works', () => {
  const csv = 'phone,name\n919876543210,Priya';
  const { validRows } = parseContactsCsv(csv);
  assert.deepEqual(validRows, [{ name: 'Priya', phone: '919876543210' }]);
});

test('parseContactsCsv: missing name column falls back to phone as the display name', () => {
  const csv = 'phone\n919876543210';
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(errors.length, 0);
  assert.deepEqual(validRows, [{ name: '919876543210', phone: '919876543210' }]);
});

test('parseContactsCsv: no "phone" column at all — whole file rejected with one clear error, not silently empty', () => {
  const csv = 'name,email\nPriya,priya@example.com';
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(validRows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /no "phone" column/i);
});

test('parseContactsCsv: every malformed row is reported with its real line number, not silently dropped', () => {
  const csv = [
    'name,phone',
    'Priya,919876543210',        // row 2: valid
    'Bad Phone,12345',            // row 3: too short
    'No Phone,',                  // row 4: missing
    'Letters,91987654321x',       // row 5: non-digit
    'Ravi,919812345678',          // row 6: valid
  ].join('\n');
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(validRows.length, 2);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((e) => e.row), [3, 4, 5]);
  assert.match(errors[0].reason, /not a valid phone number/i);
  assert.match(errors[1].reason, /missing phone/i);
  assert.match(errors[2].reason, /not a valid phone number/i);
});

test('parseContactsCsv: duplicate phone within the same file is rejected on the second occurrence, first one still imports', () => {
  const csv = 'name,phone\nPriya,919876543210\nPriya Again,919876543210';
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(validRows.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 3);
  assert.match(errors[0].reason, /duplicate/i);
});

test('parseContactsCsv: blank lines are skipped without being counted as errors or data loss', () => {
  const csv = 'name,phone\nPriya,919876543210\n\nRavi,919812345678\n';
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(validRows.length, 2);
  assert.equal(errors.length, 0);
});

test('parseContactsCsv: quoted name containing a comma survives correctly through phone validation', () => {
  const csv = 'name,phone\n"Sharma, Priya",919876543210';
  const { validRows } = parseContactsCsv(csv);
  assert.deepEqual(validRows, [{ name: 'Sharma, Priya', phone: '919876543210' }]);
});

test('parseContactsCsv: empty file is rejected with a clear error', () => {
  const { validRows, errors } = parseContactsCsv('');
  assert.equal(validRows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /empty/i);
});

test('parseContactsCsv: every input row is accounted for in exactly one of validRows/errors (no silent loss)', () => {
  const csv = [
    'name,phone',
    'A,919000000001',
    'B,bad',
    'C,919000000003',
    'D,',
    'E,919000000001', // dup of A
  ].join('\n');
  const { validRows, errors } = parseContactsCsv(csv);
  assert.equal(validRows.length + errors.length, 5, 'every one of the 5 data rows must appear exactly once across the two arrays');
});
