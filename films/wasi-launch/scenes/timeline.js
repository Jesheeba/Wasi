// Master GSAP timeline - paused, driven only by window.__seek(t), so every frame is
// deterministic. Every beat is keyed to a VO line (rel(id, fraction)), so new VO
// durations re-time the whole film on their own. Anything that changes text
// (typing, counters, classes) is a pure function of t in DER[], never a callback.
// window.CUES lists every sound-effect instant for assemble-audio.js.
window.addEventListener('load', () => document.fonts.ready.then(function () {
  const T = window.TIMING, VO = window.VO_BY_ID, S = T.scenes, DUR = T.FILM_DURATION;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const prog = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1));
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const rel = (id, f) => VO[id].start + VO[id].dur * f;
  // start of phrase k in a line (k-th detected pause end); falls back to a fraction while VO is estimated
  const ph = (id, k, fb) => (k === 0 ? VO[id].start : (VO[id].pauses && VO[id].pauses[k - 1] ? VO[id].start + VO[id].pauses[k - 1][1] : rel(id, fb)));
  const fmt = (n) => Math.round(n).toLocaleString('en-IN');
  const master = gsap.timeline({ paused: true });
  const DER = [];
  const CUES = [];
  const cue = (t, s, extra = {}) => CUES.push(Object.assign({ t: +t.toFixed(3), s }, extra));
  const tw = (sel, from, to, pos) => master.fromTo(sel, from, Object.assign({ immediateRender: false }, to), pos);

  // ---------------- icons (Lucide paths, stroke 1.75 per the design system) ----------------
  const ICONS = {
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'check-check': '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'bar-chart': '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  };
  $$('[data-icon]').forEach((el) => {
    const p = ICONS[el.dataset.icon];
    if (!p) throw new Error('missing icon ' + el.dataset.icon);
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  });

  // ---------------- s01 chat rows (built before measuring layout) ----------------
  const CHATS = [
    ['AR', 'Ananya R', 'Is the blue kurta still in stock?', '8:41 pm', 1],
    ['KS', 'Karthik S', 'What are the fees for the weekend batch?', '8:52 pm', 2],
    ['RV', 'Rahul V', 'Can I book Saturday at 11?', '9:06 pm', 1],
    ['FN', 'Fathima N', "Order #4821 hasn't arrived yet", '9:20 pm', 2],
    ['VS', 'Vignesh S', 'Do you deliver to Coimbatore?', '9:34 pm', 1],
    ['SM', 'Sneha M', 'Price for the 2 kg pack?', '10:02 pm', 2],
    ['AP', 'Arjun P', 'Is the offer still on?', '10:15 pm', 1],
    ['LK', 'Lakshmi K', 'Hello? Anyone there?', '10:48 pm', 3],
    ['JM', 'Joseph M', 'Can you share the catalogue?', '11:09 pm', 2],
    ['DK', 'Divya K', 'I need it before Friday', '11:42 pm', 1],
  ];
  $('#chatlist').innerHTML = CHATS.map((c, i) =>
    `<div class="crow" id="cr${i}"><div class="avatar-initials">${c[0]}</div><div class="m"><div class="n">${c[1]}<span>${c[3]}</span></div><div class="p"><em>${c[2]}</em><span class="cnt" id="cc${i}">${c[4]}</span></div></div></div>`).join('');

  // centred elements: centring lives in GSAP's percent channel so tweened x/y/scale never fight it
  gsap.set('.lockup', { xPercent: -50, yPercent: -50 });
  gsap.set('.hook-line, .reveal-pre, .one-place', { yPercent: -50 });
  gsap.set('.meta-modal', { xPercent: -50, yPercent: -50, scale: 0.96 });

  // ---------------- measuring helper: element centre in its .win's own (unzoomed) px ----------------
  function P(sel, ax = 0.5, ay = 0.5) {
    const el = $(sel), win = el.closest('.win');
    const wr = win.getBoundingClientRect(), r = el.getBoundingClientRect();
    const k = wr.width / win.offsetWidth;
    return { x: (r.left - wr.left) / k + (r.width / k) * ax, y: (r.top - wr.top) / k + (r.height / k) * ay };
  }

  // ---------------- scene visibility: overlapping crossfades ----------------
  const ids = Object.keys(S);
  ids.forEach((id, i) => {
    const el = $('#' + id);
    el.style.zIndex = String(i + 1);
    const inAt = i === 0 ? 0 : S[id].start - 0.25;
    master.set(el, { visibility: 'visible' }, inAt);
    tw(el, { opacity: 0 }, { opacity: 1, duration: i === 0 ? 0.6 : 0.45, ease: 'power1.inOut' }, inAt);
    const next = ids[i + 1];
    if (next) master.set(el, { visibility: 'hidden' }, S[next].start + 0.25);
  });

  function copyIn(id, t0) {
    const s = '#' + id + ' .copy';
    tw(s + ' .kicker', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, t0);
    tw(s + ' .headline .w', { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.07 }, t0 + 0.12);
    tw(s + ' .sub', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, t0 + 0.5);
    if ($(s + ' .proof')) tw(s + ' .proof', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, t0 + 0.8);
  }
  function camIn(id) {
    const { start, end } = S[id];
    const cam = '#cam' + id.slice(1);
    tw(cam, { opacity: 0, x: 90 }, { opacity: 1, x: 0, duration: 0.85, ease: 'power3.out' }, start - 0.2);
    tw(cam, { scale: 0.985 }, { scale: 1.025, duration: end - start + 0.45, ease: 'none' }, start - 0.2);
    cue(start - 0.2, 'swish', { gain: 0.5 });
  }
  function focus(sel, origin, scale, at, dur = 0.9) {
    master.set(sel, { transformOrigin: origin }, at);
    tw(sel, { scale: 1 }, { scale, duration: dur, ease: 'power2.inOut' }, at);
  }
  function punch(sel, at, s = 1.08) {
    tw(sel, { scale: 1 }, { scale: s, duration: 0.14, ease: 'power2.out', yoyo: true, repeat: 1 }, at);
  }
  // pts: [{t, at:{x,y}, click}] - cursor arrives at each point at time t
  function cursor(n, pts, hideAt) {
    const c = '#cur' + n, r = '#rip' + n;
    const p0 = pts[0];
    master.set(c, { x: p0.at.x - 4, y: p0.at.y - 3 }, p0.t - 0.3);
    tw(c, { opacity: 0 }, { opacity: 1, duration: 0.25 }, p0.t - 0.3);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = Math.min(0.65, b.t - a.t - 0.02);
      tw(c, { x: a.at.x - 4, y: a.at.y - 3 }, { x: b.at.x - 4, y: b.at.y - 3, duration: d, ease: 'power2.inOut' }, b.t - d);
    }
    pts.filter((p) => p.click).forEach((p) => {
      master.set(r, { x: p.at.x, y: p.at.y }, p.t);
      tw(r, { opacity: 0.9, scale: 0.4 }, { opacity: 0, scale: 1.6, duration: 0.45, ease: 'power2.out' }, p.t);
      tw(c, { scale: 1 }, { scale: 0.82, duration: 0.08, yoyo: true, repeat: 1 }, p.t);
      cue(p.t, 'click');
    });
    if (hideAt) tw(c, { opacity: 1 }, { opacity: 0, duration: 0.25 }, hideAt);
  }
  const show = (sel, at, opts = {}) => tw(sel, { opacity: 0, y: opts.y ?? 8, scale: opts.s ?? 1 }, { opacity: 1, y: 0, scale: 1, duration: opts.d ?? 0.35, ease: 'power2.out' }, at);
  const hide = (sel, at, d = 0.25) => tw(sel, { opacity: 1 }, { opacity: 0, duration: d }, at);
  const swap = (offSel, onSel, at) => { hide(offSel, at, 0.18); show(onSel, at + 0.05, { y: 0, s: 0.9, d: 0.3 }); };

  // pre-measure every cursor target while nothing is transformed yet
  const POS = {
    connect: P('#s03-btn'),
    assign: P('#assign-btn'), priya: P('#mi-priya', 0.35), send: P('#send'), comp: P('#comp', 0.3),
    launch: P('#launch'), chFail: P('#ch-fail'),
    tpBody: P('#tp-body', 0.6, 0.3), submit: P('#tp-submit'),
  };

  // ======================= s01 · hook + problem =======================
  {
    const s = S.s01;
    tw('#s01-glow', { opacity: 0 }, { opacity: 0.7, duration: 1.4 }, 0);
    tw('#phone', { opacity: 0, x: 140 }, { opacity: 1, x: 0, duration: 1.1, ease: 'power3.out' }, 0.1);
    tw('#phone', { scale: 1 }, { scale: 1.045, duration: s.end - s.start, ease: 'none' }, 0);
    show('#hook-meta', 0.45, { y: 12, d: 0.6 });
    tw('#h1 .w', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.1 }, VO.vo01.start);

    const ROW = 80;
    const appear = [];
    for (let i = 0; i < 5; i++) appear.push(rel('vo01', 0.06 + i * 0.2));
    const b0 = VO.vo02.start + 0.05, b1 = rel('vo02', 0.55);
    for (let j = 0; j < 5; j++) appear.push(b0 + ((b1 - b0) * j) / 4);
    const dimT = ph('vo02', 2, 0.62) - 0.1;
    appear.forEach((ti, i) => {
      tw('#cr' + i, { opacity: 0, y: -ROW }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' }, ti);
      for (let j = 0; j < i; j++) tw('#cr' + j, { y: (i - 1 - j) * ROW }, { y: (i - j) * ROW, duration: 0.35, ease: 'power2.out' }, ti);
      cue(ti, 'pop', { gain: i < 5 ? 0.8 : 0.55 });
    });
    // unanswered chats keep piling up: each row's count climbs until the dim beat
    const counts = (t) => CHATS.map((c, i) => (t < appear[i] ? 0 : c[4] + Math.max(0, Math.floor((Math.min(t, dimT) - appear[i]) / 1.3))));
    DER.push((t) => {
      if (t > s.end + 0.5) return;
      const c = counts(t);
      c.forEach((v, i) => { $('#cc' + i).textContent = String(Math.max(1, v)); });
      $('#unread').textContent = `${c.reduce((a, b) => a + b, 0)} unread`;
    });
    tw('#unread', { backgroundColor: '#4AC959' }, { backgroundColor: '#B91C1C', duration: 0.4 }, dimT);
    tw('#chatlist', { opacity: 1 }, { opacity: 0.42, duration: 0.6 }, dimT);
    tw('.crow .cnt', { backgroundColor: '#4AC959' }, { backgroundColor: '#9CA3AF', duration: 0.5 }, dimT);
    tw('#h1', { opacity: 1, y: 0 }, { opacity: 0, y: -40, duration: 0.35, ease: 'power2.in' }, dimT - 0.15);
    tw('#h2 .w', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.1 }, dimT + 0.15);
    cue(dimT, 'low', { gain: 0.9 });
  }

  // ======================= s02 · the turn + reveal =======================
  {
    const a = VO.vo03.start, meet = ph('vo03', 1, 0.72) - 0.05;
    show('#reveal-pre', a - 0.05, { y: 20, d: 0.6 });
    tw('#reveal-pre', { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.96, duration: 0.3 }, meet - 0.32);
    tw('#wipe', { opacity: 0, x: 0 }, { opacity: 1, x: 2300, duration: 0.75, ease: 'power2.inOut' }, meet - 0.35);
    master.set('#wipe', { opacity: 0 }, meet + 0.45);
    cue(meet - 0.5, 'riser');
    tw('#lockup1 .leaf-l', { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: 0.8, ease: 'power3.out' }, meet);
    tw('#lockup1 .leaf-r', { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: 0.8, ease: 'power3.out' }, meet);
    tw('#wm1', { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.7, ease: 'power3.out' }, meet + 0.15);
    tw('#lockup1', { scale: 0.92 }, { scale: 1.04, duration: S.s02.end - meet + 0.3, ease: 'power2.out' }, meet);
    tw('#s02-glow', { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1.12, duration: 1.4, ease: 'power2.out' }, meet);
    show('#descriptor', meet + 0.75, { y: 14, d: 0.6 });
    cue(meet, 'impact');
    cue(meet + 0.05, 'chime');
  }

  // ======================= s03 · connect =======================
  {
    const st = S.s03.start;
    copyIn('s03', st + 0.1);
    camIn('s03');
    const click = st + 1.55;
    cursor('03', [{ t: st + 0.75, at: { x: POS.connect.x + 120, y: POS.connect.y + 90 } }, { t: click, at: POS.connect, click: true }], click + 0.3);
    punch('#s03-btn', click, 0.95);
    show('#s03-spin', click + 0.15, { y: 0 });
    tw('#s03-scrim', { opacity: 0 }, { opacity: 1, duration: 0.25 }, click + 0.2);
    tw('#s03-modal', { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'power2.out' }, click + 0.22);
    const m0 = click + 0.4, m1 = Math.min(st + 4.4, S.s03.end - 2.2);
    tw('#s03-bar', { width: '0%' }, { width: '100%', duration: m1 - m0, ease: 'none' }, m0);
    const steps = ['Signing in…', 'Choosing your business…', 'Picking your number…'];
    DER.push((t) => { if (t >= S.s03.start - 0.3 && t <= S.s03.end + 0.3) $('#s03-modal-step').textContent = steps[Math.min(2, Math.floor(prog(t, m0, m1) * 3))]; });
    [1, 2, 3].forEach((k) => {
      const at = m0 + ((m1 - m0) * k) / 3 - 0.1;
      tw('#sd' + k, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'back.out(2)' }, at);
      cue(at, 'tick');
    });
    tw('#s03-modal', { opacity: 1 }, { opacity: 0, duration: 0.25 }, m1 + 0.05);
    tw('#s03-scrim', { opacity: 1 }, { opacity: 0, duration: 0.25 }, m1 + 0.05);
    hide('#s03-spin', m1 + 0.1, 0.15);
    show('#s03-alert', m1 + 0.25, { y: 6 });
    swap('#s03-off', '#s03-on', m1 + 0.3);
    punch('.status-swap', m1 + 0.4, 1.12);
    show('#s03-toast', m1 + 0.45, { y: 12 });
    cue(m1 + 0.3, 'success');
    hide('#s03-toast', S.s03.end - 0.5);
    focus('#s03 .win', '45% 55%', 1.06, click + 0.3, 1.2);
  }

  // ======================= s04 · shared inbox =======================
  {
    const st = S.s04.start;
    copyIn('s04', st + 0.1);
    camIn('s04');
    const assignAt = ph('vo05', 1, 0.42) - 0.05, pickAt = assignAt + 0.5;
    const noteAt = Math.max(pickAt + 0.45, ph('vo05', 2, 0.62) - 0.3), typeA = rel('vo05', 0.72), typeB = rel('vo05', 0.9), sendAt = typeB + 0.15;
    cursor('04', [
      { t: st + 0.9, at: { x: POS.assign.x - 140, y: POS.assign.y + 160 } },
      { t: assignAt, at: POS.assign, click: true },
      { t: pickAt, at: POS.priya, click: true },
      { t: typeA - 0.1, at: POS.comp, click: true },
      { t: sendAt, at: POS.send, click: true },
    ], sendAt + 0.5);
    tw('#assign-menu', { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.18 }, assignAt + 0.08);
    tw('#assign-menu', { opacity: 1 }, { opacity: 0, duration: 0.15 }, pickAt + 0.1);
    swap('#as-off', '#as-on', pickAt + 0.12);
    punch('#as-on', pickAt + 0.3, 1.1);
    show('#s04-toast', pickAt + 0.2, { y: 12 });
    hide('#s04-toast', noteAt + 1.4);
    cue(pickAt + 0.2, 'success', { gain: 0.6 });
    show('#note', noteAt, { y: 10, d: 0.4 });
    cue(noteAt, 'pop', { gain: 0.6 });
    const REPLY = 'Hi Karthik! Saturday 10 am still has seats. Sending the brochure now.';
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s04.end + 0.3) return;
      const typing = t >= typeA && t < sendAt;
      const n = Math.round(prog(t, typeA, typeB) * REPLY.length);
      const ct = $('#comp-text');
      if (typing && n > 0) { ct.textContent = REPLY.slice(0, n).slice(-46); ct.style.color = 'var(--text)'; } else { ct.textContent = 'Type a reply'; ct.style.color = 'var(--text-faint)'; }
      $('#caret').style.opacity = typing ? 1 : 0;
      $('#tk').classList.toggle('read', t >= sendAt + 0.9);
    });
    cue(typeA, 'typing', { dur: +(typeB - typeA).toFixed(3) });
    tw('#outb', { opacity: 0, y: 14, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'power2.out' }, sendAt + 0.05);
    cue(sendAt + 0.05, 'send');
    cue(sendAt + 0.9, 'tick', { gain: 0.6 });
    tw('#kcnt', { opacity: 1 }, { opacity: 0, duration: 0.2 }, st + 0.6);
    focus('#s04 .win', '70% 60%', 1.06, noteAt - 0.4, 1.1);
  }

  // ======================= s05 · campaigns =======================
  {
    const st = S.s05.start;
    copyIn('s05', st + 0.1);
    camIn('s05');
    const stepAt = [0.0, 0.085, 0.17, 0.255, 0.34].map((f) => rel('vo06', f));
    const launchAt = rel('vo06', 0.44), detailAt = launchAt + 0.25;
    cursor('05', [{ t: stepAt[4] + 0.1, at: { x: POS.launch.x - 160, y: POS.launch.y - 90 } }, { t: launchAt, at: POS.launch, click: true }, { t: ph('vo06', 3, 0.89) + 0.25, at: POS.chFail, click: true }], ph('vo06', 3, 0.89) + 0.85);
    stepAt.forEach((a, k) => cue(a, 'tick', { gain: 0.5 }));
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s05.end + 0.3) return;
      let cur = 0; stepAt.forEach((a, k) => { if (t >= a) cur = k + 1; });
      if (cur === 0) cur = 1;
      $$('#wiz .wizard-step-indicator').forEach((li, k) => { li.classList.toggle('active', k + 1 === cur); li.classList.toggle('done', k + 1 < cur); });
      for (let k = 1; k <= 5; k++) {
        const a = k === 1 ? st : stepAt[k - 1], b = k < 5 ? stepAt[k] : 1e9;
        const o = Math.min(prog(t, a, a + 0.18), 1 - prog(t, b - 0.06, b + 0.06));
        $('#wp' + k).style.opacity = String(o);
        $('#wp' + k).style.transform = `translateX(${(1 - Math.min(1, prog(t, a, a + 0.25))) * 18}px)`;
      }
      // delivery report
      const c = (a, b, v) => easeOut(prog(t, a, b)) * v;
      const sent = c(rel('vo06', 0.48), rel('vo06', 0.62), 2480), del = c(rel('vo06', 0.5), rel('vo06', 0.68), 2431);
      const read = c(rel('vo06', 0.56), rel('vo06', 0.8), 1962), fail = c(rel('vo06', 0.6), rel('vo06', 0.76), 49);
      $('#v-sent').textContent = fmt(sent); $('#v-del').textContent = fmt(del); $('#v-read').textContent = fmt(read); $('#v-fail').textContent = fmt(fail);
      $('#h-del').textContent = `${Math.round((del / 2480) * 100)}%`; $('#h-read').textContent = `${Math.round((read / 2480) * 100)}%`; $('#h-fail').textContent = `${Math.round((fail / 2480) * 100)}%`;
      $('#s05-title').textContent = t >= detailAt ? 'Admission open · weekend batch' : 'New campaign';
      const failOn = t >= ph('vo06', 3, 0.89) + 0.25;
      $('#ch-all').setAttribute('aria-pressed', String(!failOn)); $('#ch-fail').setAttribute('aria-pressed', String(failOn));
      $$('#s05 .rr.ok').forEach((r) => { r.style.opacity = failOn ? '0.28' : '1'; });
    });
    show('#s05-detail', detailAt, { y: 0, d: 0.35 });
    show('#s05-sending', detailAt, { y: 0, s: 0.9 });
    swap('#s05-sending', '#s05-done', rel('vo06', 0.82));
    cue(launchAt + 0.05, 'send');
    punch('#st-del', ph('vo06', 1, 0.55) + 0.75, 1.07);
    punch('#st-read', ph('vo06', 2, 0.79) + 0.15, 1.07);
    punch('#st-fail', ph('vo06', 3, 0.89) + 0.3, 1.07);
    cue(ph('vo06', 1, 0.55) + 0.75, 'pop', { gain: 0.6 }); cue(ph('vo06', 2, 0.79) + 0.15, 'pop', { gain: 0.6 });
    cue(rel('vo06', 0.82), 'success', { gain: 0.6 });
    focus('#s05 .win', '50% 30%', 1.05, detailAt + 0.2, 1.2);
  }

  // ======================= s06 · templates =======================
  {
    const st = S.s06.start;
    copyIn('s06', st + 0.1);
    camIn('s06');
    // keystroke script: type a bad variable, see the live error, fix it, finish the body
    const A = 'Hi {{first name', FIX = 'Hi {{', B = 'name}}, admissions for the weekend batch are now open. Seats are limited, so book a visit this week.';
    const t0 = rel('vo07', 0.02), avail = rel('vo07', 0.66) - t0;
    const base = { a: A.length / 14, pause: 0.6, del: (A.length - FIX.length) / 30, b: B.length / 42 };
    const k = Math.min(1, avail / (base.a + base.pause + base.del + base.b));
    const tA = t0 + base.a * k, tP = tA + base.pause * k, tD = tP + base.del * k, tB = tD + base.b * k;
    function textAt(t) {
      if (t < t0) return '';
      if (t < tA) return A.slice(0, Math.round(prog(t, t0, tA) * A.length));
      if (t < tP) return A;
      if (t < tD) return A.slice(0, A.length - Math.round(prog(t, tP, tD) * (A.length - FIX.length)));
      return FIX + B.slice(0, Math.round(prog(t, tD, tB) * B.length));
    }
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s06.end + 0.3) return;
      const txt = textAt(t);
      const bad = /\{\{first/.test(txt) && t < tD;
      $('#tp-body').innerHTML = esc(txt)
        .replace(/\{\{name\}\}/g, '<span class="var-chip">{{name}}</span>')
        .replace(/(\{\{first[^}]*)$/, '<span class="bad">$1</span>') + (t >= t0 && t < tB + 0.4 ? '<span class="caret" style="display:inline-block;width:1.5px;height:14px;background:var(--text);vertical-align:-2px"></span>' : '');
      $('#pv-text').innerHTML = txt ? esc(txt).replace(/\{\{name\}\}/g, '<span class="wa-var">Ananya</span>') : '<span style="color:var(--wa-muted);font-style:italic">Your message appears here</span>';
      $('#v-err').style.opacity = bad ? '1' : '0';
      $('#v-ok').style.opacity = t >= tB ? '1' : '0';
    });
    cue(t0, 'typing', { dur: +(tA - t0).toFixed(3) });
    cue(tA, 'error');
    cue(tD, 'typing', { dur: +(tB - tD).toFixed(3) });
    cue(tB, 'tick');
    tw('#pv-btn', { opacity: 0.35 }, { opacity: 1, duration: 0.3 }, tB);
    const subAt = Math.max(tB + 0.45, rel('vo07', 0.78));
    cursor('06', [{ t: tB + 0.05, at: { x: POS.submit.x - 120, y: POS.submit.y + 110 } }, { t: subAt, at: POS.submit, click: true }], subAt + 0.4);
    swap('#tp-draft', '#tp-review', subAt + 0.1);
    const okAt = Math.min(subAt + 1.1, S.s06.end - 0.6);
    swap('#tp-review', '#tp-ok', okAt);
    punch('#s06 .status-swap', okAt + 0.1, 1.15);
    cue(okAt, 'success');
    focus('#s06 .win', '72% 45%', 1.06, t0 + 0.4, 1.4);
  }

  // ======================= s07 · automation =======================
  {
    const st = S.s07.start;
    copyIn('s07', st + 0.1);
    camIn('s07');
    ['#n1', '#n2', '#n3', '#n4', '#n5'].forEach((n, i) => {
      tw(n, { opacity: 0, scale: 0.94, y: 8 }, { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.6)' }, st + 0.35 + i * 0.16);
    });
    // route each edge between the real node boxes (canvas px)
    const box = (n) => { const e = $(n); return { l: e.offsetLeft, t: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }; };
    const H = (a, b) => { const x1 = a.l + a.w, y1 = a.t + a.h / 2, x2 = b.l, y2 = b.t + b.h / 2, d = (x2 - x1) / 2; return `M${x1} ${y1} C${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`; };
    const B = { n1: box('#n1'), n2: box('#n2'), n3: box('#n3'), n4: box('#n4'), n5: box('#n5') };
    $('#e1').setAttribute('d', H(B.n1, B.n2));
    $('#e2').setAttribute('d', H(B.n2, B.n3));
    { const x1 = B.n3.l + B.n3.w / 2, y1 = B.n3.t + B.n3.h, x2 = B.n4.l + B.n4.w, y2 = B.n4.t + B.n4.h / 2; $('#e3').setAttribute('d', `M${x1} ${y1} C${x1} ${y2}, ${x1} ${y2}, ${x2} ${y2}`); }
    { const x1 = B.n4.l, y1 = B.n4.t + B.n4.h / 2, x2 = B.n5.l + B.n5.w / 2, y2 = B.n5.t; $('#e4').setAttribute('d', `M${x1} ${y1} C${x2} ${y1}, ${x2} ${y1}, ${x2} ${y2}`); }
    const edges = ['#e1', '#e2', '#e3', '#e4'].map((s) => $(s));
    edges.forEach((e, i) => {
      const L = e.getTotalLength();
      e.style.strokeDasharray = `${L}`;
      tw(e, { strokeDashoffset: L }, { strokeDashoffset: 0, duration: 0.45, ease: 'power2.out' }, st + 0.75 + i * 0.16);
    });
    const onAt = rel('vo08', 0.3);
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s07.end + 0.3) return;
      const on = t >= onAt;
      $('#flow-toggle').classList.toggle('on', on);
      $('#flow-toggle-label').textContent = on ? 'Active' : 'Off';
    });
    cue(onAt, 'click');
    // a pulse travels each edge in turn; the node it reaches lights up
    const legs = [['#e1', 0.42, 0.5, '#n2'], ['#e2', 0.58, 0.66, '#n3'], ['#e3', 0.74, 0.82, '#n4'], ['#e4', 0.84, 0.92, '#n5']]
      .map(([e, a, b, n]) => ({ e: $(e), a: rel('vo08', a), b: rel('vo08', b), n }));
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s07.end + 0.3) return;
      const leg = legs.find((l) => t >= l.a && t <= l.b);
      const pulse = $('#pulse');
      if (leg) {
        const L = leg.e.getTotalLength(), p = leg.e.getPointAtLength(easeOut(prog(t, leg.a, leg.b)) * L);
        pulse.style.opacity = '1'; pulse.style.left = p.x + 'px'; pulse.style.top = p.y + 'px';
      } else pulse.style.opacity = '0';
      $('#n1').classList.toggle('lit', t >= legs[0].a - 0.3);
      legs.forEach((l) => { $(l.n).classList.toggle('lit', t >= l.b); l.e.classList.toggle('live', t >= l.a); });
    });
    legs.forEach((l) => cue(l.b, 'tick', { gain: 0.55 }));
    show('#chatcard', rel('vo08', 0.36), { y: 40, d: 0.5 });
    [['#cm1', 0.42], ['#cm2', 0.5], ['#cm2b', 0.53], ['#cm3', 0.6], ['#cm4', 0.67], ['#cm5', 0.75], ['#cm6', 0.85]].forEach(([m, f]) => {
      show(m, rel('vo08', f), { y: 8, d: 0.25 });
      cue(rel('vo08', f), 'pop', { gain: 0.45 });
    });
    focus('#s07 .win', '45% 40%', 1.04, st + 1.2, 1.5);
  }

  // ======================= s08 · integrations =======================
  {
    const st = S.s08.start;
    tw('#s08 .int-title .w', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', stagger: 0.07 }, st + 0.05);
    tw('#hub-core', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(1.8)' }, st + 0.25);
    cue(st + 0.25, 'impact', { gain: 0.5 });
    DER.push((t) => {
      if (t < st - 0.3 || t > S.s08.end + 0.3) return;
      ['#ring1', '#ring2'].forEach((r, i) => {
        const ph = (((t - st) / 1.8 + i * 0.5) % 1 + 1) % 1, size = 120 + ph * 320, el = $(r);
        el.style.width = el.style.height = size + 'px';
        el.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
        el.style.opacity = t < st + 0.4 ? '0' : String((1 - ph) * 0.55);
      });
    });
    const hubC = { x: 960, y: 636 };
    const chips = [['#ic5', 0.24], ['#ic4', 0.38], ['#ic1', 0.6], ['#ic2', 0.74], ['#ic3', 0.86]];
    const svg = $('#spokes');
    chips.forEach(([c, f]) => {
      const el = $(c);
      const cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2;
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', hubC.x); ln.setAttribute('y1', hubC.y); ln.setAttribute('x2', cx); ln.setAttribute('y2', cy);
      ln.style.opacity = 0; svg.appendChild(ln);
      const at = rel('vo09', f);
      tw(el, { opacity: 0, scale: 0.88, y: 16 }, { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: 'back.out(1.7)' }, at);
      tw(ln, { opacity: 0 }, { opacity: 1, duration: 0.4 }, at - 0.05);
      cue(at, 'pop', { gain: 0.55 });
    });
    show('#code', rel('vo09', 0.64), { y: 24, d: 0.5 });
    tw('#s08-glow', { scale: 0.9 }, { scale: 1.1, duration: S.s08.end - st, ease: 'none' }, st);
  }

  // ======================= s09 · recap =======================
  {
    const st = S.s09.start;
    const P10 = [0, 1, 2, 3].map((k) => ph('vo10', k, [0, 0.25, 0.5, 0.76][k]));
    const beats = [['#rw1', '#rc1'], ['#rw2', '#rc2'], ['#rw3', '#rc3']];
    beats.forEach(([w, c], i) => {
      const at = i === 0 ? Math.max(st + 0.05, P10[0] - 0.1) : P10[i] - 0.05;
      show(w, at, { y: 24, d: 0.35 });
      if (i < 2) tw(w, { opacity: 1 }, { opacity: 0, y: -20, duration: 0.2 }, P10[i + 1] - 0.2);
      tw(c, { opacity: 0, y: 60, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power3.out' }, at);
      cue(at, 'swish', { gain: 0.45 });
    });
    const joinAt = P10[3] - 0.35;
    tw('#rw3', { opacity: 1 }, { opacity: 0, y: -20, duration: 0.2 }, joinAt - 0.1);
    tw('#rc1', { x: 0 }, { x: 550, scale: 0.5, opacity: 0, duration: 0.5, ease: 'power3.in' }, joinAt);
    tw('#rc3', { x: 0 }, { x: -550, scale: 0.5, opacity: 0, duration: 0.5, ease: 'power3.in' }, joinAt);
    tw('#rc2', { scale: 1 }, { scale: 0.5, opacity: 0, duration: 0.5, ease: 'power3.in' }, joinAt);
    tw('#one-place', { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(1.6)' }, joinAt + 0.35);
    cue(joinAt + 0.3, 'impact', { gain: 0.7 });
  }

  // ======================= s10 · close + CTA =======================
  {
    const st = S.s10.start;
    tw('#s10-glow', { opacity: 0, scale: 0.8 }, { opacity: 0.9, scale: 1.1, duration: 2.5, ease: 'power2.out' }, st);
    tw('#lockup2', { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.8, ease: 'power3.out' }, VO.vo11.start - 0.15);
    cue(VO.vo11.start - 0.15, 'chime');
    tw('#s10 .tagline .w', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.12 }, rel('vo11', 0.3));
    show('#cta', VO.vo12.start, { y: 24, d: 0.6 });
    punch('#cta .btn-primary', rel('vo12', 0.45), 1.06);
    show('#cbadges', rel('vo12', 0.8), { y: 16, d: 0.6 });
    tw('#endblack', { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power1.in' }, DUR - 0.9);
  }

  // spinners: CSS animation is paused for deterministic frames, so spin them from t
  DER.push((t) => { $$('.spinner').forEach((el) => { el.style.transform = `rotate(${(t * 514) % 360}deg)`; }); });

  // footnote on product scenes only (UI uses illustrative data)
  const productRanges = ['s03', 's04', 's05', 's06', 's07', 's09'].map((id) => [S[id].start, S[id].end]);
  DER.push((t) => {
    const inside = productRanges.some(([a, b]) => t >= a + 0.3 && t <= b - 0.1);
    $('#footnote').style.opacity = inside ? '0.9' : '0';
  });

  master.set({}, {}, DUR); // pad the timeline to the full film length
  window.CUES = CUES.sort((a, b) => a.t - b.t);
  window.__FILM_DURATION__ = DUR;
  window.__seek = function (t) {
    master.seek(t, false);
    DER.forEach((f) => f(t));
  };
  window.__seek(0);
  window.__ready = true;
}));
