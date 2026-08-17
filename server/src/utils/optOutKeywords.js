// Inbound opt-out detection (build plan Phase 4). Matches the WHOLE message
// body (after trimming and stripping trailing punctuation), not a substring
// search — "please don't stop the delivery" must not trigger this. This
// mirrors how real-world STOP-keyword compliance actually works (e.g. US
// CTIA guidelines define STOP as a message body that *is* "stop", not one
// that contains it) and keeps false-positive risk low, which matters more
// here than catching every possible phrasing: a false positive silently
// blocks legitimate marketing to someone who never asked to stop, a false
// negative is a compliance gap — both are real costs, so precision is the
// deliberate choice over recall.
//
// The Tamil/Tanglish entries are a best-effort list for Indian SMBs'
// customer base, NOT verified by a native speaker — extend or correct this
// as real inbound messages surface gaps, rather than treating it as
// complete. Tanglish (Tamil words transliterated into Latin script) varies
// by writer, so this covers the most commonly seen spellings, not all of them.
const OPT_OUT_KEYWORDS = [
  // English
  'stop', 'unsubscribe', 'cancel', 'optout', 'opt out', 'stop all', 'remove me', 'quit',
  // Tamil script
  'நிறுத்து', 'நிறுத்துங்கள்', 'வேண்டாம்',
  // Tanglish (best-effort, see comment above)
  'nirthu', 'nirthungal', 'venda', 'vendaam', 'vendam', 'thevaiyillai',
];

function normalize(text) {
  return (text || '').trim().toLowerCase().replace(/[.!?,]+$/, '');
}

function isOptOutMessage(body) {
  const normalized = normalize(body);
  if (!normalized) return false;
  return OPT_OUT_KEYWORDS.includes(normalized);
}

module.exports = { isOptOutMessage, OPT_OUT_KEYWORDS };
