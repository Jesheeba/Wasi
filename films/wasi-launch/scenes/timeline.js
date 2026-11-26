// Master GSAP timeline, paused and driven only by window.__seek(t), so every frame is
// deterministic. Beats are keyed to the exact WORD the voice is on (wt(id, word)),
// from the per-character timings of the continuous ElevenLabs take, so a new read
// re-times the picture by itself. Continuous things (chat feeds, typing, counters,
// background drift) are pure functions of t in DER[], never callbacks.
// Motion language: one easing family (expo/power3 out), masked word reveals, slow
// camera pushes, soft cross-dissolves. No particles, flashes or glows.
// window.CUES lists every sound-effect instant for make-sfx.js.
window.addEventListener('load', () => Promise.all([
  document.fonts.ready,
  document.fonts.load('600 100px Poppins', 'Wasi'),
  document.fonts.load('700 100px Poppins', 'Wasi'),
  document.fonts.load('500 16px Inter', 'Wasi'),
  document.fonts.load('400 16px "Noto Sans Tamil"', 'தமிழ்'),
  document.fonts.load('400 20px "JetBrains Mono"', 'wasi'),
]).then(function () {
  const T = window.TIMING, VO = window.VO_BY_ID, S = T.scenes, DUR = T.FILM_DURATION;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const prog = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1));
  const e3 = (p) => 1 - Math.pow(1 - p, 3);
  const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const fmtIN = (n) => Math.round(n).toLocaleString('en-IN');
  gsap.defaults({ lazy: false });
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
  const rise = (sel, at, o = {}) => tw(sel, { opacity: 0, y: o.y ?? 36, scale: o.s ?? 1 }, { opacity: 1, y: 0, scale: 1, duration: o.d ?? 0.9, ease: 'expo.out', stagger: o.stagger ?? 0 }, at);
  const leave = (sel, at, o = {}) => tw(sel, { opacity: 1, y: 0 }, { opacity: 0, y: o.y ?? -28, duration: o.d ?? 0.5, ease: 'power2.in' }, at);
  // masked word reveal: every word slides up out of its own clip box
  const reveal = (sel, at, st = 0.055) => { tw(sel, { opacity: 0 }, { opacity: 1, duration: 0.01 }, at); return tw(`${sel} .w`, { yPercent: 115 }, { yPercent: 0, duration: 1.0, ease: 'expo.out', stagger: st }, at); };

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9஀-௿]/g, '');
  function wt(id, needle, k = 0, end = false) {
    const n = norm(needle);
    let c = 0;
    for (const w of VO[id].words) if (norm(w.w).startsWith(n) && c++ === k) return end ? w.e : w.s;
    throw new Error(`word "${needle}" #${k} not found in ${id}`);
  }

  // wrap every word of an element in <span class="m"><span class="w">, keeping inner markup
  function split(el) {
    Array.from(el.childNodes).forEach((n) => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
          const m = document.createElement('span'); m.className = 'm';
          const w = document.createElement('span'); w.className = 'w'; w.textContent = part;
          m.appendChild(w); frag.appendChild(m);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== 'BR') split(n);
    });
  }
  $$('.split').forEach(split);

  // ======================= the app's own markup =======================
  function sidebar(active) {
    const d = document.createElement('div');
    d.innerHTML = window.APP_SIDEBAR;
    const sb = d.firstElementChild;
    $$('.nav-item.active', sb).forEach((n) => n.classList.remove('active'));
    const a = $(`.nav-item[data-view="${active}"]`, sb);
    if (a) a.classList.add('active');
    const prof = $$('.nav-item', sb).pop();
    if (prof) { const av = $('.avatar', prof), tx = $('.nav-text', prof); if (av) av.textContent = 'P'; if (tx) tx.textContent = 'Priya'; }
    return sb.outerHTML;
  }
  $$('.sbslot').forEach((s) => { s.outerHTML = sidebar(s.dataset.active); });

  const BAR = '<div class="bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="url"><i data-lucide="lock"></i>wasi.sirahagents.com</span></div>';
  const ini = (n) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  function chatItem(c, active) {
    const pill = c.pill === 'needs' ? '<span class="chat-assign-pill is-needs-person">Needs a person</span>'
      : c.pill ? `<span class="chat-assign-pill is-assigned">${c.pill}</span>` : '';
    return `<div class="chat-item${active ? ' active' : ''}${c.unread ? ' has-unread' : ''}" data-name="${c.name}">
      <div class="chat-avatar">${ini(c.name)}</div>
      <div class="chat-item-main"><div class="chat-item-name">${c.name}</div><div class="chat-item-sub"><span>WhatsApp</span>${pill}</div></div>
      <div class="chat-item-side"><span class="chat-item-time">${c.time}</span>${c.unread ? `<span class="chat-unread-badge">${c.unread}</span>` : ''}</div></div>`;
  }
  const TICK = '<svg class="icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>';
  function bubble(m) {
    const ai = m.ai ? '<span class="msg-ai-label">✨ Assistant</span>' : '';
    const st = m.dir === 'out' ? `<span class="msg-status" style="color:#53BDEB;display:inline-flex">${TICK}</span>` : '';
    return `<div class="msg-group msg-group-${m.dir}"><div class="msg-bubble msg-${m.dir}"><div>${m.body}</div><div class="msg-time">${ai}<time class="msg-time-value">${m.time}</time>${st}</div></div></div>`;
  }
  function inbox(el, cfg) {
    const act = cfg.chats[cfg.active];
    el.innerHTML = BAR + `<div class="appbody">${sidebar('chat')}<div class="appmain"><main class="main-content" style="padding:0;height:100%"><div id="view-chat" class="view-container active chat-view"><div class="chat-layout">
      <div class="chat-list-panel">
        <div class="chat-list-header"><h2 class="chat-list-title">Conversations</h2><div class="chat-list-header-actions"><button class="btn-secondary chat-tool-btn"><i data-lucide="sliders-horizontal" class="icon-14"></i> <span>Filters</span></button><button class="btn-secondary chat-tool-btn chat-tool-btn-icon"><i data-lucide="plus" class="icon-14"></i></button></div></div>
        <div class="chat-search"><i data-lucide="search" class="icon-14 chat-search-icon"></i><input class="chat-search-input" placeholder="Search by name or number" /></div>
        <div class="chat-queue-tabs">${['Unassigned', 'Mine', 'All', 'Needs a person', 'Resolved'].map((q) => `<button class="queue-tab-btn${q === 'All' ? ' active' : ''}">${q}</button>`).join('')}</div>
        <div class="chat-list">${cfg.chats.map((c, i) => chatItem(c, i === cfg.active)).join('')}</div>
      </div>
      <div class="chat-workspace"><div class="chat-conversation">
        <div class="chat-header"><div class="chat-header-who"><div class="chat-avatar">${ini(act.name)}</div><div class="chat-header-text"><div class="chat-header-name">${act.name}</div>
          <div class="chat-header-sub"><span class="chat-header-channel">WhatsApp Business</span><span class="chat-ai-note"></span></div></div></div>
          <div class="chat-header-actions"><span class="badge badge-success">Open</span><button class="btn-secondary chat-primary-action"><i data-lucide="check-circle-2" class="icon-14"></i> Resolve</button><button class="btn-secondary chat-icon-btn"><i data-lucide="more-horizontal"></i></button><button class="btn-secondary chat-icon-btn"><i data-lucide="panel-right"></i></button></div></div>
        <div class="chat-messages" style="position:relative;flex:1"><div class="chat-date-separator abs" style="left:0;right:0;top:18px"><span>Today</span></div>${cfg.msgs.map(bubble).join('')}</div>
        <div class="chat-composer"><div class="chat-input-bar"><button class="btn-secondary chat-attach-btn"><i data-lucide="paperclip"></i></button><input class="chat-input" placeholder="Type a message or '/' for templates..." /><button class="btn-primary chat-send-btn"><i data-lucide="send"></i></button></div></div>
      </div></div></div></div></main></div></div>`;
  }

  const CHATS4 = [
    { name: 'Karthik S', time: '8:43 am', unread: 1 },
    { name: 'Ananya R', time: '8:31 am', pill: 'Priya' },
    { name: 'Fathima N', time: '8:12 am' },
    { name: 'Rahul V', time: 'Yesterday' },
    { name: 'Sneha M', time: 'Yesterday', pill: 'Arun' },
    { name: 'Vignesh S', time: 'Yesterday' },
    { name: 'Lakshmi K', time: 'Mon' },
  ];
  inbox($('#aw4'), { chats: CHATS4, active: 0, msgs: [
    { dir: 'in', body: 'Hi, what are the weekend batch fees?', time: '8:41 am' },
    { dir: 'out', body: 'The weekend batch is ₹12,000 for 3 months. Classes run Saturday and Sunday, 9 am to 1 pm.', time: '8:41 am', ai: true },
    { dir: 'in', body: 'Can I pay it in two parts?', time: '8:43 am' },
    { dir: 'out', body: 'Yes! Pay ₹6,000 now and ₹6,000 next month.', time: '9:05 am' },
  ] });
  inbox($('#aw7'), { chats: [
    { name: 'Ananya R', time: '9:12 am' },
    { name: 'Karthik S', time: '9:05 am', pill: 'Priya' },
    { name: 'Deepa J', time: '8:58 am', pill: 'needs' },
    { name: 'Fathima N', time: '8:12 am' },
    { name: 'Rahul V', time: 'Yesterday' },
    { name: 'Sneha M', time: 'Yesterday', pill: 'Arun' },
    { name: 'Vignesh S', time: 'Yesterday' },
  ], active: 0, msgs: [
    { dir: 'in', body: 'Is the mock test this Sunday?', time: '9:10 am' },
    { dir: 'out', body: 'Yes, this Sunday at 10 am, at the T. Nagar centre. Please bring your hall ticket.', time: '9:10 am', ai: true },
    { dir: 'in', body: 'Is there parking nearby?', time: '9:12 am' },
    { dir: 'out', body: 'There is free parking behind the building on Usman Road.', time: '9:12 am', ai: true },
  ] });

  // the customer's phone: WhatsApp chat list (s01) and the chat with the business (s03)
  const SIG = '<svg viewBox="0 0 54 12"><g fill="#111B21"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2" width="3" height="10" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/><path d="M27 3.5a9 9 0 0 1 12 0l-1.4 1.5a7 7 0 0 0-9.2 0zM29.3 6a5.5 5.5 0 0 1 7.4 0l-1.4 1.5a3.5 3.5 0 0 0-4.6 0zM33 8.6l1.6 1.7L33 12l-1.6-1.7z"/><rect x="42" y="1" width="10" height="10" rx="2.5" fill="none" stroke="#111B21" stroke-width="1.2"/><rect x="43.6" y="2.6" width="6.8" height="6.8" rx="1.2"/></g></svg>';
  $$('.sbi').forEach((s) => { s.innerHTML = SIG; });
  const WA = [
    ['Ananya R', 'Is the blue kurta still in stock?', '#7C9CBF', 3], ['Karthik S', 'What are the fees for the weekend batch?', '#C89B6D', 2],
    ['Rahul V', 'Can I book Saturday at 11?', '#8DB596', 1], ['Fathima N', "Order #4821 hasn't arrived yet", '#B58DB0', 4],
    ['Vignesh S', 'Do you deliver to Coimbatore?', '#9CA3AF', 2], ['Sneha M', 'Price for the 2 kg pack?', '#D29F8C', 1],
    ['Lakshmi K', 'Hello? Anyone there?', '#86A8C9', 5], ['Arjun P', 'Are you open on Sunday?', '#A9B98C', 1],
  ];
  $('#walist').innerHTML = WA.map(([n, m, c]) => `<div class="wa-row"><span class="wa-av" style="background:${c}">${ini(n)}</span><div class="mid"><div class="r1"><span class="n">${n}</span><span class="tm">9:41</span></div><div class="r2"><span class="p">${m}</span><span class="u">1</span></div></div></div>`).join('');

  const WTICK = (id) => `<svg viewBox="0 0 18 11" id="${id}"><path d="M1 6l3 3 6-7M7 9l1 1 6-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  $('#msgs3').innerHTML = [
    '<div class="frow"><div class="wa-day" style="margin:0 auto;display:table">Today</div></div>',
    '<div class="frow" data-a="q"><div class="bb out" style="font-family:\'Noto Sans Tamil\',Inter">வார இறுதி batch-க்கு fees எவ்வளவு?<span class="mt">11:42 pm<span class="tk" style="color:#8696A0">' + WTICK('tk3') + '</span></span></div></div>',
    '<div class="frow" data-a="ty"><div class="bb in typing"><i></i><i></i><i></i></div></div>',
    '<div class="frow" data-a="r"><div class="bb in" style="font-family:\'Noto Sans Tamil\',Inter">வார இறுதி batch கட்டணம் ₹12,000 (3 மாதங்கள்). வகுப்புகள் சனி, ஞாயிறு காலை 9 மணி முதல் மதியம் 1 மணி வரை.<span class="mt">11:42 pm</span></div></div>',
  ].join('');

  // s05 code, as tokens so it can type with syntax colour
  const CODE = [
    [['c', '// your agent, connected through MCP']], [],
    [['k', 'await '], ['', 'wasi.'], ['f', 'call'], ['', '('], ['s', '"send_text_message"'], ['', ', {']],
    [['', '  to: '], ['s', '"+91 98765 43210"'], ['', ',']],
    [['', '  text: '], ['s', '"Your study kit ships today."'], ['', ',']],
    [['', '});']],
  ];
  const CODE_LEN = CODE.reduce((s, l) => s + l.reduce((a, [, x]) => a + x.length, 0) + 1, 0);
  function codeHtml(n) {
    let left = n, out = '';
    for (const line of CODE) {
      for (const [c, x] of line) { const part = x.slice(0, Math.max(0, left)); left -= x.length; if (part) out += c ? `<span class="${c}">${part.replace(/</g, '&lt;')}</span>` : part.replace(/</g, '&lt;'); if (left <= 0) break; }
      if (left <= 0) break;
      out += '\n'; left -= 1;
    }
    return out;
  }

  lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });

  // ======================= measure (everything at rest, cameras at identity) =======================
  const stage = $('#stage').getBoundingClientRect();
  // rect of an element relative to its scene camera, at rest
  const R = (el) => { const r = (typeof el === 'string' ? $(el) : el).getBoundingClientRect(); return { x: r.left - stage.left, y: r.top - stage.top, w: r.width, h: r.height, cx: r.left - stage.left + r.width / 2, cy: r.top - stage.top + r.height / 2 }; };
  // camera move that brings point (px,py) to (tx,ty) at scale s (cam origin = stage centre)
  const aim = (px, py, s, tx = 960, ty = 540) => ({ x: tx - 960 - s * (px - 960), y: ty - 540 - s * (py - 540), scale: s });
  // scenes are hidden; make them measurable for a moment
  const M = {
    status: R('#statuscard'), tog: R('#aitog'),
    conv4: R('#aw4 .chat-conversation'), msgs4: R('#aw4 .chat-messages'), sub4: (() => { const n = $('#aw4 .chat-ai-note'); n.className = 'chat-ai-note is-handover'; n.textContent = 'Needs a person: asked about paying in two parts'; const r = R('#aw4 .chat-header-sub'); n.className = 'chat-ai-note'; n.textContent = ''; return r; })(), list4: R('#aw4 .chat-list-panel'), send4: R('#aw4 .chat-send-btn'),
    list7: R('#aw7 .chat-list-panel'), msgs7: R('#aw7 .chat-messages'), hand7: R($$('#aw7 .chat-item')[2]),
    pane8: R('#pn2 .pane-in'), nodes8: $$('#pn2 .fnode').map(R),
  };

  // chat feed: bubbles absolutely stacked from the bottom; each one's presence p(t) eases in at
  // its arrival (and out at departure), and pushes everything above it up by its own height.
  function feed(container, rows, gap, pad) {
    const items = rows.map((r) => ({ el: r.el, a: r.a, d: r.d, h: r.el.offsetHeight }));
    items.forEach((it) => Object.assign(it.el.style, { position: 'absolute', left: pad + 'px', right: pad + 'px', bottom: pad + 'px', margin: 0 }));
    const pres = (it, t) => e3(prog(t, it.a, it.a + 0.4)) * (it.d == null ? 1 : 1 - prog(t, it.d, it.d + 0.12));
    DER.push((t) => {
      let y = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i], p = pres(it, t);
        it.el.style.transform = `translateY(${-y + (1 - p) * 14}px)`;
        it.el.style.opacity = String(p);
        y += (it.h + gap) * p;
      }
    });
  }
  function typingDots(el, a, b) {
    const dots = $$('i', el);
    DER.push((t) => { dots.forEach((d, i) => { const ph = t * 7 - i * 0.9; d.style.transform = `translateY(${t > a && t < b ? -3 * Math.max(0, Math.sin(ph)) : 0}px)`; d.style.opacity = String(0.45 + 0.55 * Math.max(0, Math.sin(ph))); }); });
  }
  function typeInto(input, text, a, b) { DER.push((t) => { input.value = text.slice(0, Math.round(text.length * prog(t, a, b))); }); }
  function counter(el, to, a, b, f = fmtIN) { DER.push((t) => { el.textContent = f(to * eio(prog(t, a, b))); }); }
  function cursorPath(cur, pts) { // pts: [{t, x, y}] in camera coords, eased between
    DER.push((t) => {
      let x = pts[0].x, y = pts[0].y;
      for (let i = 1; i < pts.length; i++) { const p = eio(prog(t, pts[i - 1].t, pts[i].t)); if (t >= pts[i - 1].t) { x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * p; y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * p; } }
      cur.style.transform = `translate(${x - 6}px, ${y - 3}px)`;
    });
  }
  const tap = (sel, x, y, at) => { $(sel).style.left = x + 'px'; $(sel).style.top = y + 'px'; tw(sel, { opacity: 0, scale: 0.4 }, { keyframes: [{ opacity: 0.9, scale: 0.8, duration: 0.08 }, { opacity: 0, scale: 1.7, duration: 0.45, ease: 'power2.out' }] }, at); cue(at, 'click', { gain: 0.6 }); };
  function ringTo(sel, r, at, d = 0.7, padd = 10) { tw(sel, { left: r.x - padd, top: r.y - padd, width: r.w + 2 * padd, height: r.h + 2 * padd }, { left: r.x - padd, top: r.y - padd, width: r.w + 2 * padd, height: r.h + 2 * padd, duration: d, ease: 'power3.inOut' }, at); }

  // ======================= scene envelopes =======================
  const IDS = Object.keys(S);
  IDS.forEach((id, i) => {
    const s = S[id];
    const inAt = i === 0 ? 0 : s.start - 0.04, outAt = s.end - 0.42; // dip: out fully, then in
    tw('#' + id, { autoAlpha: 0 }, { autoAlpha: 1, duration: i === 0 ? 0.01 : 0.5, ease: 'power2.out' }, inAt);
    if (i < IDS.length - 1) tw('#' + id, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.4, ease: 'power2.in' }, outAt);
  });
  // a slow push on every camera: barely visible, but it keeps the frame alive
  const drift = (cam, a, b, s = 1.025) => tw(cam, { scale: 1 }, { scale: s, duration: b - a, ease: 'none' }, a);

  // ---------------- s01 ----------------
  {
    const v1 = 'vo01', v2 = 'vo02';
    drift('#c01', 0, S.s01.end + 0.3, 1.03);
    reveal('#t01', 1.15, 0.07);
    cue(1.15, 'swish', { gain: 0.35 });
    $$('#pills .pill').forEach((p, i) => { const at = wt(v1, ['answer', 'follow', 'close'][i]) - 0.12; rise(p, at, { y: 30, s: 0.96 }); cue(at, 'tick', { gain: 0.4 }); });
    const but = wt(v2, 'But') - 0.25;
    leave('#t01', but); leave('#pills', but + 0.05);
    rise('#site', wt(v2, 'customers') - 0.2, { y: 60, s: 0.97, d: 1.1 });
    tw('#widget', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, ease: 'expo.out' }, wt(v2, 'chat') - 0.15);
    cue(wt(v2, 'chat') - 0.15, 'pop', { gain: 0.35 });
    const th = wt(v2, "They're") - 0.3;
    tw('#site', { x: 0, scale: 1, opacity: 1 }, { x: -300, scale: 0.9, opacity: 0.45, duration: 1.0, ease: 'power3.inOut' }, th);
    tw('#ph1', { opacity: 0, x: 220 }, { opacity: 1, x: 0, duration: 1.1, ease: 'expo.out' }, th + 0.05);
    cue(th, 'swish', { gain: 0.3 });
    // unread messages keep landing
    const rows = $$('#walist .wa-row'), base = th + 0.4;
    DER.push((t) => {
      let total = 0;
      rows.forEach((r, i) => { const n = Math.min(WA[i][3], Math.floor(Math.max(0, (t - base - i * 0.12) * 3.2))) + 1; $('.u', r).textContent = n; total += n; });
      $('#unreadchip').textContent = `Unread ${Math.max(total, 9) + Math.floor(Math.max(0, t - base) * 18)}`;
    });
  }

  // ---------------- s02 ----------------
  {
    const v = 'vo03';
    drift('#c02', S.s02.start - 0.3, S.s02.end + 0.3, 1.03);
    reveal('#t02', wt(v, 'So') - 0.15, 0.06);
    tw('#t02 .hl', { backgroundSize: '0% .32em' }, { backgroundSize: '100% .32em', duration: 0.7, ease: 'power2.inOut' }, wt(v, 'safe'));
    const meet = wt(v, 'Meet') - 0.3;
    leave('#t02', meet, { d: 0.45 });
    tw('#lock1 img', { opacity: 0, scale: 0.82, rotate: -8 }, { opacity: 1, scale: 1, rotate: 0, duration: 1.2, ease: 'expo.out' }, meet + 0.15);
    tw('#lock1 .wm span', { opacity: 0, y: 46 }, { opacity: 1, y: 0, duration: 1.0, ease: 'expo.out', stagger: 0.06 }, wt(v, 'Wasi') - 0.18);
    cue(meet + 0.15, 'chime', { gain: 0.55 });
  }

  // ---------------- s03 ----------------
  {
    const v = 'vo04';
    const st = S.s03.start;
    rise('#aw3', st - 0.3, { y: 50, s: 0.98, d: 1.1 });
    const card = M.status, tog = M.tog;
    const z = aim(card.cx, card.cy, 1.55, 960, 560);
    tw('#c03', { x: 0, y: 0, scale: 1 }, { x: z.x, y: z.y, scale: z.scale, duration: 1.3, ease: 'power3.inOut' }, st + 0.1);
    const click = wt(v, 'assistant') - 0.12;
    tw('#cur3', { opacity: 0 }, { opacity: 1, duration: 0.25 }, st + 0.6);
    cursorPath($('#cur3'), [{ t: st + 0.6, x: tog.cx + 160, y: tog.cy + 120 }, { t: click - 0.05, x: tog.cx + 4, y: tog.cy + 2 }]);
    tap('#tap3', tog.cx, tog.cy, click);
    const togEl = $('#aitog'), lbl = $('#aitoglbl');
    DER.push((t) => { togEl.checked = t >= click; lbl.textContent = t >= click ? 'On' : 'Off'; });
    const ans = wt(v, 'answers') - 0.45;
    tw('#cur3', { opacity: 1 }, { opacity: 0, duration: 0.2 }, ans - 0.2);
    tw('#c03', { x: z.x, y: z.y, scale: z.scale }, { x: 0, y: 0, scale: 1, duration: 1.0, ease: 'power3.inOut' }, ans);
    tw('#aw3', { opacity: 1 }, { opacity: 0, duration: 0.6, ease: 'power2.in' }, ans);
    rise('#ph3', ans + 0.35, { y: 70, d: 1.1 });
    rise('#kcard', ans + 0.5, { y: 40, d: 1.1 });
    // the chat: question lands, the assistant types, the answer lands (customer's ticks go blue)
    const q = ans + 0.65, ty = q + 0.55, r = wt(v, 'knowledge') + 0.1;
    const rowsEl = $$('#msgs3 .frow');
    feed($('#msgs3'), [{ el: rowsEl[0], a: -1 }, { el: rowsEl[1], a: q }, { el: rowsEl[2], a: ty, d: r - 0.05 }, { el: rowsEl[3], a: r }], 6, 12);
    typingDots($('.typing', rowsEl[2]), ty, r);
    DER.push((t) => { $('#tk3').style.color = t >= r ? '#53BDEB' : '#8696A0'; });
    cue(q, 'send', { gain: 0.35 }); cue(r, 'pop', { gain: 0.45 });
    ['kr1', 'kr2', 'kr3'].forEach((k, i) => {
      const at = wt(v, ['Fees', 'timings', 'orders'][i]) - 0.15;
      tw('#' + k, { opacity: 0.35 }, { opacity: 1, duration: 0.35 }, at);
      tw(`#${k} .ok`, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(2)' }, at + 0.1);
      tw('#' + k, { borderColor: '#EEF0EB' }, { borderColor: '#A7E8BE', duration: 0.35 }, at);
      cue(at + 0.1, 'tick', { gain: 0.35 });
    });
    [['km1', 'seconds'], ['km2', 'hour'], ['km3', 'language']].forEach(([k, w]) => rise('#' + k, wt(v, w) - 0.2, { y: 14, s: 0.94, d: 0.7 }));
  }

  // ---------------- s04 ----------------
  {
    const v5 = 'vo05', v6 = 'vo06', st = S.s04.start;
    rise('#aw4', st - 0.3, { y: 40, s: 0.985, d: 1.0 });
    const conv = M.conv4, msgsBox = $('#aw4 .chat-messages');
    const groups = $$('#aw4 .chat-messages .msg-group');
    const q2 = wt(v5, 'question') - 0.1, sendAt = wt(v6, 'steps') - 0.15;
    feed(msgsBox, [{ el: groups[0], a: -1 }, { el: groups[1], a: -1 }, { el: groups[2], a: q2 }, { el: groups[3], a: sendAt }], 10, 24);
    cue(q2, 'pop', { gain: 0.4 });
    // gently move in on the conversation
    const z = aim(960, 540, 1.1, 960, 540);
    tw('#c04', { x: 0, y: 0, scale: 1 }, { x: z.x, y: z.y, scale: z.scale, duration: 2.0, ease: 'power2.inOut' }, st + 0.2);
    // handover: the note and the inbox pill
    const hand = wt(v5, 'hands') - 0.1;
    const note = $('#aw4 .chat-ai-note'), item = $('#aw4 .chat-item'), sub = $('.chat-item-sub', item);
    const pill = document.createElement('span'); pill.className = 'chat-assign-pill is-needs-person'; pill.textContent = 'Needs a person'; sub.appendChild(pill);
    DER.push((t) => {
      if (t >= sendAt + 0.25) { note.className = 'chat-ai-note is-muted'; note.textContent = 'AI paused until 11:05 am after handing over'; }
      else if (t >= hand) { note.className = 'chat-ai-note is-handover'; note.textContent = 'Needs a person: asked about paying in two parts'; }
      else { note.className = 'chat-ai-note'; note.textContent = ''; }
      pill.style.display = t >= hand && t < sendAt + 0.25 ? '' : 'none';
      item.classList.toggle('has-unread', t < sendAt);
      const ub = $('.chat-unread-badge', item); if (ub) ub.style.display = t < sendAt ? '' : 'none';
    });
    cue(hand, 'tick', { gain: 0.45 });
    // context: the whole history stays with the chat
    const mr = M.msgs4;
    ringTo('#ctx4', M.sub4, hand, 0.01, 8);
    tw('#ctx4', { opacity: 0 }, { opacity: 1, duration: 0.3 }, hand);
    ringTo('#ctx4', { x: mr.x + 14, y: mr.y + 46, w: mr.w - 28, h: mr.h - 60 }, wt(v5, 'full') - 0.2, 0.7, 0);
    tw('#ctx4', { opacity: 1 }, { opacity: 0, duration: 0.35 }, wt(v6, 'And') - 0.1);
    // a teammate types and sends
    const input = $('#aw4 .chat-input'), send = M.send4;
    const tA = wt(v5, 'context', 0, true) + 0.1;
    typeInto(input, 'Yes! Pay ₹6,000 now and ₹6,000 next month.', tA, sendAt - 0.3);
    DER.push((t) => { if (t >= sendAt) input.value = ''; });
    cue(tA, 'typing', { dur: sendAt - 0.3 - tA, gain: 0.35 });
    tw('#cur4', { opacity: 0 }, { opacity: 1, duration: 0.25 }, tA);
    cursorPath($('#cur4'), [{ t: tA, x: send.cx - 140, y: send.cy + 90 }, { t: sendAt - 0.08, x: send.cx, y: send.cy }]);
    tap('#tap4', send.cx, send.cy, sendAt);
    cue(sendAt + 0.02, 'send', { gain: 0.4 });
    tw('#cur4', { opacity: 1 }, { opacity: 0, duration: 0.3 }, sendAt + 0.6);
  }

  // ---------------- s05 ----------------
  {
    const v7 = 'vo07', v8 = 'vo08', st = S.s05.start;
    drift('#c05', st - 0.3, S.s05.end + 0.3, 1.02);
    reveal('#t05', wt(v7, 'Building') - 0.2, 0.07);
    const plug = wt(v7, 'Plug') - 0.25;
    tw('#t05', { y: 0, scale: 1 }, { y: -290, scale: 0.56, duration: 1.0, ease: 'power3.inOut' }, plug);
    rise('#code', plug + 0.35, { y: 50, d: 1.1 });
    cue(plug, 'swish', { gain: 0.3 });
    const a = plug + 0.8, b = a + 2.2;
    const cb = $('#codebody');
    DER.push((t) => { const n = Math.round(CODE_LEN * prog(t, a, b)); cb.innerHTML = codeHtml(n) + (t < b + 1.2 ? '<span class="caret"></span>' : ''); });
    cue(a, 'typing', { dur: b - a, gain: 0.3 });
    rise('#resp', b + 0.25, { y: 14, d: 0.7 }); cue(b + 0.25, 'success', { gain: 0.35 });
    rise('#ey5', wt(v8, 'Through') - 0.2, { y: 14 });
    $$('#conns .conn').forEach((c, i) => { const at = wt(v8, ['MCP', 'API', 'n', 'Zapier'][i]) - 0.15; rise(c, at, { y: 24, s: 0.95, d: 0.8 }); cue(at, 'tick', { gain: 0.35 }); });
    $$('#caps .cap').forEach((c, i) => { const at = wt(v8, ['send', 'read', 'use'][i]) - 0.15; rise(c, at, { y: 18, d: 0.8 }); });
    rise('#num5', wt(v8, 'own') - 0.25, { y: 16, s: 0.96, d: 0.9 }); cue(wt(v8, 'own') - 0.25, 'pop', { gain: 0.35 });
  }

  // ---------------- s06 ----------------
  {
    const v = 'vo09', st = S.s06.start;
    drift('#c06', st - 0.3, S.s06.end + 0.3, 1.025);
    reveal('#t06', wt(v, 'And') - 0.15, 0.05);
    rise('#guard', wt(v, 'guardrails') - 0.1, { y: 50, d: 1.1 });
    [['gr1', 'Approved', 'success'], ['gr2', 'Opted', 'error'], ['gr3', 'Cloud', 'success']].forEach(([g, w, s]) => {
      const at = wt(v, w) - 0.15;
      tw(`#${g} .on`, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.55, ease: 'back.out(2)' }, at);
      rise(`#${g} .badge`, at + 0.15, { y: 8, d: 0.6 });
      cue(at, s, { gain: 0.32 });
    });
  }

  // ---------------- s07 ----------------
  {
    const v = 'vo10', st = S.s07.start;
    rise('#aw7', st - 0.3, { y: 40, s: 0.985, d: 1.0 });
    tw('#c07', { scale: 1.08 }, { scale: 1.14, duration: S.s07.end - st + 0.6, ease: 'none' }, st - 0.3);
    feed($('#aw7 .chat-messages'), $$('#aw7 .chat-messages .msg-group').map((el) => ({ el, a: -1 })), 10, 24);
    const ring = document.createElement('div'); ring.className = 'ring'; ring.id = 'ring7'; $('#c07').appendChild(ring);
    const list = M.list7, msgs = M.msgs7, hand = M.hand7;
    ringTo('#ring7', list, wt(v, 'shared') - 0.2, 0.01, 0);
    tw('#ring7', { opacity: 0 }, { opacity: 1, duration: 0.35 }, wt(v, 'shared') - 0.2);
    ringTo('#ring7', { x: msgs.x + 14, y: msgs.y + 46, w: msgs.w - 28, h: msgs.h - 60 }, wt(v, 'Every') - 0.25, 0.7, 0);
    tw('#aw7 .msg-ai-label', { color: '#143518', backgroundColor: 'rgba(74,201,89,0)' }, { color: '#15803D', backgroundColor: 'rgba(74,201,89,.18)', duration: 0.4 }, wt(v, 'reply') - 0.2);
    ringTo('#ring7', hand, wt(v, 'every', 0) - 0.25, 0.7, 2);
    tw('#ring7', { opacity: 1 }, { opacity: 0, duration: 0.35 }, wt(v, 'what') - 0.3);
    const ta = wt(v, 'what') - 0.35;
    rise('#tiles', ta, { y: 50, d: 1.0 });
    counter($('#n1'), 412, ta + 0.3, ta + 1.6);
    counter($('#n2'), 38, ta + 0.3, ta + 1.6);
    counter($('#n3'), 185.4, ta + 0.3, ta + 1.6, (n) => '₹ ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    cue(ta, 'swish', { gain: 0.25 });
  }

  // ---------------- s08 ----------------
  {
    const v = 'vo11', st = S.s08.start;
    drift('#c08', st - 0.3, S.s08.end + 0.3, 1.02);
    rise('#pcap', st - 0.1, { y: 12 });
    rise('#pn1', st - 0.2, { y: 50, d: 1.0 });
    const c1 = wt(v, 'campaigns') - 0.2, fl = wt(v, 'build') - 0.35, fo = wt(v, 'follow') - 0.35;
    counter($('#cs1'), 2480, c1, c1 + 1.4); counter($('#cs2'), 2431, c1 + 0.15, c1 + 1.5);
    counter($('#cs3'), 1964, c1 + 0.3, c1 + 1.6); counter($('#cs4'), 312, c1 + 0.45, c1 + 1.7);
    tw('#pb1', { width: '0%' }, { width: '64%', duration: 1.6, ease: 'power2.out' }, c1);
    tw('#strip', { x: 0 }, { x: -1400, duration: 1.0, ease: 'power3.inOut' }, fl);
    tw('#strip', { x: -1400 }, { x: -2800, duration: 1.0, ease: 'power3.inOut' }, fo);
    cue(fl, 'swish', { gain: 0.28 }); cue(fo, 'swish', { gain: 0.28 });
    DER.push((t) => { $('#pc1').style.display = t < fl + 0.45 ? '' : 'none'; $('#pc2').style.display = t >= fl + 0.45 && t < fo + 0.45 ? '' : 'none'; $('#pc3').style.display = t >= fo + 0.45 ? '' : 'none'; });
    // flow: nodes settle, then edges draw between them
    $$('#pn2 .fnode').forEach((n, i) => rise(n, fl + 0.4 + i * 0.12, { y: 20, s: 0.96, d: 0.8 }));
    const pane = M.pane8, sv = $('#fedges'), ns = M.nodes8;
    const zf = 1.3; // .pane-in zoom
    const edge = (a, b, k) => {
      const x1 = (a.x + a.w - pane.x) / zf, y1 = (a.cy - pane.y) / zf + (k || 0), x2 = (b.x - pane.x) / zf, y2 = (b.cy - pane.y) / zf, mx = (x1 + x2) / 2;
      return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
    };
    sv.innerHTML = [edge(ns[0], ns[1]), edge(ns[1], ns[2], 20), edge(ns[1], ns[3], 52)].map((d) => `<path d="${d}" fill="none" stroke="#4AC959" stroke-width="2.5" stroke-linecap="round"/>`).join('');
    $$('path', sv).forEach((p, i) => { const L = p.getTotalLength(); p.style.strokeDasharray = L; tw(p, { strokeDashoffset: L }, { strokeDashoffset: 0, duration: 0.7, ease: 'power2.inOut' }, fl + 0.9 + i * 0.18); });
    // sent -> delivered -> read
    const sts = [['st1', wt(v, 'sent') - 0.1, '#4AC959'], ['st2', wt(v, 'sent') + 0.18, '#4AC959'], ['st3', wt(v, 'read') - 0.05, '#53BDEB']];
    sts.forEach(([id, at, col]) => {
      tw(`#${id} .sc`, { borderColor: '#E5E7EB', color: '#9CA3AF', backgroundColor: '#ffffff' }, { borderColor: col, color: '#ffffff', backgroundColor: col, duration: 0.35 }, at);
      tw(`#${id} .sc`, { scale: 1 }, { keyframes: [{ scale: 1.12, duration: 0.14 }, { scale: 1, duration: 0.3 }] }, at);
      cue(at, 'tick', { gain: 0.35 });
    });
    tw('#tlfill', { width: '0%' }, { width: '100%', duration: sts[2][1] - sts[0][1], ease: 'none' }, sts[0][1]);
  }

  // ---------------- s09 ----------------
  {
    const v = 'vo12', st = S.s09.start;
    drift('#c09', st - 0.3, S.s09.end + 0.3, 1.03);
    const ats = [wt(v, 'Your', 0), wt(v, 'Your', 1), wt(v, 'Your', 2)].map((x) => x - 0.15);
    ['#r1', '#r2', '#r3'].forEach((r, i) => reveal(r, ats[i], 0.06));
    tw('#r1', { color: '#143518' }, { color: '#B8C2B9', duration: 0.5 }, ats[1]);
    tw('#r2', { color: '#143518' }, { color: '#B8C2B9', duration: 0.5 }, ats[2]);
    const all = wt(v, 'All') - 0.15;
    tw('#r3', { color: '#143518' }, { color: '#B8C2B9', duration: 0.5 }, all);
    reveal('#r4', all, 0.05);
    tw('#r1, #r2', { color: '#B8C2B9' }, { color: '#143518', duration: 0.6 }, all + 0.4);
    tw('#r3', { color: '#B8C2B9' }, { color: '#143518', duration: 0.6 }, all + 0.4);
  }

  // ---------------- s10 ----------------
  {
    const v = 'vo13', v14 = 'vo14';
    const w = wt(v, 'Wasi') - 0.35;
    tw('#lock2 img', { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 1.2, ease: 'expo.out' }, w);
    tw('#lock2 .wm span', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 1.0, ease: 'expo.out', stagger: 0.05 }, w + 0.1);
    cue(w, 'chime', { gain: 0.6 });
    drift('#c10', w, DUR, 1.03);
    reveal('#t10', wt(v, 'Your') - 0.15, 0.05);
    rise('#cta', wt(v14, 'Start') - 0.15, { y: 26, s: 0.97, d: 1.0 });
    tw('#fade', { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power1.in' }, DUR - 0.8);
  }

  // ======================= continuous layers =======================
  DER.push((t) => {
    $('#g1').style.transform = `translate(${Math.sin(t * 0.07) * 90}px, ${Math.cos(t * 0.05) * 60}px)`;
    $('#g2').style.transform = `translate(${Math.cos(t * 0.06) * 110}px, ${Math.sin(t * 0.08) * 70}px)`;
  });
  rise('#footnote', wt('vo14', 'Start') + 0.6, { y: 8, d: 0.8 });

  master.set({}, {}, DUR);
  window.CUES = CUES.sort((a, b) => a.t - b.t);
  window.__FILM_DURATION__ = DUR;
  window.__seek = function (t) { master.seek(t, false); DER.forEach((f) => f(t)); };
  window.__seek(0);
  window.__ready = true;
}).catch((e) => { console.error(e); window.__error = String(e && e.stack || e); }));
