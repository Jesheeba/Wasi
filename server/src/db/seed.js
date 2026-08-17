// Idempotent: safe to re-run. Ports the mock `state` object from the root app.js
// into real rows for one demo tenant, so the CRM tables aren't empty in dev.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

const DEMO_CLIENT_ID = process.env.DEV_CLIENT_ID || '00000000-0000-0000-0000-000000000001';

// Dev-only credentials, printed at the end of the run. Change before any real deploy.
const DEMO_CLIENT_PASSWORD = 'demo12345';
const DEMO_ADMIN_EMAIL = 'admin@wasi.local';
const DEMO_ADMIN_PASSWORD = 'admin12345';

const MOCK_TAGS = [
  { name: 'Lead', bg: '#DCFCE7', color: '#166534' },
  { name: 'Customer', bg: '#E0F2FE', color: '#0369A1' },
  { name: 'VIP', bg: '#FCE7F3', color: '#BE185D' },
  { name: 'Support', bg: '#FEF3C7', color: '#B45309' },
];

const MOCK_CONTACTS = [
  { name: 'Alex Kumar', phone: '+91 98765 43210', tag: 'Lead', status: 'Active', created: '2026-07-28' },
  { name: 'Priya Sharma', phone: '+91 98123 45678', tag: 'Customer', status: 'Active', created: '2026-07-25' },
  { name: 'Vikram Singh', phone: '+91 97654 32109', tag: 'VIP', status: 'Active', created: '2026-07-20' },
];

const MOCK_CHATS = [
  { name: '919876543210', phone: '+91 98765 43210', tag: 'Lead', unread_count: 4 },
  { name: '919812345678', phone: '+91 98123 45678', tag: 'Customer', unread_count: 1 },
  { name: '919765432109', phone: '+91 97654 32109', tag: 'VIP', unread_count: 12 },
  { name: '919123456789', phone: '+91 91234 56789', tag: 'Lead', unread_count: 2 },
];

// Named parameters, not numbered — Meta now rejects the numbered {{1}}/{{2}}
// style for new templates (see server/src/utils/templateParams.js).
const MOCK_TEMPLATES = [
  { name: 'welcome_offer_v1', category: 'Marketing', body: 'Hello {{customer_name}}, welcome! Use code SAVE10 for 10% off on your next purchase.' },
  { name: 'order_status_update', category: 'Utility', body: 'Hi {{customer_name}}, your order #{{order_number}} has been shipped and is on its way!' },
  { name: 'otp_verification', category: 'Authentication', body: 'Your security verification code is {{otp_code}}. Valid for 10 minutes.' },
];

const MOCK_BROADCASTS = [
  { title: 'August Product Update', tag: 'All Contacts', status: 'Completed', delivered_count: 1250, read_rate: 92.4, scheduled_date: '2026-08-01' },
  { title: 'July Special Offer', tag: 'VIP', status: 'Completed', delivered_count: 450, read_rate: 96.8, scheduled_date: '2026-07-30' },
];

const MOCK_AUTOMATION_RULES = [
  { title: 'Welcome Greeting', trigger: 'Keyword: "hello", "hi"', action: 'Send Welcome Template', status: 'Enabled' },
  { title: 'Lead Qualification', trigger: 'Keyword: "pricing", "cost"', action: 'Assign Tag "Lead"', status: 'Enabled' },
];

const OPEN_CHAT_MESSAGES = [
  { direction: 'in', body: "Hi, I'm interested in your product catalog." },
  { direction: 'out', body: 'Hello! Thanks for reaching out to Wasi. Sending our latest product price list now!' },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const clientPasswordHash = await bcrypt.hash(DEMO_CLIENT_PASSWORD, 10);
    await client.query(
      `insert into clients (id, name, email, status, tenant_slug, password_hash)
       values ($1, 'Wasi Demo Client', 'demo@wasi.local', 'active', 'demo', $2)
       on conflict (id) do update set name = excluded.name, status = excluded.status, password_hash = excluded.password_hash`,
      [DEMO_CLIENT_ID, clientPasswordHash]
    );

    const adminPasswordHash = await bcrypt.hash(DEMO_ADMIN_PASSWORD, 10);
    await client.query(
      `insert into admin_users (name, email, role, password_hash)
       values ('Demo Admin', $1, 'super_admin', $2)
       on conflict (email) do update set password_hash = excluded.password_hash`,
      [DEMO_ADMIN_EMAIL, adminPasswordHash]
    );

    // Wipe this tenant's data (cascades) before re-inserting, so re-runs don't duplicate rows.
    await client.query('delete from subscriptions where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from message_templates where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from automation_rules where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from broadcasts where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from chats where client_id = $1', [DEMO_CLIENT_ID]); // cascades messages
    await client.query('delete from contacts where client_id = $1', [DEMO_CLIENT_ID]);
    await client.query('delete from tags where client_id = $1', [DEMO_CLIENT_ID]);

    await client.query(
      `insert into subscriptions (client_id, plan, status) values ($1, 'Starter', 'active')`,
      [DEMO_CLIENT_ID]
    );

    const tagIdByName = {};
    for (const tag of MOCK_TAGS) {
      const { rows } = await client.query(
        `insert into tags (client_id, name, bg, color) values ($1, $2, $3, $4) returning id`,
        [DEMO_CLIENT_ID, tag.name, tag.bg, tag.color]
      );
      tagIdByName[tag.name] = rows[0].id;
    }

    for (const tpl of MOCK_TEMPLATES) {
      await client.query(
        `insert into message_templates (client_id, name, category, status, body)
         values ($1, $2, $3, 'approved', $4)`,
        [DEMO_CLIENT_ID, tpl.name, tpl.category, tpl.body]
      );
    }

    const contactIdByPhone = {};
    for (const contact of MOCK_CONTACTS) {
      const { rows } = await client.query(
        `insert into contacts (client_id, name, phone, tag_id, status, created_at)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [DEMO_CLIENT_ID, contact.name, contact.phone, tagIdByName[contact.tag] || null, contact.status, contact.created]
      );
      contactIdByPhone[contact.phone] = rows[0].id;
    }

    for (const chat of MOCK_CHATS) {
      const { rows } = await client.query(
        `insert into chats (client_id, contact_id, name, phone, tag_id, unread_count)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          DEMO_CLIENT_ID,
          contactIdByPhone[chat.phone] || null,
          chat.name,
          chat.phone,
          tagIdByName[chat.tag] || null,
          chat.unread_count,
        ]
      );
      const chatId = rows[0].id;
      for (const msg of OPEN_CHAT_MESSAGES) {
        await client.query(
          `insert into messages (chat_id, client_id, direction, body) values ($1, $2, $3, $4)`,
          [chatId, DEMO_CLIENT_ID, msg.direction, msg.body]
        );
      }
    }

    for (const b of MOCK_BROADCASTS) {
      await client.query(
        `insert into broadcasts (client_id, title, tag_id, status, delivered_count, read_rate, scheduled_date)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [DEMO_CLIENT_ID, b.title, tagIdByName[b.tag] || null, b.status, b.delivered_count, b.read_rate, b.scheduled_date]
      );
    }

    for (const rule of MOCK_AUTOMATION_RULES) {
      await client.query(
        `insert into automation_rules (client_id, title, trigger, action, status)
         values ($1, $2, $3, $4, $5)`,
        [DEMO_CLIENT_ID, rule.title, rule.trigger, rule.action, rule.status]
      );
    }

    await client.query('COMMIT');
    console.log(`Seed complete for client ${DEMO_CLIENT_ID}`);
    console.log(`Demo client login: demo@wasi.local / ${DEMO_CLIENT_PASSWORD}`);
    console.log(`Demo admin login: ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
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
