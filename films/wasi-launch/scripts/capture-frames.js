// Deterministic seek-and-screenshot capture at 1920x1080, 30 fps, split across
// parallel pages for speed. Every frame is a pure function of its timestamp.
//   node scripts/capture-frames.js [--workers=4]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const FPS = 30;
const ROOT = path.join(__dirname, '..');
const FRAMES = path.join(ROOT, 'frames');

(async () => {
  const W = parseInt((process.argv.find((a) => a.startsWith('--workers=')) || '--workers=4').split('=')[1], 10);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch();
  const url = 'file://' + path.join(ROOT, 'scenes', 'film.html').replace(/\\/g, '/');
  const probe = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await probe.goto(url);
  await probe.waitForFunction('window.__ready === true', null, { timeout: 30000 });
  const total = Math.round((await probe.evaluate('window.__FILM_DURATION__')) * FPS);
  await probe.close();

  const t0 = Date.now();
  let done = 0;
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(url);
    await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });
    for (let i = w; i < total; i += W) {
      await page.evaluate((t) => window.__seek(t), i / FPS);
      await page.screenshot({ path: path.join(FRAMES, `f_${String(i).padStart(5, '0')}.png`) });
      if (++done % 300 === 0) console.log(`  ${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await page.close();
  }));
  await browser.close();
  console.log(`Captured ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
