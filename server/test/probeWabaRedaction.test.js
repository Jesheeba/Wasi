// Drives server/scripts/diagnostics/probe_waba.js against a LOCAL fake Graph
// server (PROBE_GRAPH_BASE) and asserts that a synthetic token never appears in
// anything the script prints, on every output path: success bodies, paging
// URLs, Graph error bodies that echo the token and a URL, a non-JSON body, and
// a dropped connection. No database, no Meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Contains | + / = so its raw and URL-encoded forms differ.
const TOKEN = 'EAAtest|abc+def/ghi=XYZ0123456789tokenvalue';
const ENC = encodeURIComponent(TOKEN);
const PHONE_DIGITS = '9876543210';

function startFakeGraph() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const leaky = `https://graph.facebook.com/v21.0/1?access_token=${ENC}&limit=1`;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname.endsWith('/debug_token')) {
      if (req.method === 'POST') return send(400, { error: { code: 100, message: `Unsupported post request for ${TOKEN}` } });
      return send(200, { data: { type: 'SYSTEM_USER', app_id: '1', user_id: '2', is_valid: true, scopes: ['whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['111'] }], access_token: TOKEN } });
    }
    if (url.pathname === '/123') return send(400, { error: { code: 100, error_subcode: 33, message: `Unsupported get request. Object does not exist. ${leaky}` } });
    if (url.pathname === '/123/phone_numbers') return send(200, { data: [{ id: '555', display_phone_number: `+91 ${PHONE_DIGITS.slice(0, 5)} ${PHONE_DIGITS.slice(5)}`, verified_name: 'X', access_token: TOKEN }], paging: { cursors: { after: 'c' }, next: leaky, previous: leaky } });
    if (url.pathname === '/555') {
      if (url.searchParams.get('fields') === 'messaging_limit_tier') return send(200, { id: '555', messaging_limit_tier: 'TIER_250' });
      return send(400, { error: { code: 100, message: `Tried accessing nonexistent field. token=${TOKEN}` } });
    }
    if (url.pathname === '/123/message_templates') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html>oops ${TOKEN} ${ENC}</html>`); }
    if (url.pathname === '/123/subscribed_apps') { req.socket.destroy(); return; }
    return send(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('probe_waba never prints the token or the full phone number, on any output path', async () => {
  const server = await startFakeGraph();
  process.env.PROBE_GRAPH_BASE = `http://127.0.0.1:${server.address().port}`;
  const { probe } = require('../scripts/diagnostics/probe_waba.js');

  const lines = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    await probe(TOKEN, { tokenFrom: '1', target: '123', showPhone: false });
  } finally {
    console.log = origLog; console.error = origErr;
    server.close();
  }
  const out = lines.join('\n');

  assert.ok(out.length > 200, 'the probe produced output');
  assert.ok(!out.includes(TOKEN), 'raw token must not appear');
  assert.ok(!out.includes(ENC), 'URL-encoded token must not appear');
  assert.ok(!/access_token=[^<\s]/.test(out), 'no access_token= value may appear');
  assert.ok(!out.includes(PHONE_DIGITS) && !out.includes('98765 43210'), 'full phone number must not appear');
  assert.match(out, /"paging": \{\s*"redacted": true/, 'paging object is replaced, not printed');
  assert.ok(!out.includes('limit=1&') || !out.includes(ENC), 'paging URLs are not printed with a token');
  // It still reports what it found.
  assert.match(out, /messaging_limit_tier on phone 555/);
  assert.match(out, /TIER_250/);
  assert.match(out, /whatsapp_business_management/);
  assert.match(out, /\*\*\*3210/, 'phone masked to last four');
});
