// PLAN.md item 28 — the broadcast detail view's "export failed recipients"
// button is the first CSV EXPORT anywhere in this codebase (csvContacts.js
// is an importer/parser only — no writer existed before this). RFC 4182-
// style quoting: a field is wrapped in double quotes only when it contains
// a comma, a quote, or a newline, with any embedded quote doubled.
function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// columns: [{ key, header }] — header row uses `header`, each data row
// pulls `row[key]`.
function toCsv(columns, rows) {
  const lines = [columns.map((c) => escapeCsvField(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvField(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}

module.exports = { toCsv, escapeCsvField };
