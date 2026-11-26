// Reads the sound-effect cues the timeline itself declares (window.CUES), so sound
// lands on the exact frame the picture moves, then synthesizes and places each one
// into a single audio/sfx_track.wav. Also saves sfx-cues.json for reference.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { writeWav, rng } = require('./wav');

const ROOT = path.join(__dirname, '..');
const SR = 44100, TAU = Math.PI * 2;
const rand = rng(11);
const len = (s) => Math.floor(s * SR);
const noise = () => rand() * 2 - 1;

const SOUNDS = {
  click: () => { const o = new Float32Array(len(0.05)); let lp = 0; for (let k = 0; k < o.length; k++) { const t = k / SR; lp += (noise() - lp) * 0.5; o[k] = (lp * 0.5 + Math.sin(TAU * 1900 * t) * 0.5) * Math.exp(-t * 110) * 0.5; } return o; },
  tick: () => { const o = new Float32Array(len(0.08)); for (let k = 0; k < o.length; k++) { const t = k / SR; o[k] = Math.sin(TAU * 1760 * t) * Math.exp(-t * 55) * 0.28; } return o; },
  pop: () => { const o = new Float32Array(len(0.12)); let ph = 0; for (let k = 0; k < o.length; k++) { const t = k / SR; ph += TAU * (520 + 700 * Math.min(1, t / 0.05)) / SR; o[k] = Math.sin(ph) * Math.exp(-t * 32) * 0.32; } return o; },
  swish: () => { const d = 0.38, o = new Float32Array(len(d)); let lp = 0; for (let k = 0; k < o.length; k++) { const p = k / o.length; lp += (noise() - lp) * (0.05 + 0.3 * Math.sin(Math.PI * p)); o[k] = lp * Math.sin(Math.PI * p) ** 2 * 0.5; } return o; },
  send: () => { const d = 0.25, o = new Float32Array(len(d)); let lp = 0, ph = 0; for (let k = 0; k < o.length; k++) { const p = k / o.length; lp += (noise() - lp) * (0.1 + 0.4 * p); ph += TAU * (600 + 900 * p) / SR; o[k] = (lp * 0.4 + Math.sin(ph) * 0.12) * Math.sin(Math.PI * p) * 0.6; } return o; },
  riser: () => { const d = 0.5, o = new Float32Array(len(d)); let lp = 0; for (let k = 0; k < o.length; k++) { const p = k / o.length; lp += (noise() - lp) * (0.03 + 0.4 * p); o[k] = lp * p * p * 0.5; } return o; },
  impact: () => { const o = new Float32Array(len(1.6)); let ph = 0, lp = 0; for (let k = 0; k < o.length; k++) { const t = k / SR; ph += TAU * (38 + 50 * Math.exp(-t * 12)) / SR; lp += (noise() - lp) * 0.04; o[k] = (Math.sin(ph) * 0.8 * Math.exp(-t * 2.6) + lp * 0.6 * Math.exp(-t * 5)) * 0.6; } return o; },
  chime: () => { const o = new Float32Array(len(2.2)); const fs_ = [1174.7, 1480, 1760, 2349]; for (let k = 0; k < o.length; k++) { const t = k / SR; let v = 0; fs_.forEach((f, i) => { const tt = t - i * 0.07; if (tt > 0) v += Math.sin(TAU * f * tt) * Math.exp(-tt * (2.2 + i)) * (1 - i * 0.15); }); o[k] = v * 0.1; } return o; },
  success: () => { const o = new Float32Array(len(0.7)); for (let k = 0; k < o.length; k++) { const t = k / SR; let v = Math.sin(TAU * 880 * t) * Math.exp(-t * 9); if (t > 0.09) v += Math.sin(TAU * 1318.5 * (t - 0.09)) * Math.exp(-(t - 0.09) * 7); o[k] = v * 0.16; } return o; },
  error: () => { const o = new Float32Array(len(0.32)); for (let k = 0; k < o.length; k++) { const t = k / SR; const f = t < 0.14 ? 330 : 262; const tt = t < 0.14 ? t : t - 0.14; o[k] = (Math.asin(Math.sin(TAU * f * t)) / 1.57) * Math.exp(-tt * 18) * 0.16; } return o; },
  low: () => { const o = new Float32Array(len(1.4)); let ph = 0; for (let k = 0; k < o.length; k++) { const t = k / SR; ph += TAU * (98 - 24 * Math.min(1, t)) / SR; o[k] = Math.sin(ph) * Math.min(1, t / 0.05) * Math.exp(-t * 2) * 0.35; } return o; },
};
function typing(dur) {
  const o = new Float32Array(len(dur + 0.1));
  for (let t = 0; t < dur; t += 0.045 + rand() * 0.06) {
    const i0 = len(t), f = 2200 + rand() * 1400, a = 0.08 + rand() * 0.06;
    for (let k = 0; k < len(0.02) && i0 + k < o.length; k++) o[i0 + k] += (noise() * 0.6 + Math.sin(TAU * f * k / SR) * 0.4) * Math.exp(-(k / SR) * 300) * a;
  }
  return o;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(ROOT, 'scenes', 'film.html').replace(/\\/g, '/'));
  await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });
  const cues = await page.evaluate('window.CUES');
  const DUR = await page.evaluate('window.__FILM_DURATION__');
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'sfx-cues.json'), JSON.stringify(cues, null, 1));

  const N = Math.ceil(DUR * SR), L = new Float32Array(N), R = new Float32Array(N);
  const cache = {};
  // With a recorded score, only small UI sounds stay: no whooshes, typing or chimes over the music.
  const KEEP = new Set(['click', 'tick', 'pop', 'send', 'success', 'error']);
  for (const c of cues.filter((x) => KEEP.has(x.s))) {
    const snd = c.s === 'typing' ? typing(c.dur) : (cache[c.s] ||= SOUNDS[c.s] && SOUNDS[c.s]());
    if (!snd) throw new Error('unknown sfx ' + c.s);
    const g = c.gain ?? 1, i0 = Math.floor(c.t * SR);
    for (let k = 0; k < snd.length && i0 + k < N; k++) if (i0 + k >= 0) { L[i0 + k] += snd[k] * g; R[i0 + k] += snd[k] * g; }
  }
  writeWav(path.join(ROOT, 'audio', 'sfx_track.wav'), L, R, SR);
  console.log(`Placed ${cues.length} sound cues -> audio/sfx_track.wav`);
})().catch((e) => { console.error(e); process.exit(1); });
