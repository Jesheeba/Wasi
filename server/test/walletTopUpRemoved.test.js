// Wallet top-ups were removed on 2026-11-23: message costs can't be metered
// per client, so a prepaid balance had nothing to pay for (and an in-app
// Razorpay top-up was a Play Store payments-policy risk for the Android app).
// Static checks only - no DB needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('client app has no Wallet nav item, page, or recharge modal', () => {
  const html = read('index.html');
  for (const id of ['data-sec-view="wallet"', 'sec-view-wallet', 'modal-recharge-wallet', 'wallet-quick-recharge', 'open-recharge-modal']) {
    assert.ok(!html.includes(id), `index.html still contains ${id}`);
  }
});

test('client app never calls the recharge endpoint', () => {
  const js = read('app.js');
  assert.ok(!js.includes('/api/wallet'), 'app.js still calls /api/wallet');
  assert.ok(!js.includes('renderWallet'), 'app.js still has renderWallet');
});

test('server no longer offers POST /api/wallet/recharge', () => {
  const router = require('../src/routes/wallet');
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  assert.deepStrictEqual(routes, ['get /']);
});
