// Master GSAP timeline, paused and driven only by window.__seek(t), so every frame is
// deterministic. Beats are keyed to the exact WORD the voice is on (wt(id, word)),
// using the per-character timings ElevenLabs returns for the continuous take, so a
// new read re-times the picture by itself. Anything continuous (particles, packets,
// typing, counters, stacking) is a pure function of t in DER[], never a callback.
// window.CUES lists every sound-effect instant for make-sfx.js.
window.addEventListener('load', () => Promise.all([
  document.fonts.ready,
  document.fonts.load('17px "Noto Sans Tamil"', 'தமிழ்'),
  document.fonts.load('18px "JetBrains Mono"', 'wasi'),
  document.fonts.load('600 66px Poppins', 'Wasi'),
]).then(function () {
  const T = window.TIMING, VO = window.VO_BY_ID, S = T.scenes, DUR = T.FILM_DURATION;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const prog = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1));
  const e3 = (p) => 1 - Math.pow(1 - p, 3);
  const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const fmt = (n) => Math.round(n).toLocaleString('en-IN');
  gsap.defaults({ lazy: false }); // render synchronously on every seek, never deferred to a ticker
  const master = gsap.timeline({ paused: true });
  const DER = [];
  const CUES = [];
  const cue = (t, s, extra = {}) => CUES.push(Object.assign({ t: +t.toFixed(3), s }, extra));
  // GSAP restores an element to its pre-tween state while the playhead is before the tween,
  // so the first "from" value of every property is applied up front as that resting state.
  const INIT = new Map();
  function initFrom(sel, from) {
    gsap.utils.toArray(sel).forEach((el) => {
      let seen = INIT.get(el);
      if (!seen) INIT.set(el, (seen = new Set()));
      const v = {};
      Object.keys(from).forEach((k) => { if (!seen.has(k)) { seen.add(k); v[k] = from[k]; } });
      if (Object.keys(v).length) gsap.set(el, v);
    });
  }
  const tw = (sel, from, to, pos) => { initFrom(sel, from); return master.fromTo(sel, from, Object.assign({ immediateRender: false }, to), pos); };
  const show = (sel, at, o = {}) => tw(sel, { opacity: 0, y: o.y ?? 16, scale: o.s ?? 1 }, { opacity: 1, y: 0, scale: 1, duration: o.d ?? 0.45, ease: o.ease ?? 'power3.out', stagger: o.stagger ?? 0 }, at);
  const hide = (sel, at, d = 0.3) => tw(sel, { opacity: 1 }, { opacity: 0, duration: d }, at);
  const punch = (sel, at, s = 1.08) => tw(sel, { scale: 1 }, { scale: s, duration: 0.16, ease: 'power2.out', yoyo: true, repeat: 1 }, at);
  const words = (sel, at, st = 0.08) => tw(sel, { opacity: 0, y: 40, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6, ease: 'power3.out', stagger: st }, at);

  // time of a word in a line: wt('vo04', 'Fees') -> start of that word (k-th match)
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9஀-௿]/g, '');
  function wt(id, needle, k = 0, end = false) {
    const n = norm(needle);
    let c = 0;
    for (const w of VO[id].words) if (norm(w.w).startsWith(n) && c++ === k) return end ? w.e : w.s;
    throw new Error(`word "${needle}" #${k} not found in ${id}`);
  }

  // ---------------- icons (Lucide, stroke 1.75 per the design system) ----------------
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
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
    'indian-rupee': '<path d="M6 3h12"/><path d="M6 8h12"/><path d="m6 13 8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>',
    'pause-circle': '<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
  };

  // ======================= dynamic DOM (built before measuring) =======================
  // s01/s02 lock-screen notifications
  const NOTIFS = [
    ['Ananya R', 'Is the blue kurta still in stock?'], ['Karthik S', 'What are the fees for the weekend batch?'],
    ['Rahul V', 'Can I book Saturday at 11?'], ['Fathima N', "Order #4821 hasn't arrived yet"],
    ['Vignesh S', 'Do you deliver to Coimbatore?'], ['Sneha M', 'Price for the 2 kg pack?'], ['Lakshmi K', 'Hello? Anyone there?'],
  ];
  const notifHtml = NOTIFS.map(([n, m]) => `<div class="notif"><span class="ap"><i data-icon="message-circle"></i></span><div class="tx"><div class="r1"><b>${n}</b><span>now</span></div><div class="r2">${m}</div></div></div>`).join('') + '<div class="morepill">+142 more chats</div>';
  $('#notifs').innerHTML = notifHtml;
  $('#notifs2').innerHTML = notifHtml;

  // the customer's phone: WhatsApp chat with the business. Customer = green (right).
  const SIG = '<svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="10" y="2" width="3" height="10" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>';
  const BAT = '<svg viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="currentColor" opacity=".5"/><rect x="2" y="2" width="15" height="8" rx="2" fill="currentColor"/><rect x="23.5" y="4" width="2" height="4" rx="1" fill="currentColor" opacity=".5"/></svg>';
  const TICK = '<svg class="tk" viewBox="0 0 18 11"><path d="M1 6l3.4 3.4L11 2.6" stroke="#8696A0" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M5.6 8.3l1.1 1.1L13.4 2.6" stroke="#8696A0" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
  const CHAT = [
    { k: 'd0', type: 'chip', text: 'Today' },
    { k: 'i1', type: 'me', text: 'Hi, what are the fees for the weekend batch?', time: '11:06 pm' },
    { k: 'y2', type: 'typing' },
    { k: 'i3', type: 'biz', text: 'The weekend batch is ₹4,500 a month, Saturday and Sunday, 9 am to 12 noon. Shall I send the admission form?', time: '11:06 pm', btn: 'Send admission form' },
    { k: 'i4', type: 'me', ta: true, text: 'சனிக்கிழமை வகுப்பு எங்கே நடக்கும்?', time: '11:07 pm' },
    { k: 'y5', type: 'typing' },
    { k: 'i6', type: 'biz', ta: true, text: 'அண்ணா நகர் கிளையில், 2வது அவென்யூ. வகுப்பு காலை 9 மணிக்குத் தொடங்கும்.', time: '11:07 pm' },
    { k: 'i7', type: 'me', text: 'Can I get 20% off if I pay for the full year?', time: '11:09 pm' },
    { k: 'y8', type: 'typing' },
    { k: 'i9', type: 'biz', text: "I've passed this to our team. They'll reply when they're back at 9:00 am.", time: '11:09 pm' },
    { k: 'd10', type: 'chip', text: 'Next morning' },
    { k: 'i11', type: 'biz', text: 'Hi Karthik, Priya here from admissions. Let me check the annual plan options for you.', time: '9:02 am' },
  ];
  function itemHtml(p, it) {
    let inner;
    if (it.type === 'chip') inner = `<div class="dchip">${it.text}</div>`;
    else if (it.type === 'typing') inner = '<div class="wb in typing"><b></b><b></b><b></b></div>';
    else if (it.type === 'me') inner = `<div class="wb out${it.ta ? ' ta' : ''}">${it.text}<span class="meta">${it.time}${TICK}</span></div>`;
    else inner = `<div class="wb in${it.ta ? ' ta' : ''}${it.btn ? ' btns' : ''}">${it.text}<span class="meta">${it.time}</span>${it.btn ? `<div class="qr"><i data-icon="reply"></i>${it.btn}</div>` : ''}</div>`;
    return `<div class="it" id="${p}-${it.k}"><div>${inner}</div></div>`;
  }
  function buildChatPhone(sel, p) {
    $(sel).innerHTML = `<div class="btn-side"></div><div class="screen"><div class="island"></div>
      <div class="sbar"><span>11:06</span><span class="ic">${SIG}${BAT}</span></div>
      <div class="wah"><span class="back"><i data-icon="chevron-left"></i></span><div class="av">AA</div><div class="nm"><b>Arya Academy</b><span><em class="onl">online</em><em class="typ">typing…</em></span></div><div class="tools"><i data-icon="video"></i><i data-icon="phone"></i></div></div>
      <div class="wall"><div class="feed">${CHAT.map((it) => itemHtml(p, it)).join('')}</div></div>
      <div class="wab"><div class="fld"><i data-icon="smile"></i><span class="g">Message</span><i data-icon="paperclip"></i><i data-icon="camera"></i></div><div class="mic"><i data-icon="mic"></i></div></div></div>`;
  }
  buildChatPhone('#ph3', 'p3');
  buildChatPhone('#ph4', 'p4');

  // s07 inbox rows
  const CR7 = [
    ['AR', 'Ananya R', 'Size M is in stock. Shall I send the link?', '9:14 pm', 'ai', true],
    ['KS', 'Karthik S', 'Can I get 20% off for the full year?', '11:09 pm', 'need'],
    ['MK', 'Meera K', 'Paid. Thank you!', '8:02 pm', 'ai'],
    ['RV', 'Rahul V', 'Saturday 11 am works for me', '7:45 pm', 'ai'],
    ['FN', 'Fathima N', 'Where is my order #4821?', '6:30 pm', 'mine'],
    ['VS', 'Vignesh S', 'Do you have the 2 kg pack?', '5:12 pm', 'ai'],
  ];
  const TAG7 = {
    ai: '<span class="badge badge-success"><i data-icon="bot"></i>AI replied</span>',
    need: '<span class="badge badge-warning"><i data-icon="alert-circle"></i>Needs a person</span>',
    mine: '<span class="badge badge-info"><i data-icon="user-check"></i>Priya</span>',
  };
  $('#crows7').innerHTML = CR7.map((c, i) => `<div class="crow${c[5] ? ' sel' : ''}" id="cr7-${i}"><div class="avatar-initials">${c[0]}</div><div class="m"><div class="n">${c[1]}<span>${c[3]}</span></div><div class="p">${c[2]}</div><div class="tags">${TAG7[c[4]]}</div></div><span class="glow${c[4] === 'need' ? ' w' : ''}"></span></div>`).join('');

  // particles, rays, envelopes
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const PARTS = Array.from({ length: 54 }, () => ({ x: rnd() * 1920, y: rnd() * 1080, r: 1.2 + rnd() * 2.6, v: 6 + rnd() * 22, ph: rnd() * 6.28, a: 0.12 + rnd() * 0.4 }));
  $('#particles').innerHTML = PARTS.map((p) => `<b style="width:${p.r * 2}px;height:${p.r * 2}px"></b>`).join('');
  ['#rays', '#rays10'].forEach((s) => { $(s).innerHTML = Array.from({ length: 24 }, (_, i) => `<b style="transform:rotate(${i * 15}deg);opacity:${0.4 + (i % 3) * 0.25}"></b>`).join(''); });
  $('#envs').innerHTML = Array.from({ length: 22 }, (_, i) => `<div class="env" id="env${i}"><i data-icon="message-square"></i></div>`).join('');

  $$('[data-icon]').forEach((el) => {
    const p = ICONS[el.dataset.icon];
    if (!p) throw new Error('missing icon ' + el.dataset.icon);
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  });

  // ======================= measure (nothing is transformed yet) =======================
  const box = (sel) => { const r = $(sel).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
  const H = {};
  $$('.feed .it').forEach((el) => { H[el.id] = el.offsetHeight; });
  const CUR = { assign: box('#assign4') };
  const TCH = Object.fromEntries(['#tc1', '#tc2', '#tc3'].map((s) => [s, $(s).offsetHeight]));
  const B5 = { con: box('#con'), hub: box('#hub5'), src: [1, 2, 3, 4].map((i) => box('#src' + i)), mc: [1, 2, 3].map((i) => box('#mc' + i)) };
  const bez = (x1, y1, x2, y2) => `M ${x1} ${y1} C ${x1 + (x2 - x1) * 0.5} ${y1}, ${x1 + (x2 - x1) * 0.5} ${y2}, ${x2} ${y2}`;
  $('#e5-c').setAttribute('d', bez(B5.con.r, B5.src[0].cy, B5.src[0].l, B5.src[0].cy));
  B5.src.forEach((s, i) => $('#e5-' + (i + 1)).setAttribute('d', bez(s.r, s.cy, B5.hub.l + 14, B5.hub.cy + (i - 1.5) * 26)));
  B5.mc.forEach((m, i) => $('#e5-o' + (i + 1)).setAttribute('d', bez(B5.hub.r - 14, B5.hub.cy + (i - 1) * 24, m.l, m.cy)));
  // s08 flow edges, in the canvas's own (unzoomed) px
  const nb = (id) => { const e = $(id); return { l: e.offsetLeft, t: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }; };
  const F = [nb('#fn1'), nb('#fn2'), nb('#fn3'), nb('#fn4')];
  $('#ed1').setAttribute('d', bez(F[0].l + F[0].w, F[0].t + F[0].h / 2, F[1].l, F[1].t + F[1].h / 2));
  $('#ed2').setAttribute('d', `M ${F[1].l + 30} ${F[1].t + F[1].h} C ${F[1].l + 30} ${F[2].t - 10}, ${F[2].l + F[2].w / 2} ${F[1].t + F[1].h + 20}, ${F[2].l + F[2].w / 2} ${F[2].t}`);
  $('#ed3').setAttribute('d', `M ${F[1].l + F[1].w - 30} ${F[1].t + F[1].h} C ${F[1].l + F[1].w - 30} ${F[3].t - 10}, ${F[3].l + F[3].w / 2} ${F[1].t + F[1].h + 20}, ${F[3].l + F[3].w / 2} ${F[3].t}`);
  const LEN = {};
  $$('svg path[id]').forEach((p) => { LEN[p.id] = p.getTotalLength(); });
  const draw = (id, at, d = 0.6) => { const L = LEN[id]; gsap.set('#' + id, { strokeDasharray: L }); tw('#' + id, { strokeDashoffset: L, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, duration: d, ease: 'power2.inOut' }, at); };

  // centring lives in GSAP's percent channel so tweened x/y/scale never fight it
  gsap.set('.lockup, .onewa', { xPercent: -50, yPercent: -50 });
  // effects whose first tween starts from a visible value rest hidden
  initFrom('#hp5, #rip4, #flash', { opacity: 0 });

  // ======================= scene transitions =======================
  const ids = Object.keys(S);
  const SEAMLESS = { s02: true, s04: true }; // same phone / orb carries over: plain dissolve
  ids.forEach((id, i) => {
    const el = $('#' + id);
    el.style.zIndex = String(i + 1);
    const inAt = i === 0 ? 0 : S[id].start - 0.3;
    master.set(el, { visibility: 'visible' }, inAt);
    if (i === 0) tw(el, { opacity: 0 }, { opacity: 1, duration: 1.0, ease: 'power1.inOut' }, 0);
    else if (SEAMLESS[id]) tw(el, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power1.inOut' }, inAt);
    else {
      tw(el, { opacity: 0, scale: 1.045, filter: 'blur(14px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.7, ease: 'power3.out' }, inAt);
      const prev = $('#' + ids[i - 1]);
      tw(prev, { scale: 1, filter: 'blur(0px)' }, { scale: 0.965, filter: 'blur(6px)', duration: 0.6, ease: 'power2.in' }, inAt - 0.1);
      cue(inAt, 'swish', { gain: 0.35 });
    }
    const next = ids[i + 1];
    if (next) master.set(el, { visibility: 'hidden' }, S[next].start + 0.5);
  });

  // chat helpers: an item grows its own height (so the feed scrolls up smoothly)
  const typingRanges = { p3: [], p4: [] };
  const readAt = {};
  function msgIn(p, k, at, sound = 'pop') {
    const id = `#${p}-${k}`, it = CHAT.find((c) => c.k === k);
    tw(id, { height: 0 }, { height: H[`${p}-${k}`], duration: 0.42, ease: 'power3.out' }, at);
    const origin = it.type === 'me' ? '100% 100%' : it.type === 'chip' ? '50% 50%' : '0% 100%';
    tw(id + ' > div', { opacity: 0, scale: 0.88, y: 16, transformOrigin: origin }, { opacity: 1, scale: 1, y: 0, duration: 0.42, ease: 'back.out(1.6)' }, at + 0.04);
    if (sound) cue(at, sound, { gain: 0.45 });
  }
  function typingFor(p, k, a, b) {
    msgIn(p, k, a, null);
    tw(`#${p}-${k}`, { height: H[`${p}-${k}`] }, { height: 0, duration: 0.3, ease: 'power2.in' }, b - 0.05);
    tw(`#${p}-${k} > div`, { opacity: 1 }, { opacity: 0, duration: 0.15 }, b - 0.05);
    typingRanges[p].push([a, b]);
  }

  // ======================= s01 · the agentic era =======================
  {
    const v1 = 'vo01', v2 = 'vo02';
    show('#s01-k', 0.5, { y: 10, d: 0.8 });
    tw('#orb1', { opacity: 0, scale: 0.55 }, { opacity: 1, scale: 1, duration: 1.6, ease: 'expo.out' }, 0.15);
    cue(0.15, 'low', { gain: 0.6 });
    [['#task1', wt(v1, 'answer')], ['#task2', wt(v1, 'follow')], ['#task3', wt(v1, 'close')]].forEach(([s, at]) => {
      tw(s, { opacity: 0, scale: 0.6, y: 20 }, { opacity: 1, scale: 1, y: 0, duration: 0.55, ease: 'back.out(1.8)' }, at - 0.05);
      punch('#orb1 .core', at, 1.06);
      cue(at - 0.05, 'tick', { gain: 0.6 });
    });
    const but = wt(v2, 'But');
    tw('#task1, #task2, #task3', { opacity: 1 }, { opacity: 0.28, duration: 0.5 }, but);
    const wAt = wt(v2, 'chat');
    tw('#widget', { opacity: 0, x: 120, rotationY: -18, transformPerspective: 1400 }, { opacity: 1, x: 0, rotationY: -6, duration: 0.8, ease: 'power3.out' }, wAt - 0.25);
    cue(wAt - 0.25, 'swish', { gain: 0.4 });
    const xAt = wt(v2, 'website') + 0.15;
    tw('#xmark', { opacity: 0, scale: 0.3, rotation: -40 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.45, ease: 'back.out(2)' }, xAt);
    cue(xAt, 'error', { gain: 0.45 });
    const onWA = wt(v2, 'They');
    tw('#widget, #xmark', { opacity: 1, y: 0 }, { opacity: 0, y: 120, rotation: 8, duration: 0.55, ease: 'power2.in' }, onWA - 0.2);
    tw('#ph1', { opacity: 0, y: 260, rotation: 4 }, { opacity: 1, y: 0, rotation: 0, duration: 0.9, ease: 'expo.out' }, onWA - 0.05);
    tw('#task1, #task2, #task3', { opacity: 0.28 }, { opacity: 0, duration: 0.5 }, onWA);
    hide('#s01-k', onWA, 0.5);
    tw('#orb1', { x: 0 }, { x: 120, duration: S.s01.end - onWA + 0.5, ease: 'power1.inOut' }, onWA);
    cue(onWA - 0.05, 'swish', { gain: 0.55 });
  }
  // notifications stack on both lock screens (s01 and the carried-over s02 phone)
  const NT = [];
  { const t0 = wt('vo02', 'WhatsApp') - 0.1; for (let i = 0; i < NOTIFS.length; i++) NT.push(t0 + i * 0.27); NT.forEach((t, i) => cue(t, 'pop', { gain: 0.25 + 0.05 * (i % 2) })); }
  const NMORE = NT[NT.length - 1] + 0.45;
  DER.push((t) => {
    ['#notifs', '#notifs2'].forEach((cs) => {
      const items = $$(cs + ' .notif');
      items.forEach((el, i) => {
        const a = e3(prog(t, NT[i], NT[i] + 0.4));
        let push = 0;
        for (let j = i + 1; j < NT.length; j++) push += e3(prog(t, NT[j], NT[j] + 0.4));
        const fade = push > 3.6 ? Math.max(0, 1 - (push - 3.6) * 1.4) : 1;
        el.style.transform = `translateY(${push * 94 - (1 - a) * 40}px) scale(${0.92 + 0.08 * a})`;
        el.style.opacity = String(a * fade);
      });
      const m = $(cs + ' .morepill'), mp = e3(prog(t, NMORE, NMORE + 0.4));
      m.style.top = '480px';
      m.style.opacity = String(mp);
      m.style.transform = `translateX(-50%) translateY(${(1 - mp) * 16}px)`;
    });
  });

  // ======================= s02 · turn + reveal =======================
  {
    const v = 'vo03';
    tw('#orb2', { x: 120 }, { x: 60, duration: 1.2, ease: 'power2.out' }, S.s02.start);
    const built = wt(v, 'built');
    tw('#hub2', { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(2)' }, built);
    draw('beamA', built - 0.1, 0.55);
    draw('beamB', built + 0.15, 0.55);
    cue(built, 'tick', { gain: 0.6 });
    const safe = wt(v, 'safe');
    punch('#hub2', safe, 1.15);
    cue(safe, 'success', { gain: 0.45 });
    const meet = wt(v, 'Meet');
    cue(meet - 0.55, 'riser', { gain: 0.6 });
    // packets ride orb -> hub -> phone until the reveal
    const pk = ['#pk2a', '#pk2b', '#pk2c'];
    DER.push((t) => {
      const A = $('#beamA'), Bp = $('#beamB');
      pk.forEach((s, i) => {
        const el = $(s), t0 = safe + i * 0.33;
        if (t < t0 || t > meet + 0.1) { el.style.opacity = '0'; return; }
        const u = ((t - t0) / 1.0) % 2;
        const path = u < 1 ? A : Bp, L = u < 1 ? LEN.beamA : LEN.beamB, f = u % 1;
        const pt = path.getPointAtLength(L * f);
        el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
        el.style.opacity = String(Math.min(1, (t - t0) * 4) * (t > meet - 0.1 ? 0 : 1));
      });
    });
    tw('#orb2', { opacity: 1, x: 60 }, { opacity: 0, x: -260, scale: 0.6, duration: 0.45, ease: 'power3.in' }, meet - 0.25);
    tw('#ph2', { opacity: 1, x: 0 }, { opacity: 0, x: 320, rotation: 6, duration: 0.45, ease: 'power3.in' }, meet - 0.25);
    tw('#beamA, #beamB', { opacity: 1 }, { opacity: 0, duration: 0.3 }, meet - 0.1);
    tw('#hub2', { scale: 1, opacity: 1 }, { scale: 3.2, opacity: 0, duration: 0.55, ease: 'power3.in' }, meet - 0.1);
    tw('#flash', { opacity: 0 }, { opacity: 1, duration: 0.12, ease: 'power2.out' }, meet + 0.28);
    tw('#flash', { opacity: 1 }, { opacity: 0, duration: 0.9, ease: 'power2.out' }, meet + 0.4);
    cue(meet + 0.3, 'impact', { gain: 0.7 });
    const L0 = meet + 0.3;
    tw('#rays', { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 1.4, ease: 'expo.out' }, L0);
    tw('#leafL', { x: -60, rotation: -30, opacity: 0, transformOrigin: '50% 100%' }, { x: 0, rotation: 0, opacity: 1, duration: 0.8, ease: 'expo.out' }, L0);
    tw('#leafR', { x: 60, rotation: 30, opacity: 0, transformOrigin: '50% 100%' }, { x: 0, rotation: 0, opacity: 1, duration: 0.8, ease: 'expo.out' }, L0 + 0.05);
    tw('#lockup1', { opacity: 0, scale: 0.82 }, { opacity: 1, scale: 1, duration: 0.9, ease: 'expo.out' }, L0);
    tw('#wm1', { opacity: 0, x: -30, filter: 'blur(10px)' }, { opacity: 1, x: 0, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out' }, L0 + 0.12);
    tw('#lockup1', { scale: 1 }, { scale: 1.04, duration: S.s02.end - L0 + 0.5, ease: 'none' }, L0 + 0.9);
    cue(L0 + 0.1, 'chime', { gain: 0.8 });
    show('#rsub', L0 + 0.75, { y: 22, d: 0.7 });
  }
  DER.push((t) => { ['#rays', '#rays10'].forEach((s) => { $(s).style.rotate = `${t * 7}deg`; }); });

  // ======================= s03 · built-in assistant =======================
  {
    const v = 'vo04', st = S.s03.start;
    words('#s03-copy .headline .w', st + 0.15);
    show('#s03-copy .kicker', st, { y: 12 });
    show('#s03-copy .chip', st + 0.6, { y: 14, stagger: 0.1 });
    tw('#ph3', { opacity: 0, y: 140 }, { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out' }, st - 0.1);
    tw('#aip', { opacity: 0, x: 120, rotationY: -20, transformPerspective: 1600 }, { opacity: 1, x: 0, rotationY: 0, duration: 0.9, ease: 'expo.out' }, st + 0.1);
    const askAt = st + 0.3;
    msgIn('p3', 'd0', st - 0.2, null);
    msgIn('p3', 'i1', askAt, 'send');
    const sw = wt(v, 'Switch');
    master.set('#aitog', { attr: { class: 'on' } }, sw + 0.15);
    punch('#aitogw', sw + 0.15, 1.12);
    cue(sw + 0.15, 'click', { gain: 0.7 });
    show('#ai-live', sw + 0.25, { y: 8 });
    sheenAt('#aip .sheen', sw + 0.3);
    const kAt = wt(v, 'knowledge');
    typingFor('p3', 'y2', wt(v, 'answers'), wt(v, 'seconds'));
    draw('kbeam', kAt, 0.6);
    [['#kd1', wt(v, 'Fees')], ['#kd2', wt(v, 'timings')], ['#kd3', wt(v, 'orders')]].forEach(([s, at]) => {
      tw(s + ' .hl', { opacity: 0 }, { opacity: 1, duration: 0.25 }, at - 0.05);
      punch(s, at, 1.04);
      cue(at, 'tick', { gain: 0.5 });
    });
    tw('#kd3 .hl', { opacity: 1 }, { opacity: 0, duration: 0.4 }, wt(v, 'seconds') + 0.3);
    const ansAt = wt(v, 'seconds');
    msgIn('p3', 'i3', ansAt, 'success');
    readAt['p3-i1'] = ansAt - 0.3;
    show('#ans3', ansAt + 0.15, { y: 14 });
    tw('#kbeam', { opacity: 1 }, { opacity: 0, duration: 0.5 }, ansAt + 0.6);
    const lang = wt(v, 'language');
    msgIn('p3', 'i4', wt(v, 'customer') - 0.1, 'send');
    readAt['p3-i4'] = lang + 0.2;
    typingFor('p3', 'y5', wt(v, 'customer') + 0.45, lang + 0.5);
    msgIn('p3', 'i6', lang + 0.5, 'success');
    show('#ai-lang', lang, { y: 8 });
    tw('#kd1 .hl, #kd2 .hl', { opacity: 1 }, { opacity: 0, duration: 0.4 }, lang - 0.2);
    tw('#kd4 .hl', { opacity: 0 }, { opacity: 1, duration: 0.25 }, lang + 0.1);
    DER.push((t) => { $('#ans3').firstElementChild.nextSibling.textContent = t < lang + 0.5 ? ' Fee structure, Batch timings' : ' Branches and location'; $('#ans3t').textContent = t < lang + 0.5 ? 'Replied in 3.8 s' : 'Replied in 2.9 s, in Tamil'; });
  }

  // ======================= s04 · handover =======================
  {
    const v = 'vo05', v6 = 'vo06', st = S.s04.start;
    // the carried-over chat: everything up to the Tamil reply is already on screen
    ['y2', 'y5'].forEach((k) => initFrom(`#p4-${k}`, { height: 0 }));
    readAt['p4-i1'] = 0; readAt['p4-i4'] = 0;
    ['i7', 'y8', 'i9', 'd10', 'i11'].forEach((k) => initFrom(`#p3-${k}`, { height: 0 }));
    words('#s04-copy .headline .w', st + 0.1, 0.06);
    show('#s04-copy .kicker', st, { y: 12 });
    show('#s04-copy .chip', st + 0.55, { y: 14, stagger: 0.1 });
    msgIn('p4', 'i7', wt(v, 'goes') - 0.1, 'send');
    readAt['p4-i7'] = wt(v, 'guess');
    const hands = wt(v, 'hands');
    typingFor('p4', 'y8', wt(v, 'guess') - 0.1, hands);
    msgIn('p4', 'i9', hands, 'pop');
    tw('#mini4', { opacity: 0, x: 140, rotationY: -18, transformPerspective: 1600 }, { opacity: 1, x: 0, rotationY: 0, duration: 0.85, ease: 'expo.out' }, hands - 0.2);
    cue(hands - 0.2, 'swish', { gain: 0.5 });
    show('#row4', hands + 0.25, { y: 10 });
    punch('#b-need', hands + 0.6, 1.1);
    punch('#qt-need', hands + 0.6, 1.1);
    cue(hands + 0.6, 'tick', { gain: 0.6 });
    show('#ctx4 .ln', wt(v, 'full') - 0.1, { y: 10, stagger: 0.14 });
    const click = wt(v6, 'steps') + 0.05;
    const P = CUR.assign;
    master.set('#cur4', { x: P.cx + 160, y: P.cy + 140 }, click - 1.0);
    tw('#cur4', { opacity: 0 }, { opacity: 1, duration: 0.2 }, click - 1.0);
    tw('#cur4', { x: P.cx + 160, y: P.cy + 140 }, { x: P.cx - 8, y: P.cy - 6, duration: 0.75, ease: 'power2.inOut' }, click - 0.8);
    tw('#cur4', { scale: 1 }, { scale: 0.82, duration: 0.08, yoyo: true, repeat: 1 }, click);
    master.set('#rip4', { x: P.cx, y: P.cy }, click);
    tw('#rip4', { opacity: 0.9, scale: 0.4 }, { opacity: 0, scale: 1.7, duration: 0.5, ease: 'power2.out' }, click);
    punch('#assign4', click, 0.94);
    cue(click, 'click', { gain: 0.8 });
    tw('#cur4', { opacity: 1 }, { opacity: 0, duration: 0.3 }, click + 0.9);
    master.set('#b-need', { display: 'none' }, click + 0.1);
    master.set('#b-asg', { display: 'inline-flex' }, click + 0.1);
    master.set('#row4', { attr: { class: 'row' } }, click + 0.1);
    show('#b-asg', click + 0.1, { s: 0.8, y: 0, d: 0.3 });
    const back = wt(v6, 'back');
    show('#aip4', wt(v6, 'assistant'), { y: 10, s: 0.9 });
    cue(wt(v6, 'assistant'), 'tick', { gain: 0.5 });
    msgIn('p4', 'd10', back + 0.1, null);
    msgIn('p4', 'i11', back + 0.45, 'pop');
  }
  // typing dots, "typing…" header, read ticks
  DER.push((t) => {
    $$('.typing').forEach((el) => { el.querySelectorAll('b').forEach((d, i) => { d.style.transform = `translateY(${-4 * Math.max(0, Math.sin(t * 9 - i * 0.9))}px)`; }); });
    ['p3', 'p4'].forEach((p) => {
      const on = typingRanges[p].some(([a, b]) => t >= a && t < b);
      const root = $(p === 'p3' ? '#ph3' : '#ph4');
      root.querySelector('.typ').style.opacity = on ? '1' : '0';
      root.querySelector('.onl').style.opacity = on ? '0' : '1';
    });
    Object.entries(readAt).forEach(([id, at]) => { $$(`#${id} .tk path`).forEach((pp) => pp.setAttribute('stroke', t >= at ? '#53BDEB' : '#8696A0')); });
  });

  // ======================= s05 · bring your own agent =======================
  {
    const v7 = 'vo07', v = 'vo08', st = S.s05.start;
    show('#s05 .center-copy .kicker', st, { y: 10 });
    words('#s05-h .w', st + 0.1, 0.07);
    tw('#con', { opacity: 0, x: -140, rotationY: 16, transformPerspective: 1600 }, { opacity: 1, x: 0, rotationY: 0, duration: 0.9, ease: 'expo.out' }, st + 0.05);
    sheenAt('#con .sheen', st + 0.5);
    const PROMPT = 'Remind every customer whose invoice is due today';
    const pa = wt(v7, 'Building'), pb = wt(v7, 'agents', 0, true) + 0.2;
    cue(pa, 'typing', { dur: pb - pa, gain: 0.5 });
    DER.push((t) => {
      const n = Math.floor(prog(t, pa, pb) * PROMPT.length);
      $('#ptext').textContent = PROMPT.slice(0, n);
      $('#caret').style.opacity = t < pb ? '1' : (Math.floor(t * 2.4) % 2 ? '0' : '1');
    });
    const plug = wt(v7, 'Plug');
    tw('#src1, #src2, #src3, #src4', { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out', stagger: 0.08 }, plug - 0.2);
    tw('#hub5', { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'back.out(1.8)' }, plug);
    draw('e5-c', plug + 0.1, 0.35);
    const snap = wt(v7, 'in');
    show('#con-on', snap, { y: 0, s: 0.8, d: 0.35 });
    tw('#hp5', { opacity: 0.9, scale: 1 }, { opacity: 0, scale: 1.9, duration: 0.8, ease: 'power2.out' }, snap);
    cue(snap, 'impact', { gain: 0.45 });
    show('#think', snap + 0.4, { y: 8 });
    const srcAt = [wt(v, 'MCP'), wt(v, 'API'), wt(v, 'eight'), wt(v, 'Zapier')];
    srcAt.forEach((at, i) => {
      tw(`#src${i + 1} .on`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, at - 0.05);
      punch(`#src${i + 1}`, at, 1.07);
      draw('e5-' + (i + 1), at, 0.5);
      cue(at, 'tick', { gain: 0.55 });
    });
    [['#tc1', wt(v, 'send')], ['#tc2', wt(v, 'read')], ['#tc3', wt(v, 'templates')]].forEach(([s, at]) => {
      tw(s, { opacity: 0, x: -24, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }, { opacity: 1, x: 0, height: TCH[s], marginTop: 14, paddingTop: 14, paddingBottom: 14, duration: 0.45, ease: 'power3.out' }, at - 0.1);
      tw(s + ' .ok', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'back.out(2)' }, at + 0.35);
      cue(at + 0.35, 'success', { gain: 0.35 });
    });
    const own = wt(v, 'own');
    [1, 2, 3].forEach((i) => draw('e5-o' + i, own - 0.2 + i * 0.1, 0.5));
    [1, 2, 3].forEach((i) => {
      const at = own + 0.15 + (i - 1) * 0.18;
      tw('#mc' + i, { opacity: 0, x: 60, scale: 0.92 }, { opacity: 1, x: 0, scale: 1, duration: 0.55, ease: 'back.out(1.5)' }, at);
      cue(at, 'send', { gain: 0.45 });
    });
    show('#num5', wt(v, 'number'), { y: 10 });
    // packets: sources -> hub, then hub -> customers
    const lanes = [['e5-1', srcAt[0]], ['e5-2', srcAt[1]], ['e5-3', srcAt[2]], ['e5-4', srcAt[3]], ['e5-o1', own + 0.4], ['e5-o2', own + 0.55], ['e5-o3', own + 0.7]];
    const pks = $$('#s05 .packet');
    DER.push((t) => {
      pks.forEach((el, i) => {
        const [pid, t0] = lanes[i % lanes.length];
        const lane2 = lanes[(i + 3) % lanes.length];
        let shown = false;
        [[pid, t0, 0], [lane2[0], lane2[1], 0.5]].some(([id, a, off]) => {
          if (t < a + off || t > S.s05.end + 0.3) return false;
          const f = ((t - a - off) / 0.9) % 1;
          const pt = $('#' + id).getPointAtLength(LEN[id] * f);
          el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
          el.style.opacity = String(Math.sin(Math.PI * f));
          shown = true;
          return true;
        });
        if (!shown) el.style.opacity = '0';
      });
    });
  }

  // ======================= s06 · guardrails =======================
  {
    const v = 'vo09', st = S.s06.start;
    show('#s06 .center-copy .kicker', st, { y: 10 });
    words('#s06-h .w', st + 0.1, 0.07);
    draw('lane', st + 0.2, 1.0);
    show('#g-src', st + 0.2, { y: 20 });
    show('#gate1, #gate2, #gate3', st + 0.3, { y: 60, stagger: 0.12, d: 0.7 });
    show('#g-end', st + 0.7, { y: 20 });
    const X0 = 200, X1 = 1715, VEL = 640, G = [575, 960, 1345];
    const kApp = wt(v, 'Approved'), kOpt = wt(v, 'Opted'), kMeta = wt(v, 'official');
    const special = [{ t0: kApp - (G[0] - 120 - X0) / VEL, fate: 'bad' }, { t0: kOpt - (G[1] - X0) / VEL, fate: 'skip' }];
    const pk = [];
    for (let t0 = wt(v, 'every') - 0.4; t0 < S.s06.end - 1.6; t0 += 0.62) if (special.every((s) => Math.abs(s.t0 - t0) > 0.32)) pk.push({ t0, fate: 'pass' });
    special.forEach((s) => pk.push(s));
    pk.sort((a, b) => a.t0 - b.t0);
    const envs = $$('#envs .env');
    const stopX = G[0] - 120;
    const tBad = special[0].t0 + (stopX - X0) / VEL, tSkip = special[1].t0 + (G[1] - X0) / VEL;
    tw('#rt1', { opacity: 0, y: -10, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(2)' }, tBad);
    cue(tBad, 'error', { gain: 0.5 });
    tw('#lane-skip', { opacity: 0 }, { opacity: 1, duration: 0.3 }, tSkip - 0.3);
    tw('#rt2', { opacity: 0, y: -10, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(2)' }, tSkip + 0.55);
    cue(tSkip + 0.3, 'low', { gain: 0.35 });
    tw('#mb6', { opacity: 0, y: 16, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'back.out(1.8)' }, kMeta);
    cue(kMeta, 'success', { gain: 0.5 });
    const skipPath = $('#lane-skip');
    const KEY = [kApp, kOpt, kMeta];
    DER.push((t) => {
      envs.forEach((el, i) => {
        const p = pk[i];
        if (!p || t < p.t0) { el.style.opacity = '0'; return; }
        let x = X0 + (t - p.t0) * VEL, y = 640, o = 1, rot = 0, cls = 'env';
        if (p.fate === 'bad' && x >= stopX) { const k = t - tBad; x = stopX - Math.min(40, k * 120); y = 640 + Math.max(0, k - 0.4) * 160; o = Math.max(0, 1 - Math.max(0, k - 0.6) * 1.6); rot = -k * 18; cls = 'env bad'; }
        if (p.fate === 'skip' && x >= G[1]) { const f = Math.min(1, (t - tSkip) / 0.9); const pt = skipPath.getPointAtLength(LEN['lane-skip'] * f); x = pt.x; y = pt.y; o = 1 - Math.max(0, (t - tSkip - 0.9) * 2); cls = 'env skip'; }
        if (p.fate === 'pass' && x > X1) o = Math.max(0, 1 - (x - X1) / 60);
        el.className = cls;
        el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
        el.style.opacity = String(Math.max(0, Math.min(o, (t - p.t0) * 5)));
      });
      // a gate glows when a message is passing through it, and holds after its word is spoken
      G.forEach((gx, gi) => {
        let lit = 0;
        pk.forEach((p) => {
          if (p.fate === 'bad' && gi > 0) return;
          if (p.fate === 'skip' && gi > 1) return;
          const x = X0 + (t - p.t0) * VEL;
          lit = Math.max(lit, 1 - Math.min(1, Math.abs(x - gx) / 150));
        });
        const k = KEY[gi];
        if (t >= k) lit = Math.max(lit, t < k + 1.3 ? 1 : 0.45);
        $(`#gate${gi + 1} .lit`).style.opacity = String(lit * prog(t, S.s06.start + 0.4, S.s06.start + 1.0));
      });
      const arr = pk.filter((p) => p.fate === 'pass').map((p) => p.t0 + (X1 - 40 - X0) / VEL);
      const near = arr.some((a) => t >= a && t < a + 0.25);
      $('#g-end').style.transform = `scale(${near ? 1.06 : 1})`;
    });
    pk.filter((p) => p.fate === 'pass').forEach((p) => cue(p.t0 + (X1 - 40 - X0) / VEL, 'tick', { gain: 0.18 }));
  }

  // ======================= s07 · shared inbox =======================
  {
    const v = 'vo10', st = S.s07.start;
    show('#s07 .copy .kicker', st, { y: 12 });
    words('#s07 .headline .w', st + 0.1, 0.07);
    show('#s07 .chip', st + 0.5, { y: 14, stagger: 0.1 });
    tw('#win7', { opacity: 0, rotationY: -26, rotationX: 6, x: 140 }, { opacity: 1, rotationY: -9, rotationX: 2, x: 0, duration: 1.1, ease: 'expo.out' }, st - 0.1);
    tw('#win7', { rotationY: -9 }, { rotationY: -4, duration: S.s07.end - st, ease: 'none' }, st + 1.0);
    gsap.set('#win7', { transformOrigin: '100% 50%' });
    const ai = wt(v, 'AI');
    tw('#crows7 .glow:not(.w)', { opacity: 0 }, { opacity: 1, duration: 0.25, stagger: 0.09, yoyo: true, repeat: 1 }, ai - 0.1);
    punch('#c7a', ai, 1.08);
    punch('#cb7a, #cb7b', ai + 0.2, 1.05);
    cue(ai, 'tick', { gain: 0.5 });
    const ho = wt(v, 'handover');
    tw('#crows7 .glow.w', { opacity: 0 }, { opacity: 1, duration: 0.3 }, ho - 0.1);
    punch('#tab-need', ho, 1.12);
    punch('#c7b', ho, 1.08);
    show('#hand7', ho + 0.1, { y: 8 });
    cue(ho, 'tick', { gain: 0.5 });
    const cost = wt(v, 'cost');
    punch('#c7c', cost, 1.08);
    show('#cost7a, #cost7b', wt(v, 'each') - 0.1, { y: 4, stagger: 0.12 });
    [['#ft1', 0], ['#ft2', 0.14], ['#ft3', 0.28]].forEach(([s, d]) => tw(s, { opacity: 0, y: 70, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, wt(v, 'Every') + d));
    cue(wt(v, 'Every'), 'swish', { gain: 0.35 });
    const c0 = wt(v, 'Every') + 0.2;
    DER.push((t) => {
      const p = eio(prog(t, c0, c0 + 1.6)), pc = eio(prog(t, cost - 0.2, cost + 1.0));
      $('#v7a').textContent = fmt(412 * p);
      $('#v7b').textContent = fmt(38 * p);
      $('#v7c').textContent = '₹' + fmt(136 * pc);
    });
  }

  // ======================= s08 · campaigns + flows =======================
  {
    const v = 'vo11', st = S.s08.start;
    show('#s08 .center-copy .kicker', st, { y: 10 });
    words('#s08 .headline .w', st + 0.1, 0.07);
    const la = wt(v, 'Launch');
    tw('#win8a', { opacity: 0, rotationY: 24, x: -120 }, { opacity: 1, rotationY: 7, x: 0, duration: 1.0, ease: 'expo.out' }, Math.min(la - 0.35, st + 0.1));
    gsap.set('#win8a', { transformOrigin: '0% 50%' });
    cue(la - 0.35, 'swish', { gain: 0.4 });
    const STEP = [0, 1, 2, 3, 4].map((i) => la + 0.15 + i * 0.28);
    STEP.forEach((s) => cue(s, 'tick', { gain: 0.35 }));
    const lis = $$('#wiz8 li');
    DER.push((t) => { lis.forEach((li, i) => { li.className = 'wizard-step-indicator' + (t >= STEP[i] + 0.28 && i < 4 ? ' done' : t >= STEP[i] ? (i === 4 ? ' done' : ' active') : ''); }); });
    show('#b8live', STEP[4] + 0.3, { y: 0, s: 0.8 });
    const bu = wt(v, 'build');
    tw('#win8b', { opacity: 0, rotationY: -24, x: 120 }, { opacity: 1, rotationY: -7, x: 0, duration: 1.0, ease: 'expo.out' }, Math.min(bu - 0.3, st + 0.45));
    gsap.set('#win8b', { transformOrigin: '100% 50%' });
    cue(bu - 0.3, 'swish', { gain: 0.4 });
    show('#fn1, #fn2, #fn3, #fn4', bu + 0.1, { y: 14, s: 0.9, stagger: 0.14, ease: 'back.out(1.8)' });
    draw('ed1', bu + 0.35, 0.4); draw('ed2', bu + 0.55, 0.45); draw('ed3', bu + 0.6, 0.45);
    const sent = wt(v, 'sent'), read = wt(v, 'read');
    const bars = [['#f8a', '#n8a', 2400, 100, sent - 0.1], ['#f8b', '#n8b', 2352, 98, sent + 0.3], ['#f8c', '#n8c', 1876, 78, read - 0.1]];
    bars.forEach(([f, , , pct, at]) => { tw(f, { width: '0%' }, { width: pct + '%', duration: 0.9, ease: 'power3.out' }, at); cue(at, 'tick', { gain: 0.45 }); });
    DER.push((t) => { bars.forEach(([, n, val, , at]) => { $(n).textContent = fmt(val * e3(prog(t, at, at + 0.9))); }); });
    cue(read + 0.6, 'success', { gain: 0.45 });
  }

  // ======================= s09 · recap =======================
  {
    const v = 'vo12';
    [['#ro1', wt(v, 'agents')], ['#ro2', wt(v, 'team')], ['#ro3', wt(v, 'customers')]].forEach(([s, at]) => {
      tw(s, { opacity: 0, y: 60, scale: 0.7 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'back.out(1.7)' }, at - 0.15);
      cue(at - 0.15, 'pop', { gain: 0.5 });
    });
    const all = wt(v, 'All');
    tw('#ro1', { x: 0 }, { x: 570, scale: 0.4, opacity: 0, duration: 0.55, ease: 'power3.in' }, all - 0.2);
    tw('#ro3', { x: 0 }, { x: -570, scale: 0.4, opacity: 0, duration: 0.55, ease: 'power3.in' }, all - 0.2);
    tw('#ro2', { scale: 1 }, { scale: 0.4, opacity: 0, duration: 0.55, ease: 'power3.in' }, all - 0.2);
    tw('#onewa', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'back.out(1.6)' }, all + 0.3);
    tw('#flash', { opacity: 0 }, { opacity: 0.55, duration: 0.1 }, all + 0.32);
    tw('#flash', { opacity: 0.55 }, { opacity: 0, duration: 0.7 }, all + 0.42);
    cue(all + 0.3, 'impact', { gain: 0.6 });
  }

  // ======================= s10 · close =======================
  {
    const v = 'vo13', v14 = 'vo14', st = S.s10.start;
    const w = wt(v, 'Wasi');
    tw('#rays10', { opacity: 0, scale: 0.5 }, { opacity: 0.8, scale: 1, duration: 2.0, ease: 'expo.out' }, st);
    tw('#lockup2', { opacity: 0, scale: 0.85, filter: 'blur(12px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.9, ease: 'expo.out' }, w - 0.2);
    tw('#lockup2', { scale: 1 }, { scale: 1.035, duration: DUR - w, ease: 'none' }, w + 0.7);
    cue(w - 0.2, 'chime', { gain: 0.9 });
    words('#tag10 .w', wt(v, 'Your') - 0.1, 0.09);
    show('#cta', VO[v14].start - 0.1, { y: 24, d: 0.6 });
    punch('#go', wt(v14, 'wasi'), 1.06);
    cue(wt(v14, 'wasi'), 'tick', { gain: 0.5 });
    show('#cbadges .chip', wt(v14, 'com') + 0.2, { y: 16, stagger: 0.12 });
    tw('#endblack', { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power1.in' }, DUR - 0.9);
  }

  // ======================= continuous layers =======================
  // light sweep across a glass card, once, at a chosen moment
  function sheenAt(sel, at) { const el = $(sel); DER.push((t) => { el.style.setProperty('--sx', `${-60 + 220 * eio(prog(t, at, at + 1.3))}%`); }); }
  DER.push((t) => {
    $('#aur1').style.transform = `translate(${Math.sin(t * 0.13) * 140}px, ${Math.cos(t * 0.11) * 80}px)`;
    $('#aur2').style.transform = `translate(${Math.cos(t * 0.09) * 160}px, ${Math.sin(t * 0.12) * 90}px)`;
    $('#aur3').style.transform = `translate(${Math.sin(t * 0.07 + 1) * 220}px, ${Math.cos(t * 0.1) * 120}px) scale(${1 + 0.12 * Math.sin(t * 0.2)})`;
    $('#grid').style.transform = `translateY(${(t * 6) % 80}px)`;
    const parts = $('#particles').children;
    PARTS.forEach((p, i) => {
      const y = ((p.y - t * p.v) % 1080 + 1080) % 1080, x = p.x + Math.sin(t * 0.4 + p.ph) * 24;
      parts[i].style.transform = `translate(${x}px, ${y}px)`;
      parts[i].style.opacity = String(p.a * (0.6 + 0.4 * Math.sin(t * 1.3 + p.ph)));
    });
    ['#orb1', '#orb2'].forEach((o) => {
      const r = $(o);
      r.querySelector('.r1').style.transform = `rotate(${t * 36}deg)`;
      r.querySelector('.r2').style.transform = `rotate(${-t * 14}deg) scale(${1 + 0.03 * Math.sin(t * 2)})`;
      r.querySelector('.r3').style.transform = `scale(${1 + 0.05 * Math.sin(t * 1.4)})`;
      r.querySelector('.core').style.filter = `brightness(${1 + 0.12 * Math.sin(t * 2.6)})`;
    });
    const a = t * 1.15;
    $('#sat1').style.transform = `translate(${Math.sin(a) * 170}px, ${170 - Math.cos(a) * 170}px)`;
  });
  // footnote on product scenes (UI shows illustrative data)
  const productRanges = ['s03', 's04', 's05', 's07', 's08'].map((id) => [S[id].start, S[id].end]);
  DER.push((t) => { $('#footnote').style.opacity = productRanges.some(([a, b]) => t >= a + 0.4 && t <= b - 0.2) ? '1' : '0'; });

  master.set({}, {}, DUR); // pad the timeline to the full film length
  window.CUES = CUES.sort((a, b) => a.t - b.t);
  window.__FILM_DURATION__ = DUR;
  window.__seek = function (t) { master.seek(t, false); DER.forEach((f) => f(t)); };
  window.__seek(0);
  window.__ready = true;
}).catch((e) => { console.error(e); window.__error = String(e && e.stack || e); }));
