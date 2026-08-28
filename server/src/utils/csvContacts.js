// Minimal RFC4180-ish CSV parsing for contact-list import
// (routes/contactLists.js). No CSV library exists anywhere in this
// codebase (confirmed via grep during Phase 3 planning) — this is a small,
// bounded parser for exactly the 2-column shape a contact export needs
// (name, phone), not a general-purpose CSV engine, so hand-rolling it with
// real test coverage is more controllable than adding a new dependency for
// one narrow use case.
//
// Supports: comma-delimited, an optional header row (name/phone in either
// order, case-insensitive), double-quoted fields containing commas, and
// "" as an escaped quote inside a quoted field (the one RFC4180 escaping
// rule contact exports actually use in practice). Does NOT support custom
// delimiters or multi-line quoted fields — out of scope for this use case.

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

// Digits-only, matching how phone numbers are actually stored throughout
// this codebase (e.g. "919876543210", never "+91 98765 43210" — that
// formatting only ever appears in display-only seed/mock data). Accepts an
// optional leading '+' and strips spaces/hyphens/parens before validating,
// so a human-formatted export ("+91 98765-43210") still normalizes cleanly.
// 10-15 digits covers real-world national numbers through E.164's max
// length without hand-coding country-specific rules this app has no other
// precedent for anywhere else in its validation.
function normalizePhone(raw) {
  const stripped = (raw || '').replace(/[\s\-().]/g, '').replace(/^\+/, '');
  return stripped;
}

function isValidPhone(normalized) {
  return /^[0-9]{10,15}$/.test(normalized);
}

// Returns { validRows: [{name, phone}], errors: [{row, reason}] } — every
// row is accounted for in exactly one of the two arrays, never silently
// dropped. `row` in an error is the 1-indexed line number as it appears in
// the uploaded file (including the header line, matching what a person
// looking at the file in a spreadsheet app would call "row N"), so a
// client can find and fix the actual bad line.
function parseContactsCsv(text) {
  const lines = (text || '').split(/\r\n|\r|\n/).filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
  if (lines.length === 0) {
    return { validRows: [], errors: [{ row: 1, reason: 'File is empty.' }] };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const nameIdx = header.indexOf('name');
  const phoneIdx = header.indexOf('phone');
  if (phoneIdx === -1) {
    return {
      validRows: [],
      errors: [{ row: 1, reason: 'No "phone" column found in the header row. Expected columns: name, phone (in either order).' }],
    };
  }

  const validRows = [];
  const errors = [];
  const seenInFile = new Set();

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // 1-indexed, header is row 1
    const raw = lines[i];
    if (raw.trim() === '') continue; // a genuinely blank line is not a data-loss risk, silently skipping it isn't "dropping a bad row"

    const fields = parseCsvLine(raw);
    const phoneRaw = fields[phoneIdx];
    const name = nameIdx !== -1 ? (fields[nameIdx] || '') : '';
    const phone = normalizePhone(phoneRaw);

    if (!phoneRaw) {
      errors.push({ row: rowNum, reason: 'Missing phone number.' });
      continue;
    }
    if (!isValidPhone(phone)) {
      errors.push({ row: rowNum, reason: `"${phoneRaw}" is not a valid phone number (expected 10-15 digits, optionally with +/spaces/hyphens).` });
      continue;
    }
    if (seenInFile.has(phone)) {
      errors.push({ row: rowNum, reason: `Duplicate phone number "${phoneRaw}" — already seen earlier in this file.` });
      continue;
    }
    seenInFile.add(phone);
    validRows.push({ name: name || phone, phone });
  }

  return { validRows, errors };
}

module.exports = { parseCsvLine, normalizePhone, isValidPhone, parseContactsCsv };
