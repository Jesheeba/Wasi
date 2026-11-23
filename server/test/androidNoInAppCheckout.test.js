// Google Play's payments policy: the Android app (mobile/) must not sell the
// subscription in-app or link out to pay. The app tags its WebView user agent
// with "WasiAndroidApp" (capacitor.config.json) and the CRM hides every
// checkout entry point when it sees it. Static checks only - no DB needed.
// Browser-verified on 2026-11-23: with the tag, html.in-android-app is set,
// the Subscription nav item and the suspended screen's Pay button are hidden;
// without it, both are shown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('Android app tags its user agent', () => {
  const cfg = JSON.parse(read('mobile/capacitor.config.json'));
  assert.equal(cfg.android.appendUserAgent, 'WasiAndroidApp');
});

test('app.js detects the Android app and marks <html>', () => {
  const js = read('app.js');
  assert.match(js, /const IS_ANDROID_APP = \/WasiAndroidApp\/\.test\(navigator\.userAgent\)/);
  assert.match(js, /classList\.add\('in-android-app'\)/);
  assert.ok(!/[\x00-\x08]/.test(js), 'app.js contains a control character');
});

test('plan picker refuses to open in the Android app', () => {
  const js = read('app.js');
  assert.match(js, /function openChoosePlanModal\(plans, currentPlanId\) \{\r?\n\s+if \(IS_ANDROID_APP\) return;/);
});

test('CSS hides every checkout entry point in the Android app', () => {
  const css = read('index.css');
  for (const sel of ['[data-sec-view="subscription"]', '#sec-view-subscription', '#modal-choose-plan', '#suspended-view-pay-btn']) {
    assert.ok(css.includes(`.in-android-app ${sel}`), `index.css does not hide ${sel}`);
  }
});
