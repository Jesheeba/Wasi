// Screenshot chosen instants for review:  node scripts/stills.js <outDir> 3.2 10 21.5 ...
// With no times, takes one frame 60% into every scene. Also fails on any page error.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const outDir = process.argv[2];
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.join(__dirname, '..', 'scenes', 'film.html').replace(/\\/g, '/'));
  await page.waitForFunction('window.__ready === true', null, { timeout: 30000 }).catch(() => {});
  if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); }
  let times = process.argv.slice(3).map(Number);
  if (!times.length) {
    const S = await page.evaluate('window.TIMING.scenes');
    times = Object.values(S).map((s) => +(s.start + (s.end - s.start) * 0.6).toFixed(2));
  }
  for (const t of times) {
    await page.evaluate((tt) => window.__seek(tt), t);
    const f = path.join(outDir, `t${String(t.toFixed(2)).padStart(6, '0')}.png`);
    await page.screenshot({ path: f });
    console.log(f);
  }
  await browser.close();
  if (errors.length) process.exit(1);
})();
