// Screenshot chosen instants for review: node scripts/stills.js <outDir> t1 t2 ...
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const [out, ...ts] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('file://' + path.join(__dirname, '..', 'scenes', 'film.html').split(path.sep).join('/'));
  await page.waitForFunction('window.__ready === true || window.__error', null, { timeout: 30000 });
  const err = await page.evaluate('window.__error');
  if (err) { console.error(err); process.exit(1); }
  for (const t of ts) {
    await page.evaluate((x) => window.__seek(x), +t);
    await page.screenshot({ path: path.join(out, `t_${String(t).padStart(5, '0')}.png`) });
  }
  if (errs.length) console.error('console errors:', errs.slice(0, 5));
  await browser.close();
  console.log('ok', ts.length);
})();
