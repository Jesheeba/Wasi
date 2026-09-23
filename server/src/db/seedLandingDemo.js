// Seeds one demo client — "Vetri Academy (Demo)" — with enough realistic
// data for the marketing landing page's Playwright screenshots (chat inbox,
// campaign detail, flow builder), and doubles as the browser-verification
// fixture for the chat date/time UI work: Rahul Menon's chat (suffix '02')
// has a 3-message trailing unread run straddling local midnight (Today AND
// Yesterday pills both appear, divider lands before the run), and Divya
// Krishnan's chat (suffix '09') plus 3 other campaign recipients get a real
// failed outbound message with an error reason (see CAMPAIGN_FAIL_REASON).
// Idempotent: safe to re-run, always wipes and reinserts this ONE client's
// own rows first, keyed by a fixed id, and never touches any other
// client's data.
//
// Makes NO Meta API call of any kind. Every row is a plain INSERT — no
// wabas row is created (the CRM UI doesn't require one to show the Chat/
// Campaigns/Flow Builder views), no broadcast is left in a 'Sending' or
// 'Scheduled' status (the ones broadcastRunner.js's live tick() actually
// polls — see CLAUDE.md's "REAL, LIVE background workers" convention),
// and no flow is wired to an automation_rules trigger, so nothing here can
// ever be picked up by broadcastRunner/flowRunner/forwardRunner/alertRunner,
// which really do poll this same shared database continuously.
//
// Run (from server/), against the shared dev/prod database, exactly as
// this project's own db:seed already does for the same reason:
//
//   ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk npx dotenv -e .env -- node src/db/seedLandingDemo.js
//
// (PowerShell: $env:ALLOW_SHARED_PRODUCTION_DB='yes-i-understand-the-risk'; npx dotenv -e .env -- node src/db/seedLandingDemo.js)
//
// Teardown: src/db/teardownLandingDemo.js (same env var, same invocation shape).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

// Fixed, obviously-synthetic id so re-running this script always targets
// the exact same client row (on conflict do update) instead of creating a
// new one each time. Not derived from gen_random_uuid() on purpose.
const DEMO_CLIENT_ID = 'f0000000-1111-4111-8111-111111111111';
const DEMO_CLIENT_EMAIL = 'demo+vetri-academy@wasi.local';
const DEMO_CLIENT_PASSWORD = process.env.LANDING_DEMO_PASSWORD || 'VetriDemo-2026';

const NOW = new Date();

function daysAgoAt(days, hour, minute, second = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, second, 0);
  return d;
}
function plus(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

// --- Tags -------------------------------------------------------------
const TAGS = [
  { key: 'batch', name: 'Weekend NEET Batch', bg: '#DCFCE7', color: '#166534' },
  { key: 'lead', name: 'Lead', bg: '#FEF3C7', color: '#B45309' },
  { key: 'enrolled', name: 'Enrolled', bg: '#E0F2FE', color: '#0369A1' },
  { key: 'payment', name: 'Payment Pending', bg: '#FEE2E2', color: '#B91C1C' },
];

// --- Deepa R. — the approved story, told in full -----------------------
// Beat timestamps are relative to whenever this script actually runs (see
// daysAgoAt), never hardcoded calendar dates, so the demo never drifts into
// the future or looks stale no matter when it's (re-)run.
const DEEPA_BEAT1 = daysAgoAt(26, 22, 47, 0); // Sat 10:47pm — her question
const DEEPA_BEAT2 = plus(DEEPA_BEAT1, 5); // instant bot reply
const DEEPA_BEAT2B = plus(DEEPA_BEAT1, 65); // she taps "Fee details"
const DEEPA_BEAT3 = daysAgoAt(25, 9, 12, 0); // Sun 9:12am — Priya
const DEEPA_BEAT3B = plus(DEEPA_BEAT3, 140); // "Yes please"
const DEEPA_BEAT4 = plus(DEEPA_BEAT3, 240); // confirmation template
const DEEPA_BEAT4_READ = plus(DEEPA_BEAT4, 600); // ticks turn blue ~10min later
const CAMPAIGN_AT = daysAgoAt(4, 11, 0, 0); // "three weeks later" from beat 3/4

// Any computed timestamp is clamped to at most 30s before script start —
// belt-and-suspenders against a fixed early-morning clock time (e.g.
// Rahul Menon's 00:05 "today" message below) landing in the future on the
// rare run that happens to start before that clock time. A day-scale
// "daysAgo" value is never close enough to NOW for this to change it.
function clampPast(date) {
  const safeNow = plus(NOW, -30);
  return date < safeNow ? date : safeNow;
}

// --- Filler contacts — enough for a lived-in inbox + campaign recipients.
// Each has a real, plausible coaching-institute exchange. `campaign` marks
// which effective_status bucket (see broadcastRecipientsRepo.listByBroadcast)
// this contact lands in for the seeded campaign below.
const HAND_FILLER = [
  {
    // Also the date/time UI's midnight + unread-divider test case: the last
    // two messages straddle local midnight (23:50 the day before "today" ->
    // 00:05 "today"), and all 3 messages here are the trailing unread run
    // unread_count below is set to match — both Today and Yesterday date
    // pills must appear in this one chat, with the divider landing right
    // before the first of the three.
    suffix: '02', name: 'Rahul Menon', tag: 'lead', campaign: 'sent',
    messages: [
      { dir: 'in', daysAgo: 2, hour: 14, minute: 10, body: "Do you have any weekday batches too, or only weekends?" },
      { dir: 'in', daysAgo: 1, hour: 23, minute: 50, body: 'Also, is late registration still open for this batch?' },
      { dir: 'in', daysAgo: 0, hour: 0, minute: 5, body: 'Sorry, meant the NEET batch specifically.' },
    ],
    unread: 3, status: 'open',
  },
  {
    suffix: '03', name: 'Sanjana Iyer', tag: 'enrolled', campaign: 'read',
    messages: [
      { dir: 'in', daysAgo: 18, hour: 16, minute: 5, body: "Can I get the class notes for last week's physics session?" },
      { dir: 'out', daysAgo: 18, hour: 16, minute: 25, body: 'Sure! Sharing the physics notes PDF right away.', status: 'read' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '04', name: 'Arjun Nair', tag: 'batch', campaign: 'delivered',
    messages: [
      { dir: 'in', daysAgo: 6, hour: 10, minute: 0, body: 'Is there a demo class before I pay the fee?' },
      { dir: 'out', daysAgo: 6, hour: 11, minute: 0, body: 'Yes, we run a free demo every Saturday morning. Want me to book your slot?', status: 'delivered' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '05', name: 'Kavya Reddy', tag: 'payment', campaign: 'delivered',
    messages: [
      { dir: 'in', daysAgo: 9, hour: 19, minute: 0, body: "I'll pay the second instalment by this Friday, is that fine?" },
      { dir: 'out', daysAgo: 9, hour: 19, minute: 30, body: 'That works, thanks for letting us know!', status: 'read' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '06', name: 'Mohammed Faizal', tag: 'lead', campaign: 'sent',
    messages: [{ dir: 'in', daysAgo: 3, hour: 12, minute: 0, body: "What's the fee for the JEE batch?" }],
    unread: 1, status: 'open',
  },
  {
    suffix: '07', name: 'Ananya Pillai', tag: 'enrolled', campaign: 'delivered',
    messages: [
      { dir: 'in', daysAgo: 14, hour: 9, minute: 0, body: 'Can I switch from the online batch to the weekend offline one?' },
      { dir: 'out', daysAgo: 14, hour: 11, minute: 0, body: "Yes, we can move you — I'll update your batch by tomorrow.", status: 'delivered' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '08', name: 'Vishnu Prasad', tag: 'batch', campaign: 'read',
    messages: [
      { dir: 'in', daysAgo: 11, hour: 17, minute: 0, body: 'Do you provide printed study material or only PDFs?' },
      { dir: 'out', daysAgo: 11, hour: 17, minute: 40, body: 'We provide both — printed material at the centre and PDFs on request.', status: 'read' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '09', name: 'Divya Krishnan', tag: 'lead', campaign: 'failed',
    messages: [
      { dir: 'in', daysAgo: 20, hour: 15, minute: 0, body: 'Not interested right now, will reach out later.' },
      { dir: 'out', daysAgo: 20, hour: 15, minute: 5, body: "No problem, Divya! We're here whenever you're ready.", status: 'read' },
    ],
    unread: 0, status: 'resolved',
  },
  {
    suffix: '10', name: 'Karthik Subramaniam', tag: 'payment', campaign: 'sent',
    messages: [{ dir: 'in', daysAgo: 7, hour: 20, minute: 0, body: 'Sending the payment screenshot in a bit.' }],
    unread: 1, status: 'open',
  },
  {
    suffix: '11', name: 'Meera Pillai', tag: 'batch', campaign: 'read',
    messages: [
      { dir: 'in', daysAgo: 13, hour: 8, minute: 30, body: 'Can my brother also join the same batch?' },
      { dir: 'out', daysAgo: 13, hour: 8, minute: 55, body: "Of course — just share his details and we'll enrol him too.", status: 'read' },
    ],
    unread: 0, status: 'open',
  },
  {
    suffix: '12', name: 'Aravind Kumar', tag: 'enrolled', campaign: 'delivered',
    messages: [
      { dir: 'in', daysAgo: 22, hour: 18, minute: 0, body: 'Thank you for the crash course, it really helped!' },
      { dir: 'out', daysAgo: 22, hour: 18, minute: 10, body: 'So glad to hear that, Aravind! All the best for your exam.', status: 'read' },
    ],
    unread: 0, status: 'resolved',
  },
  {
    suffix: '13', name: 'Nithya Balan', tag: 'lead', campaign: 'pending',
    messages: [{ dir: 'in', daysAgo: 5, hour: 13, minute: 0, body: 'Is the NEET batch only for 12th grade students, or droppers too?' }],
    unread: 1, status: 'open',
  },
];

// --- Extra lightweight recipients, so the campaign has ~50 recipients
// total instead of 13 (real recipient rows, computed stats — see
// broadcastsRepo.findByIdWithStats — not fabricated numbers; still small,
// demo-scale volume on purpose, never thousands). Each gets one short
// inbound message rather than a full hand-written exchange like
// HAND_FILLER above — plenty for a lived-in-looking inbox row and a valid
// campaign recipient, without hand-authoring 37 more conversations.
const EXTRA_NAMES = [
  'Harini Ramesh', 'Suresh Babu', 'Lakshmi Narayanan', 'Vignesh Raja', 'Pooja Varma',
  'Karthikeyan S', 'Deepika Menon', 'Naveen Kumar', 'Swathi Iyer', 'Ramesh Chandran',
  'Anjali Nair', 'Gokul Krishnan', 'Preethi Raman', 'Sathish Kumar', 'Nandini Rao',
  'Vijay Anand', 'Kiruthika M', 'Prakash Raj', 'Yamini Sundaram', 'Bala Murugan',
  'Shalini Devi', 'Manikandan R', 'Revathi S', 'Dinesh Kartik', 'Anushka Pillai',
  'Selvam K', 'Divakar T', 'Hema Latha', 'Ashwin Prabhu', 'Meenakshi Sundari',
  'Jagadeesh V', 'Priyanka R', 'Rajesh Kanna', 'Sowmya Balaji', 'Ilangovan P',
  'Nithin Raj', 'Kavitha Mohan',
];
const EXTRA_MESSAGE_POOL = [
  'Is there a trial class before I enrol?',
  'What time does the weekend batch start?',
  'Do you have study material in Tamil as well?',
  'Can I pay the fee in instalments?',
  'Is the NEET batch only for repeaters?',
  'How many students are there per batch?',
  'Do you provide hostel facilities nearby?',
  'Can I switch batches later if needed?',
  'Is there a sibling discount available?',
  'Do you send recorded videos of the sessions?',
];
const EXTRA_TAG_KEYS = ['batch', 'lead', 'enrolled', 'payment'];

// Round-robin, not blocks — so the resulting recipient list isn't visibly
// grouped by outcome when someone scrolls the campaign detail table.
function buildBucketSequence(counts) {
  const pools = Object.entries(counts).map(([bucket, remaining]) => ({ bucket, remaining }));
  const seq = [];
  while (pools.some((p) => p.remaining > 0)) {
    for (const p of pools) {
      if (p.remaining > 0) { seq.push(p.bucket); p.remaining -= 1; }
    }
  }
  return seq;
}
// HAND_FILLER + Deepa already contribute 4 read / 4 delivered / 3 sent /
// 1 failed / 1 pending (13). These bring the total to 50 at roughly the
// same ratio: 15 read / 15 delivered / 12 sent / 4 failed / 4 pending.
const EXTRA_BUCKET_SEQUENCE = buildBucketSequence({ read: 11, delivered: 11, sent: 9, failed: 3, pending: 3 });

const EXTRA_FILLER = EXTRA_NAMES.map((name, idx) => {
  const suffix = String(14 + idx).padStart(2, '0');
  return {
    suffix,
    name,
    tag: EXTRA_TAG_KEYS[idx % EXTRA_TAG_KEYS.length],
    campaign: EXTRA_BUCKET_SEQUENCE[idx],
    messages: [{
      dir: 'in',
      daysAgo: 3 + (idx % 24),
      hour: 9 + (idx % 10),
      minute: (idx * 7) % 60,
      body: EXTRA_MESSAGE_POOL[idx % EXTRA_MESSAGE_POOL.length],
    }],
    unread: idx % 5 === 0 ? 1 : 0,
    status: idx % 11 === 0 ? 'resolved' : 'open',
  };
});

const FILLER = [...HAND_FILLER, ...EXTRA_FILLER];

const CAMPAIGN_BODY = 'Crash course for the January attempt opens Monday. Existing students get 20% off.';
const CAMPAIGN_FAIL_REASON = "This number can't receive WhatsApp messages (not on WhatsApp, or has an outdated app).";
const CAMPAIGN_FAIL_CODE = 131026;

// --- One saved (draft) flow with a real branch, for the flow builder shot.
const FLOW_NODES = [
  {
    key: 'ask', type: 'send_interactive_buttons', position: { x: 80, y: 180 },
    config: {
      body: 'Hi! Yes — the weekend NEET batch starts 6 October, 9am–1pm. Would you like the fee details or a call back?',
      buttons: [{ id: 'fee_details', title: 'Fee details' }, { id: 'call_me', title: 'Call me' }],
    },
  },
  {
    key: 'fee', type: 'send_text', position: { x: 460, y: 40 },
    config: { body: 'Here are the fee details: ₹18,000 for the full course, payable in two instalments. Reply YES to hold your seat.' },
  },
  {
    key: 'callback', type: 'send_text', position: { x: 460, y: 320 },
    config: { body: 'Thanks! One of our team will call you back within the hour.' },
  },
];
const FLOW_EDGES = [
  { from: 'ask', to: 'fee', condition_type: 'button_id', condition_value: 'fee_details', priority: 0 },
  { from: 'ask', to: 'callback', condition_type: 'button_id', condition_value: 'call_me', priority: 1 },
];

async function seed() {
  const client = await pool.connect();
  client.on('error', (err) => console.error('seedLandingDemo: checked-out client error:', err.message));
  try {
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(DEMO_CLIENT_PASSWORD, 10);
    await client.query(
      `insert into clients (id, name, email, status, tenant_slug, password_hash, email_verified)
       values ($1, 'Vetri Academy (Demo)', $2, 'active', 'vetri-academy-demo', $3, true)
       on conflict (id) do update set
         name = excluded.name, email = excluded.email, status = excluded.status,
         tenant_slug = excluded.tenant_slug, password_hash = excluded.password_hash,
         email_verified = excluded.email_verified`,
      [DEMO_CLIENT_ID, DEMO_CLIENT_EMAIL, passwordHash]
    );

    // Wipe this client's own rows before reinserting — cascades handle every
    // child table (broadcasts -> broadcast_recipients, chats -> messages,
    // contacts -> contact_tags, automation_flows -> flow_nodes/flow_edges).
    await client.query('delete from subscriptions where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from broadcasts where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from chats where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from contacts where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from tags where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from team_members where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from automation_flows where client_id = $1', [DEMO_CLIENT_ID]);

    // No subscriptions row, deliberately: admin's real /api/admin/billing/
    // overview sums the price of every 'active' subscription across ALL
    // clients into estimatedMrr, unfiltered — an 'active' Starter row here
    // would inflate that real figure. Nothing in the Chat/Campaigns/Flow
    // Builder screenshots this seed exists for needs one; the only place a
    // missing subscription is even visible is Settings > Subscription (a
    // "No active subscription yet" card), a tab none of the 5 target
    // screenshots open.

    const tagId = {};
    for (const t of TAGS) {
      const { rows } = await client.query(
        `insert into tags (client_id, name, bg, color) values ($1, $2, $3, $4) returning id`,
        [DEMO_CLIENT_ID, t.name, t.bg, t.color]
      );
      tagId[t.key] = rows[0].id;
    }

    const { rows: [priya] } = await client.query(
      `insert into team_members (client_id, name, email, role, status)
       values ($1, 'Priya', 'priya@vetri-academy-demo.wasi.local', 'Agent', 'active') returning id`,
      [DEMO_CLIENT_ID]
    );

    // --- Deepa R. --------------------------------------------------------
    const { rows: [deepaContact] } = await client.query(
      `insert into contacts (client_id, name, phone, tag_id, status, created_at, opt_in_status, opt_in_source, opt_in_at)
       values ($1, 'Deepa R.', '+91 90000 00001', $2, 'Active', $3, 'opted_in', 'manual', $3) returning id`,
      [DEMO_CLIENT_ID, tagId.batch, DEEPA_BEAT1]
    );
    await client.query(`insert into contact_tags (contact_id, tag_id, client_id) values ($1, $2, $3)`, [deepaContact.id, tagId.batch, DEMO_CLIENT_ID]);

    const { rows: [deepaChat] } = await client.query(
      `insert into chats (client_id, contact_id, name, phone, tag_id, assigned_team_member_id, status, last_message_at, unread_count)
       values ($1, $2, 'Deepa R.', '+91 90000 00001', $3, $4, 'open', $5, 0) returning id`,
      [DEMO_CLIENT_ID, deepaContact.id, tagId.batch, priya.id, CAMPAIGN_AT]
    );

    async function insertMessage(chatId, { dir, body, sentAt, status = null, deliveredAt = null, readAt = null, failedAt = null, errorReason = null, metaErrorCode = null }) {
      const finalStatus = status || (dir === 'in' ? 'delivered' : 'sent');
      const { rows } = await client.query(
        `insert into messages (chat_id, client_id, direction, body, sent_at, status, delivered_at, read_at, failed_at, error_reason, meta_error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [chatId, DEMO_CLIENT_ID, dir, body, sentAt, finalStatus, deliveredAt, readAt, failedAt, errorReason, metaErrorCode]
      );
      return rows[0].id;
    }

    await insertMessage(deepaChat.id, { dir: 'in', body: 'Hi, is the weekend NEET batch still open?', sentAt: DEEPA_BEAT1 });
    await insertMessage(deepaChat.id, {
      dir: 'out',
      body: 'Hi! Yes — the weekend NEET batch starts 6 October, Saturday and Sunday, 9am to 1pm. Would you like the fee details or a call back?',
      sentAt: DEEPA_BEAT2, status: 'read', deliveredAt: plus(DEEPA_BEAT2, 3), readAt: plus(DEEPA_BEAT2B, 5),
    });
    await insertMessage(deepaChat.id, { dir: 'in', body: 'Fee details', sentAt: DEEPA_BEAT2B });
    await insertMessage(deepaChat.id, {
      dir: 'out',
      body: 'Good morning! Priya here from Vetri Academy. The weekend batch is ₹18,000 for the full course, payable in two instalments. Shall I hold a seat for you?',
      sentAt: DEEPA_BEAT3, status: 'read', deliveredAt: plus(DEEPA_BEAT3, 5), readAt: plus(DEEPA_BEAT3B, 10),
    });
    await insertMessage(deepaChat.id, { dir: 'in', body: 'Yes please', sentAt: DEEPA_BEAT3B });
    await insertMessage(deepaChat.id, {
      dir: 'out',
      body: 'Your seat is confirmed. Vetri Academy — Weekend NEET batch, starts 6 October, 9:00am.',
      sentAt: DEEPA_BEAT4, status: 'read', deliveredAt: plus(DEEPA_BEAT4, 4), readAt: DEEPA_BEAT4_READ,
    });

    // --- Filler contacts + chats ------------------------------------------
    const contactByKey = { deepa: { id: deepaContact.id, chatId: deepaChat.id } };
    for (const f of FILLER) {
      const createdAt = daysAgoAt(f.messages[0].daysAgo + 1, 9, 0, 0);
      const { rows: [contact] } = await client.query(
        `insert into contacts (client_id, name, phone, tag_id, status, created_at, opt_in_status, opt_in_source, opt_in_at)
         values ($1, $2, $3, $4, 'Active', $5, 'opted_in', 'manual', $5) returning id`,
        [DEMO_CLIENT_ID, f.name, `+91 90000 000${f.suffix}`, tagId[f.tag], createdAt]
      );
      await client.query(`insert into contact_tags (contact_id, tag_id, client_id) values ($1, $2, $3)`, [contact.id, tagId[f.tag], DEMO_CLIENT_ID]);

      const lastMsg = f.messages[f.messages.length - 1];
      const lastMsgAt = clampPast(daysAgoAt(lastMsg.daysAgo, lastMsg.hour, lastMsg.minute));
      const { rows: [chat] } = await client.query(
        `insert into chats (client_id, contact_id, name, phone, tag_id, status, last_message_at, unread_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [DEMO_CLIENT_ID, contact.id, f.name, `+91 90000 000${f.suffix}`, tagId[f.tag], f.status, lastMsgAt, f.unread]
      );

      for (const m of f.messages) {
        await insertMessage(chat.id, { dir: m.dir, body: m.body, sentAt: clampPast(daysAgoAt(m.daysAgo, m.hour, m.minute)), status: m.status });
      }
      contactByKey[f.suffix] = { id: contact.id, chatId: chat.id, campaign: f.campaign };
    }

    // --- Campaign / broadcast ---------------------------------------------
    const { rows: [broadcast] } = await client.query(
      `insert into broadcasts (client_id, title, tag_id, status, template_name, scheduled_date, created_at)
       values ($1, 'January Crash Course — Early Bird', $2, 'Completed', 'crash_course_jan_promo', $3, $4) returning id`,
      [DEMO_CLIENT_ID, tagId.batch, CAMPAIGN_AT.toISOString().slice(0, 10), daysAgoAt(4, 10, 30, 0)]
    );

    const recipients = [
      { key: 'deepa', bucket: 'read' },
      ...FILLER.map((f) => ({ key: f.suffix, bucket: f.campaign })),
    ];

    let i = 0;
    for (const r of recipients) {
      const target = contactByKey[r.key];
      const sentAt = plus(CAMPAIGN_AT, i * 47);
      i += 1;

      if (r.bucket === 'pending') {
        await client.query(
          `insert into broadcast_recipients (broadcast_id, contact_id, client_id, status) values ($1, $2, $3, 'pending')`,
          [broadcast.id, target.id, DEMO_CLIENT_ID]
        );
        continue;
      }

      let messageId;
      if (r.bucket === 'failed') {
        messageId = await insertMessage(target.chatId, {
          dir: 'out', body: CAMPAIGN_BODY, sentAt, status: 'failed',
          failedAt: plus(sentAt, 60), errorReason: CAMPAIGN_FAIL_REASON, metaErrorCode: CAMPAIGN_FAIL_CODE,
        });
      } else if (r.bucket === 'read') {
        messageId = await insertMessage(target.chatId, {
          dir: 'out', body: CAMPAIGN_BODY, sentAt, status: 'read',
          deliveredAt: plus(sentAt, 90), readAt: plus(sentAt, 60 * 25),
        });
      } else if (r.bucket === 'delivered') {
        messageId = await insertMessage(target.chatId, {
          dir: 'out', body: CAMPAIGN_BODY, sentAt, status: 'delivered', deliveredAt: plus(sentAt, 90),
        });
      } else {
        messageId = await insertMessage(target.chatId, { dir: 'out', body: CAMPAIGN_BODY, sentAt, status: 'sent' });
      }

      await client.query(`update chats set last_message_at = $2 where id = $1 and last_message_at < $2`, [target.chatId, sentAt]);
      await client.query(
        `insert into broadcast_recipients (broadcast_id, contact_id, client_id, message_id, status) values ($1, $2, $3, $4, 'sent')`,
        [broadcast.id, target.id, DEMO_CLIENT_ID, messageId]
      );
    }

    // --- Flow (draft, unattached to any automation_rules trigger — inert) -
    const { rows: [flow] } = await client.query(
      `insert into automation_flows (client_id, name, status) values ($1, 'New Enquiry -> Fee or Callback', 'draft') returning id`,
      [DEMO_CLIENT_ID]
    );
    const nodeId = {};
    for (const n of FLOW_NODES) {
      const { rows } = await client.query(
        `insert into flow_nodes (flow_id, client_id, type, config, position) values ($1, $2, $3, $4, $5) returning id`,
        [flow.id, DEMO_CLIENT_ID, n.type, JSON.stringify(n.config), JSON.stringify(n.position)]
      );
      nodeId[n.key] = rows[0].id;
    }
    await client.query(`update automation_flows set entry_node_id = $2 where id = $1`, [flow.id, nodeId.ask]);
    for (const e of FLOW_EDGES) {
      await client.query(
        `insert into flow_edges (flow_id, client_id, from_node_id, to_node_id, condition_type, condition_value, priority)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [flow.id, DEMO_CLIENT_ID, nodeId[e.from], nodeId[e.to], e.condition_type, e.condition_value, e.priority]
      );
    }

    await client.query('COMMIT');
    console.log(`Seed complete for client ${DEMO_CLIENT_ID}`);
    console.log(`Demo client login: ${DEMO_CLIENT_EMAIL} / ${DEMO_CLIENT_PASSWORD}`);
    console.log(`${1 + FILLER.length} contacts, 1 campaign (${recipients.length} recipients: 15 read / 15 delivered / 12 sent / 4 failed / 4 pending), 1 draft flow with a 2-way branch.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
