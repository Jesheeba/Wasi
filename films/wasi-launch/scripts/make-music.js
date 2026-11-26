// Original score, synthesized deterministically (no sample library on this machine).
// D major, 96 BPM, arranged against timing.json so the music follows the story:
//   problem  - sparse minor pads (Bm/G) + a clock tick that keeps pace with the unread pile-up
//   turn     - drop to near silence, rising swell into "Meet Wasi", warm D major + bell sparkle
//   product  - pad + Karplus-Strong pluck arpeggio + bass + soft kick/hats, bar grid locked to s03
//   recap    - lift: second arpeggio an octave up, four-on-the-floor
//   close    - full D major resolve, bell motif on the tagline, rings out to black
const path = require('path');
const { writeWav, rng } = require('./wav');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'timing.json'));
const VO = Object.fromEntries(T.schedule.map((s) => [s.id, s]));
const S = T.scenes;
const SR = 44100, DUR = T.FILM_DURATION, N = Math.ceil(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N), SEND = new Float32Array(N);
const rand = rng(7);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

function put(i, v, pan, send) {
  if (i < 0 || i >= N) return;
  L[i] += v * Math.cos((pan + 1) * Math.PI / 4);
  R[i] += v * Math.sin((pan + 1) * Math.PI / 4);
  SEND[i] += v * send;
}

// warm pad: few soft harmonics, two slightly detuned voices spread L/R
function pad(t0, dur, midi, amp, atk = 0.6, rel = 1.2) {
  const f = mtof(midi), i0 = Math.floor(t0 * SR), len = Math.floor((dur + rel) * SR);
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const env = Math.min(1, t / atk) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
    if (env <= 0) continue;
    let a = 0, b = 0;
    for (let h = 1; h <= 4; h++) {
      const w = 1 / Math.pow(h, 1.7);
      a += w * Math.sin(TAU * f * h * 1.0015 * t);
      b += w * Math.sin(TAU * f * h * 0.9985 * t + h);
    }
    const v = env * amp;
    const i = i0 + k;
    if (i >= N) break;
    if (i >= 0) { L[i] += a * v; R[i] += b * v; SEND[i] += (a + b) * v * 0.35; }
  }
}
const chord = (t0, dur, notes, amp, atk, rel) => notes.forEach((m) => pad(t0, dur, m, amp, atk, rel));

// Karplus-Strong pluck (harp/guitar-like)
function pluck(t0, midi, amp, pan = 0, decay = 0.996, len = 1.4) {
  const p = Math.max(2, Math.round(SR / mtof(midi)));
  const line = new Float32Array(p);
  for (let k = 0; k < p; k++) line[k] = rand() * 2 - 1;
  const i0 = Math.floor(t0 * SR);
  let idx = 0;
  for (let k = 0; k < len * SR; k++) {
    const nx = (idx + 1) % p;
    const out = line[idx];
    line[idx] = 0.5 * (line[idx] + line[nx]) * decay;
    idx = nx;
    put(i0 + k, out * amp * Math.min(1, k / 40), pan, 0.5);
  }
}

function kick(t0, amp) {
  let ph = 0; const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < 0.4 * SR; k++) {
    const t = k / SR; ph += TAU * (42 + 90 * Math.exp(-t * 28)) / SR;
    put(i0 + k, Math.sin(ph) * Math.exp(-t * 8) * amp, 0, 0.05);
  }
}
function hat(t0, amp, pan = 0.25) {
  const i0 = Math.floor(t0 * SR); let prev = 0;
  for (let k = 0; k < 0.06 * SR; k++) {
    const x = rand() * 2 - 1, hp = x - prev; prev = x;
    put(i0 + k, hp * Math.exp(-k / SR * 70) * amp, pan, 0.1);
  }
}
function bass(t0, dur, midi, amp) {
  const f = mtof(midi), i0 = Math.floor(t0 * SR);
  for (let k = 0; k < (dur + 0.15) * SR; k++) {
    const t = k / SR;
    const env = Math.min(1, t / 0.01) * (0.55 + 0.45 * Math.exp(-t * 6)) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.15) : 1);
    put(i0 + k, (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t)) * env * amp, 0, 0);
  }
}
function tick(t0, amp) {
  const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < 0.03 * SR; k++) put(i0 + k, Math.sin(TAU * 2600 * k / SR) * Math.exp(-k / SR * 160) * amp, 0.4, 0.2);
}
function swell(t0, dur, amp) { // noise + rising tone into the reveal
  const i0 = Math.floor(t0 * SR); let lp = 0, ph = 0;
  for (let k = 0; k < dur * SR; k++) {
    const p = k / (dur * SR), x = rand() * 2 - 1;
    lp += (x - lp) * (0.02 + 0.25 * p);
    ph += TAU * (180 + 900 * p * p) / SR;
    put(i0 + k, (lp * 0.9 + Math.sin(ph) * 0.25) * Math.pow(p, 2.2) * amp, 0, 0.6);
  }
}

// ----- chords (MIDI) -----
const C = {
  D: { pad: [50, 54, 57, 62], arp: [62, 66, 69, 74], root: 38 },
  A: { pad: [45, 52, 57, 61], arp: [61, 64, 69, 73], root: 33 },
  Bm: { pad: [47, 50, 54, 59], arp: [59, 62, 66, 71], root: 35 },
  G: { pad: [43, 50, 55, 59], arp: [59, 62, 67, 71], root: 31 },
};
const BEAT = 60 / 96, BAR = BEAT * 4;
const meet = VO.vo03.words.find((w) => /^Meet/i.test(w.w)).s;

// problem: sparse minor pads + clock
{
  const end = meet - 1.7;
  const prog = ['Bm', 'G', 'Bm', 'A'];
  for (let t = 0, b = 0; t < end; t += BAR, b++) {
    const d = Math.min(BAR, end - t);
    chord(t, d, C[prog[b % 4]].pad.map((m) => m - 12), 0.03 + Math.min(0.012, t * 0.001), 1.2, 1.6);
  }
  for (let t = 1.0; t < end - 0.3; t += BEAT) tick(t, 0.05 + 0.08 * (t / end));
}
// turn
swell(meet - 1.5, 1.5, 0.35);
chord(meet, S.s03.start - meet + 0.4, [38, 50, 54, 57, 62, 66], 0.05, 0.08, 1.6);
[74, 78, 81, 86].forEach((m, i) => pluck(meet + 0.15 + i * 0.12, m, 0.22, i % 2 ? 0.4 : -0.4, 0.998, 2.2));

// product groove
{
  const g0 = S.s03.start - 0.25, gEnd = S.s10.start - 0.1, lift = S.s09.start - 0.2;
  const prog = ['D', 'A', 'Bm', 'G'];
  const pat = [0, 1, 2, 3, 2, 1, 2, 3];
  for (let bar = 0; g0 + bar * BAR < gEnd; bar++) {
    const t0 = g0 + bar * BAR, ch = C[prog[bar % 4]], lifted = t0 >= lift;
    chord(t0, Math.min(BAR, gEnd - t0), ch.pad, 0.026, 0.35, 0.9);
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * BEAT / 2;
      if (t >= gEnd) break;
      pluck(t, ch.arp[pat[e]], 0.15, e % 2 ? 0.3 : -0.3);
      if (lifted) pluck(t + 0.01, ch.arp[pat[(e + 2) % 8]] + 12, 0.08, e % 2 ? -0.4 : 0.4);
      if (e % 2 === 1) hat(t, 0.05);
    }
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      if (t >= gEnd) break;
      if (b % 2 === 0 || lifted) kick(t, lifted ? 0.42 : 0.34);
      if (b % 2 === 0) bass(t, BEAT * 1.4, ch.root + 12, 0.16);
    }
  }
}
// close
{
  const c0 = S.s10.start - 0.1, hold = DUR - c0 - 1.4;
  chord(c0, hold, [38, 50, 54, 57, 62, 66, 69], 0.04, 0.9, 1.3);
  bass(c0, hold, 38, 0.12);
  const v = VO.vo13.start;
  [81, 86, 90, 93].forEach((m, i) => pluck(v + 0.1 + i * 0.16, m, 0.2, i % 2 ? 0.35 : -0.35, 0.998, 2.4));
  [74, 78, 81].forEach((m, i) => pluck(VO.vo14.start + 0.4 + i * 0.22, m, 0.12, 0, 0.998, 2.4));
}

// Schroeder reverb on the send bus
function reverb(input, combs, aps) {
  const out = new Float32Array(N);
  combs.forEach((d) => {
    const buf = new Float32Array(d); let i = 0, lp = 0;
    for (let n = 0; n < N; n++) {
      const y = buf[i]; lp = y * 0.75 + lp * 0.25;
      buf[i] = input[n] + lp * 0.82; i = (i + 1) % d; out[n] += y * 0.25;
    }
  });
  aps.forEach((d) => {
    const buf = new Float32Array(d); let i = 0;
    for (let n = 0; n < N; n++) { const b = buf[i], x = out[n]; const y = -x * 0.5 + b; buf[i] = x + b * 0.5; out[n] = y; i = (i + 1) % d; }
  });
  return out;
}
const wl = reverb(SEND, [1557, 1617, 1491, 1422], [225, 556]);
const wr = reverb(SEND, [1580, 1640, 1514, 1445], [248, 579]);
for (let n = 0; n < N; n++) { L[n] += wl[n] * 0.45; R[n] += wr[n] * 0.45; }
// final fade
for (let n = Math.floor((DUR - 1.2) * SR); n < N; n++) { const g = Math.max(0, (N - n) / (1.2 * SR)); L[n] *= g; R[n] *= g; }

writeWav(path.join(ROOT, 'audio', 'music.wav'), L, R, SR);
console.log('Wrote audio/music.wav');
