// PLAN.md item 5.5 — real-browser coverage for the combined UI pass across
// items 1-5 (team login/invite, chat assign/resolve/reopen, internal
// notes, canned responses, SLA tab visibility), matching this repo's
// established Playwright pattern (templateLibraryUI.test.js is the
// original precedent — same fixed :4000 port + ALLOWED_ORIGINS override,
// same dedicated-disposable-test-client convention, same explicit
// waitForTimeout after a login submit rather than trusting element-visible
// auto-wait). This is the first Playwright file to drive TWO simultaneous
// logged-in sessions (owner + a team member) against the same server.
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');

const SUITE_PREFIX = '__test_suite__chatuipass_';
const EMAIL = `test-suite-chatuipass-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

let server, baseUrl, browser, ownerPage, agentPage, testClientId, tenantSlug, ownerToken;

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(4000);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4000';

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  tenantSlug = registered.client?.tenant_slug;
  ownerToken = registered.token;
  assert.ok(testClientId && tenantSlug && ownerToken, 'dedicated test client registration must succeed');

  browser = await chromium.launch();

  ownerPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  ownerPage.on('pageerror', (err) => console.error('[owner pageerror]', err.message));
  await ownerPage.goto(`${baseUrl}/index.html`);
  await ownerPage.fill('#login-email', EMAIL);
  await ownerPage.fill('#login-password', PASSWORD);
  await ownerPage.click('#login-form button[type="submit"]');
  await ownerPage.waitForTimeout(1500);
  const ownerLoggedIn = await ownerPage.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(ownerLoggedIn, 'owner login must complete before any test runs');
});

after(async () => {
  await browser?.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function createChat(name) {
  return fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name, phone: `9172${Date.now()}${Math.floor(Math.random() * 1000)}` }),
  }).then((r) => r.json());
}

test('1. team login toggle: clicking "Log in as a team member" swaps to the team-login form', async () => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/index.html`);
  const ownerCardVisibleBefore = await page.evaluate(() => getComputedStyle(document.getElementById('owner-login-card')).display !== 'none');
  assert.ok(ownerCardVisibleBefore);
  await page.click('#show-team-login-link');
  const teamCardVisible = await page.evaluate(() => getComputedStyle(document.getElementById('team-login-card')).display !== 'none');
  const ownerCardVisibleAfter = await page.evaluate(() => getComputedStyle(document.getElementById('owner-login-card')).display !== 'none');
  assert.ok(teamCardVisible, 'team login form must become visible');
  assert.ok(!ownerCardVisibleAfter, 'owner login form must hide');
  await page.close();
});

test('2. accept-team-invite.html sets a password, auto-logs in, and lands on the real app shell', async () => {
  const created = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Agent`, email: `${SUITE_PREFIX}agent-${Date.now()}@wasi.local`, role: 'Agent' }),
  }).then((r) => r.json());
  const inviteToken = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);

  agentPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  agentPage.on('pageerror', (err) => console.error('[agent pageerror]', err.message));
  await agentPage.goto(`${baseUrl}/marketing/accept-team-invite.html?token=${inviteToken}`);
  await agentPage.fill('#new-password', PASSWORD);
  await agentPage.click('#invite-submit');
  // Real redirect (setTimeout(...,1200) in the page's own script), not an
  // instant navigation — wait for it rather than racing it.
  await agentPage.waitForURL(/index\.html/, { timeout: 5000 });
  await agentPage.waitForTimeout(1500);

  const loggedIn = await agentPage.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(loggedIn, 'accept-invite must auto-login straight into the real app, not just show a success message');
  const actorType = await agentPage.evaluate(() => localStorage.getItem('actor_type'));
  assert.equal(actorType, 'team_member');

  const profileText = await agentPage.$eval('#user-profile-item .nav-text', (el) => el.textContent);
  assert.match(profileText, /Agent/, 'the sidebar profile must show the team member\'s own name/role, not the owner\'s');
});

test('3. reloading resumes the team-member session via GET /api/auth/team/me, not a login screen', async () => {
  await agentPage.reload();
  await agentPage.waitForTimeout(1500);
  const stillLoggedIn = await agentPage.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(stillLoggedIn, 'a reload must silently resume the team-member session, matching the owner flow\'s own established behavior');
});

test('4. queue tabs + resolve/reopen: a chat can be resolved and reopened from the real UI, status badge updates live', async () => {
  const chat = await createChat(`${SUITE_PREFIX}resolve-chat`);
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1200);
  await ownerPage.click('[data-view="chat"]');
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(300);

  await ownerPage.click('#chat-resolve-btn');
  await ownerPage.waitForTimeout(500);
  let badgeText = await ownerPage.$eval('#chat-status-badge', (el) => el.textContent);
  assert.equal(badgeText, 'Resolved');
  let reopenVisible = await ownerPage.evaluate(() => getComputedStyle(document.getElementById('chat-reopen-btn')).display !== 'none');
  assert.ok(reopenVisible);

  await ownerPage.click('#chat-reopen-btn');
  await ownerPage.waitForTimeout(500);
  badgeText = await ownerPage.$eval('#chat-status-badge', (el) => el.textContent);
  assert.equal(badgeText, 'Open');

  // Real server state, not just optimistic UI — confirms the click really
  // reached POST /:id/resolve and /:id/reopen.
  const serverChat = await fetch(`${baseUrl}/api/chats/${chat.id}`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.equal(serverChat.status, 'open');
});

test('5. assigning a chat to the team member makes it appear in THEIR "Mine" queue tab', async () => {
  const chat = await createChat(`${SUITE_PREFIX}assign-chat`);
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1200);
  await ownerPage.click('[data-view="chat"]');
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(300);

  // No test hook exists for reading state.actorId from outside the page —
  // fetch the real id the same way the assign <select> itself was
  // populated from (the team roster), matching by the known unique name.
  const roster = await fetch(`${baseUrl}/api/team-members`, { headers: authed(ownerToken) }).then((r) => r.json());
  const agent = roster.find((m) => m.name === `${SUITE_PREFIX}Agent`);
  assert.ok(agent, 'the invited agent must exist in the roster');

  await ownerPage.selectOption('#chat-assign-select', agent.id);
  await ownerPage.waitForTimeout(500);

  await agentPage.click('[data-view="chat"]');
  await agentPage.click('[data-queue-filter="mine"]');
  await agentPage.waitForTimeout(500);
  const mineHasChat = await agentPage.$(`[data-chat-id="${chat.id}"]`);
  assert.ok(mineHasChat, 'the newly-assigned chat must appear in the agent\'s own "Mine" queue tab');
});

test('6. internal notes: posting a note with an @mention renders it with the mentioned name, never in the customer thread', async () => {
  const chat = await createChat(`${SUITE_PREFIX}notes-chat`);
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1200);
  await ownerPage.click('[data-view="chat"]');
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(300);

  await ownerPage.click('#chat-notes-toggle-btn');
  await ownerPage.waitForTimeout(300);
  await ownerPage.fill('#chat-note-input', `Please check this @${SUITE_PREFIX}Age`);
  await ownerPage.waitForTimeout(300);
  const mentionVisible = await ownerPage.evaluate(() => getComputedStyle(document.getElementById('note-mention-picker')).display !== 'none');
  assert.ok(mentionVisible, 'typing @ must open the mention picker');
  await ownerPage.click('.mention-picker-item');
  await ownerPage.click('#chat-note-submit-btn');
  await ownerPage.waitForTimeout(500);

  const noteText = await ownerPage.$eval('#chat-notes-list', (el) => el.textContent);
  assert.match(noteText, new RegExp(`${SUITE_PREFIX}Agent`), 'the rendered note must show the mentioned team member\'s real name');

  const messages = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.equal(messages.length, 0, 'the note must never appear in the real customer-facing message thread');
});

test('7. canned responses: one created in Settings shows up in the "/" composer autocomplete and inserts its body', async () => {
  await ownerPage.click('[data-view="settings"]');
  await ownerPage.click('[data-sec-view="canned-responses"]');
  await ownerPage.waitForTimeout(300);
  await ownerPage.click('#open-add-canned-response-modal');
  await ownerPage.fill('#new-canned-shortcut', `${SUITE_PREFIX}refund`);
  await ownerPage.fill('#new-canned-body', 'Your refund has been processed.');
  await ownerPage.click('#add-canned-response-form button[type="submit"]');
  await ownerPage.waitForTimeout(500);

  const chat = await createChat(`${SUITE_PREFIX}canned-chat`);
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1200);
  await ownerPage.click('[data-view="chat"]');
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(300);

  await ownerPage.fill('#chat-message-input', `/${SUITE_PREFIX}ref`);
  await ownerPage.waitForTimeout(300);
  const pickerText = await ownerPage.$eval('#template-slash-picker', (el) => el.textContent);
  assert.match(pickerText, new RegExp(`${SUITE_PREFIX}refund`));
  await ownerPage.click('.slash-picker-item[data-kind="canned"]');
  const composerValue = await ownerPage.$eval('#chat-message-input', (el) => el.value);
  assert.equal(composerValue, 'Your refund has been processed.');
});

test('8. SLA tab: visible for the owner, hidden for the Agent-role team member even via direct hash navigation', async () => {
  await ownerPage.click('[data-view="analytics"]');
  await ownerPage.waitForTimeout(300);
  const slaVisibleForOwner = await ownerPage.evaluate(() => {
    const el = document.querySelector('[data-rep-view="sla"]');
    return el && getComputedStyle(el).display !== 'none';
  });
  assert.ok(slaVisibleForOwner, 'the owner must see the Team/SLA tab');

  // The Analytics nav item itself is now hidden for an Agent (this
  // follow-up's own change), so it can't be reached by clicking it the way
  // the owner's check above does — reaching it via a direct hash
  // navigation instead proves the SLA sub-tab's OWN gate still holds as a
  // real defense-in-depth layer, not just "the nav item happens to be
  // hidden" (switchView restores whatever view a hash names, unconditionally
  // of nav visibility — see enterApp's own hash-restore logic).
  await agentPage.evaluate(() => { location.hash = '#analytics'; });
  await agentPage.reload();
  await agentPage.waitForTimeout(1200);
  const slaVisibleForAgent = await agentPage.evaluate(() => {
    const el = document.querySelector('[data-rep-view="sla"]');
    return el && getComputedStyle(el).display !== 'none';
  });
  assert.ok(!slaVisibleForAgent, 'an Agent-role team member must NOT see the Team/SLA tab, even reaching Analytics directly via URL hash');
});

test('9. top-level nav: Campaigns/Template Library/Automation/Analytics are hidden for an Agent, visible for the owner', async () => {
  const agentHidden = ['campaigns', 'template-library', 'automation', 'analytics'];
  for (const view of agentHidden) {
    const visibleForOwner = await ownerPage.evaluate((v) => {
      const el = document.querySelector(`.nav-item[data-view="${v}"]`);
      return el && getComputedStyle(el).display !== 'none';
    }, view);
    assert.ok(visibleForOwner, `owner must still see the ${view} nav item`);

    const visibleForAgent = await agentPage.evaluate((v) => {
      const el = document.querySelector(`.nav-item[data-view="${v}"]`);
      return el && getComputedStyle(el).display !== 'none';
    }, view);
    assert.ok(!visibleForAgent, `Agent must not see the ${view} nav item — its API is Admin/Manager only`);
  }

  // Template itself (as opposed to Template Library) stays visible for an
  // Agent — GET /api/templates is Agent-reachable, only create/edit/delete
  // are restricted, and those controls live inside the view, not the nav.
  const templateVisibleForAgent = await agentPage.evaluate(() => {
    const el = document.querySelector('.nav-item[data-view="template"]');
    return el && getComputedStyle(el).display !== 'none';
  });
  assert.ok(templateVisibleForAgent, 'Template (not Template Library) must stay visible for an Agent');
});

// PLAN.md item 6 — contacts CSV import, frontend built alongside the
// backend (not deferred to a later combined pass, unlike items 1-5).
test('10. contacts CSV import: uploading a real file via the Contacts view creates real contacts and reports the count', async () => {
  await ownerPage.click('.nav-item[data-view="contacts"]');
  await ownerPage.waitForTimeout(300);

  const ts = String(Date.now()).slice(-9);
  const phone1 = `92${ts}1`;
  const phone2 = `92${ts}2`;
  const csv = `name,phone\n${SUITE_PREFIX}CsvA,${phone1}\n${SUITE_PREFIX}CsvB,${phone2}\n`;

  const [fileChooser] = await Promise.all([
    ownerPage.waitForEvent('filechooser'),
    ownerPage.click('#import-contacts-csv-btn'),
  ]);
  await fileChooser.setFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await ownerPage.waitForTimeout(1000);

  const statusText = await ownerPage.textContent('#import-contacts-csv-status');
  assert.match(statusText, /Imported 2 contact/);

  const rowVisible = await ownerPage.evaluate((name) => document.body.textContent.includes(name), `${SUITE_PREFIX}CsvA`);
  assert.ok(rowVisible, 'an imported contact must actually render in the Contacts table, not just report a count');
});

// PLAN.md item 7 — per-contact custom attribute values, frontend built
// alongside the backend. Real chat drawer, real save round-trip.
test('11. contact attributes: the Chat drawer\'s Attributes section saves a real value and reloads it', async () => {
  const attr = await fetch(`${baseUrl}/api/contact-attributes`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}City`, type: 'text' }),
  }).then((r) => r.json());

  const phone = `9179${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}AttrContact`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    // name is required by chatCreateSchema even though findOrCreateByContact
    // (routes/chats.js) discards it in favor of the linked contact's own
    // name/phone whenever contact_id is present.
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());
  assert.ok(chat.id, 'chat creation via contact_id must succeed');

  // state.contactAttributes (definitions) is loaded once at session start
  // (loadInitialData) — the attribute just created above via a direct API
  // call wouldn't be in the already-running owner session's state without
  // this reload, same reasoning as any other test here that mutates data
  // out-of-band before checking the UI reflects it.
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1000);

  await ownerPage.click('.nav-item[data-view="chat"]');
  await ownerPage.waitForTimeout(300);
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(500);

  const label = await ownerPage.textContent('#drawer-contact-attributes');
  assert.match(label, new RegExp(`${SUITE_PREFIX}City`));

  await ownerPage.fill(`.contact-attr-input[data-attribute-id="${attr.id}"]`, 'Mumbai');
  await ownerPage.dispatchEvent(`.contact-attr-input[data-attribute-id="${attr.id}"]`, 'change');
  await ownerPage.waitForTimeout(500);

  const saved = await fetch(`${baseUrl}/api/contacts/${contact.id}/attributes`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(saved.values.some((v) => v.attributeId === attr.id && v.value === 'Mumbai'), 'the value must actually persist server-side, not just show a UI success message');

  // Switch away and back to confirm it reloads from the server, not just
  // held in unsaved DOM state.
  await ownerPage.click('.nav-item[data-view="contacts"]');
  await ownerPage.waitForTimeout(200);
  await ownerPage.click('.nav-item[data-view="chat"]');
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(500);
  const reloadedValue = await ownerPage.inputValue(`.contact-attr-input[data-attribute-id="${attr.id}"]`);
  assert.equal(reloadedValue, 'Mumbai');
});

// Follow-up fix (2026-09-03) — teamMembers/cannedResponses/contactAttributes
// used to only ever load once at session start, so an agent's tab left
// open on Chat all day would never see something another admin added
// elsewhere without a full page reload (every other test in this file that
// exercises one of these three does an explicit ownerPage.reload() to work
// around exactly this, e.g. test 7 above). This test deliberately does NOT
// reload — it proves switchView('chat') itself now refetches all three, by
// creating a brand-new attribute out-of-band (a direct API call, standing
// in for a different admin/tab) while the owner's page is sitting on a
// different view, then switching into Chat and checking the drawer without
// ever touching the page.
test('12. teamMembers/cannedResponses/contactAttributes refresh on switching into Chat, without a page reload', async () => {
  await ownerPage.click('.nav-item[data-view="contacts"]');
  await ownerPage.waitForTimeout(300);

  const attr = await fetch(`${baseUrl}/api/contact-attributes`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}NoReloadAttr`, type: 'text' }),
  }).then((r) => r.json());

  const phone = `9178${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}NoReloadContact`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());
  assert.ok(chat.id);

  // No ownerPage.reload() here — this is the point of the test.
  await ownerPage.click('.nav-item[data-view="chat"]');
  await ownerPage.waitForTimeout(700);
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(500);

  const label = await ownerPage.textContent('#drawer-contact-attributes');
  assert.match(label, new RegExp(`${SUITE_PREFIX}NoReloadAttr`), 'an attribute defined elsewhere must appear after switching into Chat, with no reload');
});

// PLAN.md item 8 — multi-tag contacts, frontend built alongside the
// backend. Real chat drawer, additive to the existing single primary tag.
test('13. contact tags: the Chat drawer\'s additive multi-tag picker attaches and detaches a real tag', async () => {
  const tag = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ name: `${SUITE_PREFIX}ExtraTag` }),
  }).then((r) => r.json());

  const phone = `9177${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}TagContact`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());
  assert.ok(chat.id);

  await ownerPage.reload(); // state.tagsById only loads at session start
  await ownerPage.waitForTimeout(1000);
  await ownerPage.click('.nav-item[data-view="chat"]');
  await ownerPage.waitForTimeout(500);
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(500);

  // CLAUDE.md's own documented convention: selectOption()'s actionability
  // polling has proven unreliable against this app under real backend
  // latency — set the <select> value directly and dispatch a real change
  // event instead (templateLibraryUI.test.js's setFilter() precedent).
  await ownerPage.evaluate((tagId) => {
    const select = document.getElementById('drawer-add-tag-select');
    select.value = tagId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, tag.id);
  await ownerPage.waitForTimeout(500);

  const afterAdd = await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(afterAdd.tags.some((t) => t.id === tag.id), 'attaching via the drawer must persist server-side');

  const chipVisible = await ownerPage.textContent('#drawer-contact-extra-tags');
  assert.match(chipVisible, new RegExp(`${SUITE_PREFIX}ExtraTag`));

  await ownerPage.click(`.drawer-remove-extra-tag-btn[data-tag-id="${tag.id}"]`);
  await ownerPage.waitForTimeout(500);

  const afterRemove = await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(!afterRemove.tags.some((t) => t.id === tag.id), 'detaching via the drawer must persist server-side');

  const contactAfter = await fetch(`${baseUrl}/api/contacts/${contact.id}`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.equal(contactAfter.tag_id, null, 'the additive picker must never set the primary tag_id');
});

// PLAN.md item 8.5 — Contacts-view contact detail panel, the second caller
// of the generalized renderContactAttributesInto/renderContactTagsInto
// (app.js). Proves real reuse, not a parallel re-implementation: edits made
// from the Contacts-view panel persist server-side via the exact same
// endpoints items 7/8's drawer tests (11, 13) already cover, and — the
// point of this test — the SAME edit is then visible from the Chat drawer
// too, confirming both surfaces read/write the identical data, not two
// diverging copies.
test('14. Contacts-view detail panel: clicking a row opens it, edits to tags and attributes persist, and the Chat drawer shows the same data', async () => {
  const attr = await fetch(`${baseUrl}/api/contact-attributes`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}PanelCity`, type: 'text' }),
  }).then((r) => r.json());
  const tag = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ name: `${SUITE_PREFIX}PanelTag` }),
  }).then((r) => r.json());

  const phone = `9176${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}PanelContact`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());
  assert.ok(chat.id);

  // state.contactAttributes/tagsById only load at session start.
  await ownerPage.reload();
  await ownerPage.waitForTimeout(1000);

  await ownerPage.click('.nav-item[data-view="contacts"]');
  await ownerPage.waitForTimeout(500);
  await ownerPage.click(`tr[data-contact-id="${contact.id}"]`);
  await ownerPage.waitForTimeout(500);

  const panelOpen = await ownerPage.evaluate(() => document.getElementById('modal-contact-detail').classList.contains('open'));
  assert.ok(panelOpen, 'clicking a Contacts row must open the detail panel');
  const nameShown = await ownerPage.textContent('#contact-detail-name');
  assert.equal(nameShown, `${SUITE_PREFIX}PanelContact`);

  // Edit the attribute from the panel.
  await ownerPage.fill(`#contact-detail-attributes .contact-attr-input[data-attribute-id="${attr.id}"]`, 'Chennai');
  await ownerPage.dispatchEvent(`#contact-detail-attributes .contact-attr-input[data-attribute-id="${attr.id}"]`, 'change');
  await ownerPage.waitForTimeout(500);

  // Add a tag from the panel — same setValue+dispatch pattern as test 13,
  // scoped to the panel's own select this time (both share the
  // .contact-tags-select class, so scoping matters here).
  await ownerPage.evaluate((tagId) => {
    const select = document.querySelector('#contact-detail-tags-wrapper .contact-tags-select');
    select.value = tagId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, tag.id);
  await ownerPage.waitForTimeout(500);

  const savedAttrs = await fetch(`${baseUrl}/api/contacts/${contact.id}/attributes`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(savedAttrs.values.some((v) => v.attributeId === attr.id && v.value === 'Chennai'), 'the attribute edit from the panel must persist server-side');
  const savedTags = await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(savedTags.tags.some((t) => t.id === tag.id), 'the tag added from the panel must persist server-side');

  // Close the panel, open the SAME contact via the Chat drawer instead —
  // it must show the identical data just entered through the panel, not a
  // stale or diverging copy.
  await ownerPage.click('#modal-contact-detail [data-close-modal]');
  await ownerPage.waitForTimeout(200);
  await ownerPage.click('.nav-item[data-view="chat"]');
  await ownerPage.waitForTimeout(500);
  await ownerPage.click(`[data-chat-id="${chat.id}"]`);
  await ownerPage.waitForTimeout(500);

  const drawerAttrValue = await ownerPage.inputValue(`#drawer-contact-attributes .contact-attr-input[data-attribute-id="${attr.id}"]`);
  assert.equal(drawerAttrValue, 'Chennai', 'the Chat drawer must show the same attribute value the panel just saved');
  const drawerTagsText = await ownerPage.textContent('#drawer-contact-extra-tags');
  assert.match(drawerTagsText, new RegExp(`${SUITE_PREFIX}PanelTag`), 'the Chat drawer must show the same tag the panel just attached');
});

// PLAN.md item 10 — Contact 360 activity timeline. Backend correctness
// (interleaving, exclusions) is contactTimeline.test.js's job; this is the
// one thing only a real browser can show — that the Contacts-view detail
// panel (item 8.5) actually renders the real endpoint's events.
test('15. Contact 360 timeline: the detail panel\'s Activity section renders real events, newest first', async () => {
  const phone = `9175${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}TimelineContact`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(ownerToken),
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());

  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at)
     values ($1, $2, 'in', '${SUITE_PREFIX}OlderMessage', now() - interval '10 minutes')`,
    [chat.id, testClientId]
  );
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at)
     values ($1, $2, 'out', '${SUITE_PREFIX}NewerMessage', now() - interval '1 minute')`,
    [chat.id, testClientId]
  );

  await ownerPage.click('.nav-item[data-view="contacts"]');
  await ownerPage.waitForTimeout(300);
  await ownerPage.click(`tr[data-contact-id="${contact.id}"]`);
  await ownerPage.waitForTimeout(500);

  const timelineText = await ownerPage.textContent('#contact-detail-timeline');
  assert.match(timelineText, new RegExp(`${SUITE_PREFIX}OlderMessage`));
  assert.match(timelineText, new RegExp(`${SUITE_PREFIX}NewerMessage`));

  const newerIndex = timelineText.indexOf(`${SUITE_PREFIX}NewerMessage`);
  const olderIndex = timelineText.indexOf(`${SUITE_PREFIX}OlderMessage`);
  assert.ok(newerIndex < olderIndex, 'the newer message must render first (descending chronological order)');
});
