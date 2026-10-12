#!/usr/bin/env node
'use strict';
// Read-only Meta Graph probe: "what does THIS token see on THAT id?"
//
// Built for the TNPSC question (docs/ai-agent/BUILD_PLAN.md 2.1): id
// 1649658386105751 has no wabas row of its own, so it cannot be probed through
// the stored-credential scripts. This borrows the token already stored for a
// KNOWN waba and aims it at any target id, so the answer to "is that a WABA, a
// business portfolio, or nothing this token can see?" comes from Meta, not
// from a guess.
//
//   docker exec -w /app/server wasi-crm \
//     node scripts/diagnostics/probe_waba.js --token-from 894384560175844 --target 1649658386105751
//
// or, because the host has no node_modules and this file may not be in the
// image yet, feed it on stdin from the host:
//
//   docker exec -i -w /app/server wasi-crm node - --token-from 894384560175844 --target 1649658386105751 < server/scripts/diagnostics/probe_waba.js
//
// Options:
//   --token-from <waba_id>   REQUIRED. wabas.waba_id whose stored token to use.
//   --target <id>            REQUIRED. The Graph id to probe (WABA, portfolio, ...).
//   --show-phone             Print display_phone_number in full (default: last 4).
//
// Safety properties (this is the point of the file; keep them):
//   * READ-ONLY: GET requests only; the database is touched in a
//     `begin read only` transaction.
//   * The token is sent in an `Authorization: Bearer` header, never in a URL.
//     The one exception is debug_token, which only accepts `input_token` as a
//     query parameter (POST is refused); that URL is never printed.
//   * Nothing is printed raw. Every response and every error goes through
//     redact(): the token value is replaced wherever it appears, `access_token=`
//     query fragments are scrubbed, and `paging.next` / `paging.previous` are
//     dropped, because Meta embeds the token in those URLs.
//   * It prints a token's length and its SCOPES, never its value.
//
// Run it only on the host that holds SERVER_SECRET. Local dev cannot decrypt
// production tokens, by design.

const path = require('path');

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';
// PROBE_GRAPH_BASE exists for server/test/probeWabaRedaction.test.js only (it points the probe at a
// local fake server so every output path can be exercised without Meta). Never set it in production.
const BASE = process.env.PROBE_GRAPH_BASE || `https://graph.facebook.com/${API_VERSION}`;

// ---------------------------------------------------------------- redaction

function redactString(s, token) {
  let out = String(s);
  if (token) {
    // Raw, URL-encoded (what fetch puts on the wire / in a URL), and
    // JSON-escaped forms: a token with | + / = characters is not byte-identical
    // across them.
    const forms = new Set([token, encodeURIComponent(token), encodeURI(token), JSON.stringify(token).slice(1, -1)]);
    for (const f of forms) if (f) out = out.split(f).join('<token>');
  }
  out = out.replace(/access_token=[^&"'\s\\]+/gi, 'access_token=<redacted>');
  out = out.replace(/input_token=[^&"'\s\\]+/gi, 'input_token=<redacted>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._|-]{20,}/g, 'Bearer <redacted>');
  return out;
}

// Walks a parsed response. `paging` is replaced wholesale (its next/previous
// URLs carry the token); anything token-shaped by key name is dropped.
function sanitize(value, token, { showPhone = false } = {}) {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, token, { showPhone }));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'paging') {
        out.paging = { redacted: true, has_next: Boolean(v && v.next), has_previous: Boolean(v && v.previous) };
      } else if (/^(access_token|token|input_token|app_secret|secret)$/i.test(k)) {
        out[k] = '<redacted>';
      } else if (k === 'display_phone_number' && typeof v === 'string' && !showPhone) {
        out[k] = `***${v.replace(/\D/g, '').slice(-4)}`;
      } else {
        out[k] = sanitize(v, token, { showPhone });
      }
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value, token);
  return value;
}

function show(label, status, body, token, opts) {
  const safe = sanitize(body, token, opts);
  // Final belt-and-braces pass on the serialised form.
  const text = redactString(JSON.stringify(safe, null, 2), token);
  console.log(`\n## ${label}  [HTTP ${status}]`);
  console.log(text);
}

// -------------------------------------------------------------------- graph

async function graph(method, urlPath, token, { form } = {}) {
  const url = `${BASE}${urlPath}`;
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    // Never print err.message verbatim: it can carry the request URL.
    return { status: 0, body: { error: { type: 'network', message: redactString(err.code || err.name || 'fetch failed', token) } } };
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function errInfo(r) {
  const e = r.body && r.body.error;
  return e ? `code ${e.code}${e.error_subcode ? ` subcode ${e.error_subcode}` : ''}` : null;
}

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const a = { showPhone: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token-from') a.tokenFrom = argv[++i];
    else if (argv[i] === '--target') a.target = argv[++i];
    else if (argv[i] === '--show-phone') a.showPhone = true;
  }
  return a;
}

async function loadToken(wabaId) {
  const { Client } = require('pg');
  const root = process.env.SERVER_ROOT || process.cwd();
  const { decrypt } = require(path.resolve(root, 'src/utils/encryption'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('begin read only');
    const r = await c.query('select access_token_encrypted from wabas where waba_id = $1', [wabaId]);
    await c.query('rollback');
    if (!r.rows.length || !r.rows[0].access_token_encrypted) throw new Error(`No stored token for waba_id ${wabaId}`);
    return decrypt(r.rows[0].access_token_encrypted);
  } finally {
    await c.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tokenFrom || !args.target) {
    console.error('Usage: probe_waba.js --token-from <waba_id> --target <graph id> [--show-phone]');
    process.exit(2);
  }
  if (!/^\d+$/.test(args.target) || !/^\d+$/.test(args.tokenFrom)) {
    console.error('Both ids must be numeric.');
    process.exit(2);
  }
  const token = await loadToken(args.tokenFrom);
  await probe(token, args);
}

// Everything that talks to Graph and prints. Split from main() so the test can
// drive it with a synthetic token and a fake server.
async function probe(token, args) {
  const opts = { showPhone: args.showPhone };
  console.log(`graph ${API_VERSION}; token from waba ${args.tokenFrom} (length ${token.length}, value never printed); target ${args.target}`);

  // 1. What the token is allowed to do (scopes + granular targets). Meta
  //    refuses POST on debug_token (tested 2026-10-12: HTTP 400, code 100), so
  //    input_token has to be a query parameter. The URL is never printed and
  //    every error path below goes through redact().
  const dbg = await graph('GET', `/debug_token?input_token=${encodeURIComponent(token)}`, token);
  const d = dbg.body && dbg.body.data;
  show('debug_token (scopes only)', dbg.status, d ? {
    type: d.type, app_id: d.app_id, user_id: d.user_id, is_valid: d.is_valid,
    scopes: d.scopes, granular_scopes: d.granular_scopes,
    expires_at: d.expires_at, data_access_expires_at: d.data_access_expires_at,
  } : dbg.body, token, opts);

  // 2. The target node itself.
  const node = await graph('GET', `/${args.target}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status`, token);
  show(`target node /${args.target}`, node.status, node.body, token, opts);
  console.log(`   -> ${node.status === 200 ? 'readable by this token' : `NOT readable (${errInfo(node) || 'no error body'})`}`);

  // 3. If it is a WABA: its numbers. Base fields only; the two tier fields are
  //    requested separately so an unknown field cannot fail the whole call.
  const phones = await graph('GET', `/${args.target}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status,platform_type,is_on_biz_app,code_verification_status,name_status&limit=10`, token);
  show(`phone_numbers of ${args.target}`, phones.status, phones.body, token, opts);

  const ids = (phones.body && phones.body.data || []).map((p) => p.id).slice(0, 5);
  for (const id of ids) {
    for (const field of ['messaging_limit_tier', 'whatsapp_business_manager_messaging_limit']) {
      const t = await graph('GET', `/${id}?fields=${field}`, token);
      show(`${field} on phone ${id}`, t.status, t.body, token, opts);
    }
  }

  // 4. Templates (read) and the app subscription (read).
  const tpl = await graph('GET', `/${args.target}/message_templates?fields=name,status,category,language&limit=5`, token);
  show(`message_templates of ${args.target} (first 5)`, tpl.status, tpl.body, token, opts);
  const subs = await graph('GET', `/${args.target}/subscribed_apps`, token);
  show(`subscribed_apps of ${args.target}`, subs.status, subs.body, token, opts);
}

module.exports = { redactString, sanitize, probe, graph };

if (require.main === module) {
  main().catch((err) => {
    // err.message may come from pg or decrypt, never from a URL, but scrub anyway.
    console.error('probe_waba failed:', redactString(err && err.message || err, null));
    process.exit(1);
  });
}
