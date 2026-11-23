// WhatsApp Flows data endpoint for live forms (booking_live)
// (build-docs/features/whatsapp-flows.md, "Phase 2: live booking").
// WhatsApp calls POST /webhooks/flows/:flowId while a customer fills in a
// live form. Every call must carry Meta's X-Hub-Signature-256 (HMAC-SHA256 of
// the raw body with the app secret), and its body is encrypted with this
// number's key (utils/flowLiveBooking.js). Status codes follow Meta's guide:
// 432 bad signature, 421 can't decrypt (WhatsApp re-fetches the key and
// retries), 427 the flow token doesn't belong to this form.
// Privileged pool throughout; every query is scoped by the form's client_id.
const crypto = require('crypto');
const { Router } = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const wabasRepo = require('../repositories/wabasRepo');
const { decrypt } = require('../utils/encryption');
const live = require('../utils/flowLiveBooking');
const tpl = require('../utils/whatsappFlowTemplates');

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validSignature(req) {
  const header = String(req.get('x-hub-signature-256') || '');
  if (!header.startsWith('sha256=') || !req.rawBody || !process.env.META_APP_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// DatePicker answers are "YYYY-MM-DD" from Flow JSON 5.0; older clients may
// send a timestamp in milliseconds.
function toYmd(value, config) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? live.localDate(config, new Date(n)) : null;
}

async function bookedCounts(flow, ymd) {
  const { rows } = await pool.query(
    `select slot_time, count(*)::int as n from whatsapp_flow_bookings
     where client_id = $1 and flow_id = $2 and slot_date = $3 and status = 'booked' group by slot_time`,
    [flow.client_id, flow.id, ymd]
  );
  return Object.fromEntries(rows.map((r) => [r.slot_time, r.n]));
}

function dateScreen(config, errorMessage) {
  const { min, max } = live.dateRange(config);
  return { screen: 'DATE', data: { min_date: min, max_date: max, ...(errorMessage ? { error_message: errorMessage } : {}) } };
}

async function slotsScreen(flow, ymd, errorMessage) {
  const slots = live.freeSlots(flow.config, ymd, await bookedCounts(flow, ymd));
  if (!slots.length) return dateScreen(flow.config, 'No free times on that day. Please pick another date.');
  return { screen: 'SLOTS', data: { date: ymd, date_label: live.dateLabel(ymd), slots, ...(errorMessage ? { error_message: errorMessage } : {}) } };
}

// Books one slot if it's still free, under a per-slot lock so two people
// can't both take the last place. Returns the booking id or null.
async function book(flow, { ymd, slot, name, chatId }) {
  if (!live.slotsForDate(flow.config, ymd).includes(slot)) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${flow.id}|${ymd}|${slot}`]);
    const { rows } = await client.query(
      `select count(*)::int as n from whatsapp_flow_bookings where flow_id = $1 and slot_date = $2 and slot_time = $3 and status = 'booked'`,
      [flow.id, ymd, slot]
    );
    if (rows[0].n >= flow.config.capacity) { await client.query('rollback'); return null; }
    const ins = await client.query(
      `insert into whatsapp_flow_bookings (client_id, flow_id, chat_id, slot_date, slot_time, name)
       values ($1, $2, (select id from chats where id = $3 and client_id = $1), $4, $5, $6) returning id`,
      [flow.client_id, flow.id, chatId, ymd, slot, String(name || '').slice(0, 100) || null]
    );
    await client.query('commit');
    return ins.rows[0].id;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function respond(flow, request) {
  if (request.action === 'ping') return { data: { status: 'active' } };
  if (request.data?.error) return { data: { acknowledged: true } };
  if (request.action === 'INIT' || request.action === 'BACK') return dateScreen(flow.config);
  if (request.action !== 'data_exchange') return dateScreen(flow.config);

  if (request.screen === 'DATE') {
    const ymd = toYmd(request.data?.date, flow.config);
    if (!ymd) return dateScreen(flow.config, 'Please pick a date.');
    return slotsScreen(flow, ymd);
  }
  if (request.screen === 'SLOTS') {
    const ymd = toYmd(request.data?.date, flow.config);
    const slot = String(request.data?.slot || '');
    if (!ymd || !slot) return dateScreen(flow.config, 'Please pick a date and a time.');
    const bookingId = await book(flow, { ymd, slot, name: request.data?.name, chatId: tpl.chatIdFromToken(request.flow_token) });
    if (!bookingId) return slotsScreen(flow, ymd, 'Sorry, that time was just taken. Please pick another.');
    return {
      screen: 'SUCCESS',
      data: { extension_message_response: { params: { flow_token: request.flow_token, name: String(request.data?.name || ''), date: ymd, slot } } },
    };
  }
  return dateScreen(flow.config);
}

router.post('/:flowId', asyncHandler(async (req, res) => {
  if (!validSignature(req)) return res.status(432).end();
  if (!UUID_RE.test(req.params.flowId)) return res.status(404).end();
  const { rows } = await pool.query(`select id, client_id, kind, config from whatsapp_flows where id = $1 and kind = 'booking_live'`, [req.params.flowId]);
  const flow = rows[0];
  if (!flow) return res.status(404).end();
  flow.config = live.normalizeConfig(flow.config).config;

  const waba = await wabasRepo.findByClientId(flow.client_id);
  let decrypted;
  try {
    decrypted = live.decryptRequest(req.body || {}, decrypt(waba.flows_private_key_encrypted));
  } catch {
    return res.status(421).end();
  }
  const { request, aesKey, iv } = decrypted;
  if (request.action !== 'ping' && tpl.flowIdFromToken(request.flow_token) !== flow.id) return res.status(427).end();

  const reply = await respond(flow, request);
  res.status(200).type('text/plain').send(live.encryptResponse(reply, aesKey, iv));
}));

module.exports = router;
