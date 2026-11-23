// Forms with live data: booking with real free slots
// (build-docs/features/whatsapp-flows.md, "Phase 2: live booking").
// An endpoint reply may add data.error_message, which WhatsApp shows as a
// pop-up on its own, so no screen declares it.
// Pure helpers: availability config, slot maths, the two-screen Flow JSON,
// and Meta's Flows endpoint encryption (shapes from Meta's "Implementing
// your Flow endpoint" guide, checked 2026-11-23). No I/O.
const crypto = require('crypto');

const FLOW_JSON_VERSION = '7.3';
const DATA_API_VERSION = '3.0';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULTS = {
  title: 'Book a slot',
  submitLabel: 'Book',
  nameLabel: 'Your name',
  dateLabel: 'Pick a date',
  slotLabel: 'Pick a time',
  days: [1, 2, 3, 4, 5, 6], // Mon-Sat
  start: '10:00',
  end: '18:00',
  slotMinutes: 30,
  capacity: 1,
  daysAhead: 14,
  timezone: 'Asia/Kolkata',
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const label12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// Same contract as whatsappFlowTemplates.normalizeConfig: { config, errors }.
function normalizeConfig(input = {}) {
  const errors = [];
  const str = (v, d, max, what) => {
    const s = typeof v === 'string' && v.trim() ? v.trim() : d;
    if (s.length > max) errors.push(`${what} can be ${max} characters at most.`);
    return s;
  };
  const config = {
    title: str(input.title, DEFAULTS.title, 30, 'Form title'),
    submitLabel: str(input.submitLabel, DEFAULTS.submitLabel, 35, 'Button text'),
    nameLabel: str(input.nameLabel, DEFAULTS.nameLabel, 20, 'Name question'),
    dateLabel: str(input.dateLabel, DEFAULTS.dateLabel, 40, 'Date question'),
    slotLabel: str(input.slotLabel, DEFAULTS.slotLabel, 20, 'Time question'),
    days: Array.isArray(input.days) ? [...new Set(input.days.map(Number))].filter((d) => d >= 0 && d <= 6).sort() : DEFAULTS.days,
    start: typeof input.start === 'string' ? input.start : DEFAULTS.start,
    end: typeof input.end === 'string' ? input.end : DEFAULTS.end,
    slotMinutes: Number(input.slotMinutes ?? DEFAULTS.slotMinutes),
    capacity: Number(input.capacity ?? DEFAULTS.capacity),
    daysAhead: Number(input.daysAhead ?? DEFAULTS.daysAhead),
    timezone: DEFAULTS.timezone,
  };
  if (!config.days.length) errors.push('Choose at least one day you take bookings.');
  if (!TIME_RE.test(config.start) || !TIME_RE.test(config.end)) errors.push('Opening and closing times must look like 09:30.');
  else if (toMinutes(config.end) <= toMinutes(config.start)) errors.push('Closing time must be after opening time.');
  if (![15, 20, 30, 45, 60, 90, 120].includes(config.slotMinutes)) errors.push('Slot length must be 15, 20, 30, 45, 60, 90 or 120 minutes.');
  if (!Number.isInteger(config.capacity) || config.capacity < 1 || config.capacity > 50) errors.push('People per slot must be between 1 and 50.');
  if (!Number.isInteger(config.daysAhead) || config.daysAhead < 1 || config.daysAhead > 90) errors.push('Bookable days ahead must be between 1 and 90.');
  return { config, errors };
}

// Today's date (YYYY-MM-DD) in the config's timezone, plus offset days.
function localDate(config, now = new Date(), offsetDays = 0) {
  const d = new Date(now.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Bookable window: tomorrow .. daysAhead (today is excluded, so a slot
// can never be in the past).
const dateRange = (config, now) => ({ min: localDate(config, now, 1), max: localDate(config, now, config.daysAhead) });

const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

// All slots on a date (["10:00", ...]); [] when closed that day or outside the window.
function slotsForDate(config, ymd, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return [];
  const { min, max } = dateRange(config, now);
  if (ymd < min || ymd > max || !config.days.includes(weekday(ymd))) return [];
  const out = [];
  for (let t = toMinutes(config.start); t + config.slotMinutes <= toMinutes(config.end); t += config.slotMinutes) out.push(toHHMM(t));
  return out;
}

// Free slots given how many are already booked per time ({ "10:00": 1 }).
function freeSlots(config, ymd, bookedCounts = {}, now) {
  return slotsForDate(config, ymd, now)
    .filter((t) => (bookedCounts[t] || 0) < config.capacity)
    .map((t) => ({ id: t, title: label12(t) }));
}

const dateLabel = (ymd) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]}, ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
};

function buildFlowJson(config) {
  return {
    version: FLOW_JSON_VERSION,
    data_api_version: DATA_API_VERSION,
    routing_model: { DATE: ['SLOTS'], SLOTS: [] },
    screens: [
      {
        id: 'DATE',
        title: config.title,
        data: {
          min_date: { type: 'string', __example__: '2026-12-01' },
          max_date: { type: 'string', __example__: '2026-12-14' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'DatePicker', name: 'date', label: config.dateLabel, required: true, 'min-date': '${data.min_date}', 'max-date': '${data.max_date}' },
            { type: 'Footer', label: 'Next', 'on-click-action': { name: 'data_exchange', payload: { date: '${form.date}' } } },
          ],
        },
      },
      {
        id: 'SLOTS',
        title: config.title,
        terminal: true,
        data: {
          date: { type: 'string', __example__: '2026-12-01' },
          date_label: { type: 'string', __example__: 'Tue, 1 Dec 2026' },
          slots: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
            __example__: [{ id: '10:00', title: '10:00 AM' }],
          },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextBody', text: '${data.date_label}' },
            { type: 'Dropdown', name: 'slot', label: config.slotLabel, required: true, 'data-source': '${data.slots}' },
            { type: 'TextInput', name: 'name', label: config.nameLabel, 'input-type': 'text', required: true },
            { type: 'Footer', label: config.submitLabel, 'on-click-action': { name: 'data_exchange', payload: { date: '${data.date}', slot: '${form.slot}', name: '${form.name}' } } },
          ],
        },
      },
    ],
  };
}

// ---------- Meta's Flows endpoint encryption ----------
function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// Throws on any failure; the endpoint must then answer 421 so WhatsApp
// re-fetches the public key and retries.
function decryptRequest(body, privateKeyPem) {
  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(body.encrypted_aes_key, 'base64')
  );
  const iv = Buffer.from(body.initial_vector, 'base64');
  const data = Buffer.from(body.encrypted_flow_data, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(data.subarray(-16));
  const json = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
  return { request: JSON.parse(json), aesKey, iv };
}

// Response is encrypted with the same key and the bit-flipped IV, base64.
function encryptResponse(response, aesKey, iv) {
  const flipped = Buffer.from(iv.map((b) => b ^ 0xff));
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

// Test/demo helper mirroring what WhatsApp does (encrypt a request with the
// business public key).
function encryptRequestForTest(request, publicKeyPem) {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(request), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    body: {
      encrypted_flow_data: enc.toString('base64'),
      encrypted_aes_key: crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'),
      initial_vector: iv.toString('base64'),
    },
    aesKey, iv,
  };
}
function decryptResponseForTest(b64, aesKey, iv) {
  const data = Buffer.from(b64, 'base64');
  const flipped = Buffer.from(iv.map((b) => b ^ 0xff));
  const d = crypto.createDecipheriv('aes-128-gcm', aesKey, flipped);
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString('utf8'));
}

module.exports = {
  DEFAULTS, normalizeConfig, localDate, dateRange, slotsForDate, freeSlots, dateLabel, buildFlowJson, label12,
  generateKeyPair, decryptRequest, encryptResponse, encryptRequestForTest, decryptResponseForTest,
};
