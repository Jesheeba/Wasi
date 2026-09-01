/* WASI WhatsApp CRM Application Logic */

document.addEventListener('DOMContentLoaded', () => {

  // In production this app is served by the same Express process as the API
  // (see server/src/app.js), so same-origin relative paths just work. The
  // only time we need an absolute cross-port URL is local dev, where the
  // static files are served separately via `npm start` (:3000) from the API
  // (:4000, `npm run dev` in server/).
  const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '4000')
    ? 'http://localhost:4000'
    : '';

  const state = {
    user: null,
    currentView: 'chat',
    activeChatId: null,
    chats: [],
    contacts: [],
    tagsById: {},
    broadcasts: [],
    automationRules: [],
    flows: [],
    currentFlowGraph: null,
    flowView: 'list',
    flowCanvasEditor: null,
    wabaConnected: false,
    templates: [],
    tickets: [],
    libraryEntries: [],
    librarySelectedEntry: null,
    metaLibraryEntries: [],
    metaLibrarySelectedEntry: null
  };

  const refreshIcons = () => {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  };
  refreshIcons();

  // Mobile sidebar drawer (below the 900px tablet breakpoint — see
  // index.css's matching @media block and breakpoints.css for the shared
  // value). #sidebar itself is untouched above that width; this only ever
  // toggles a class, the actual show/hide behavior lives entirely in CSS.
  (function setupMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('mobile-sidebar-toggle-btn');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar || !toggleBtn || !backdrop) return;

    const closeSidebar = () => {
      sidebar.classList.remove('mobile-open');
      backdrop.classList.remove('visible');
    };
    const openSidebar = () => {
      sidebar.classList.add('mobile-open');
      backdrop.classList.add('visible');
    };

    toggleBtn.addEventListener('click', () => {
      if (sidebar.classList.contains('mobile-open')) closeSidebar();
      else openSidebar();
    });
    backdrop.addEventListener('click', closeSidebar);
    // Picking a nav item should close the drawer — otherwise it stays open,
    // covering the view the user just navigated to.
    sidebar.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', closeSidebar);
    });
  })();

  // --- API helpers ---
  async function authFetch(path, options = {}) {
    const token = localStorage.getItem('client_token');
    // A FormData body (the business-profile picture upload) needs the
    // browser to set its own multipart Content-Type with a boundary — an
    // explicit 'application/json' here would break that, and every existing
    // caller already sends a JSON string body, so this only changes
    // behavior for the one new caller that passes FormData.
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const { timeoutMs = 45_000, ...restOptions } = options;
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...restOptions,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {})
        }
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    }
    if (res.status === 401) {
      localStorage.removeItem('client_token');
      stopPolling();
      showAuthView();
      const authErr = new Error('Session expired, please log in again.');
      authErr.isAuthError = true;
      throw authErr;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Request failed (${res.status})`);
      // The template form's error handler reads err.body.details for the
      // specific validation reasons (numbered params, missing sample
      // values, etc.) — this was never actually attached, so that path was
      // silently dead code; every failure just showed the generic
      // top-level message. Attaching it here fixes that for every caller,
      // not just templates.
      err.body = body;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function timeLabel(isoString) {
    if (!isoString) return '';
    return new Date(isoString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Adapts real API rows (tag_id, created_at, unread_count, ...) into the flat
  // shape the existing renderers expect (tag name, created, time, count).
  function adaptContact(c) {
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      tag: state.tagsById[c.tag_id]?.name || '—',
      status: c.status,
      created: (c.created_at || '').slice(0, 10),
      optInStatus: c.opt_in_status || 'unknown',
      optInSource: c.opt_in_source || null,
      optInAt: c.opt_in_status === 'opted_in' ? c.opt_in_at : c.opt_out_at
    };
  }

  function adaptChat(c) {
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      tag: state.tagsById[c.tag_id]?.name || '—',
      time: timeLabel(c.last_message_at),
      count: c.unread_count
    };
  }

  function adaptBroadcast(b) {
    return {
      title: b.title,
      tag: state.tagsById[b.tag_id]?.name || '—',
      status: b.status,
      delivered: String(b.delivered_count),
      readRate: `${Number(b.read_rate).toFixed(1)}%`,
      date: (b.scheduled_date || b.created_at || '').toString().slice(0, 10),
      skippedConsent: b.skipped_consent_count || 0
    };
  }

  async function refreshContacts() {
    const contacts = await authFetch('/api/contacts');
    state.contacts = contacts.map(adaptContact);
  }

  async function refreshBroadcasts() {
    const broadcasts = await authFetch('/api/broadcasts');
    state.broadcasts = broadcasts.map(adaptBroadcast);
  }

  async function refreshAutomationRules() {
    // Column names (title, trigger, action, status) already match the shape
    // the renderer expects — no adapter needed.
    state.automationRules = await authFetch('/api/automation-rules');
  }

  async function refreshTemplates() {
    // Column names (name, category, body) already match the shape the
    // renderer expects — no adapter needed.
    state.templates = await authFetch('/api/templates');
  }

  async function refreshTickets() {
    state.tickets = await authFetch('/api/support-tickets');
  }

  async function loadInitialData() {
    const [tags, contacts, chats, broadcasts, automationRules, flows, templates, tickets] = await Promise.all([
      authFetch('/api/tags'),
      authFetch('/api/contacts'),
      authFetch('/api/chats'),
      authFetch('/api/broadcasts'),
      authFetch('/api/automation-rules'),
      authFetch('/api/automation-flows'),
      authFetch('/api/templates'),
      authFetch('/api/support-tickets')
    ]);

    state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));
    state.contacts = contacts.map(adaptContact);
    state.chats = chats.map(adaptChat);
    state.broadcasts = broadcasts.map(adaptBroadcast);
    state.automationRules = automationRules;
    state.flows = flows;
    state.templates = templates;
    state.tickets = tickets;
  }

  function showAuthView() {
    state.user = null;
    // Clears whichever view hash the previous session left behind — a
    // fresh login (possibly a different account, on a shared browser)
    // shouldn't inherit "go straight to Templates" from someone else's
    // last session. enterApp reads the hash unconditionally, so this is
    // the one place that needs to reset it, covering both an explicit
    // logout and a session actually expiring mid-use (a real 401).
    if (location.hash) location.hash = '';
    appShell.style.display = 'none';
    authView.style.display = 'flex';
  }

  function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, 2200);
  }

  // --- Auth Handlers ---
  const authView = document.getElementById('auth-view');
  const appShell = document.getElementById('app-shell');
  const loginForm = document.getElementById('login-form');
  const togglePwdBtn = document.getElementById('toggle-pwd-btn');
  const loginPwdInput = document.getElementById('login-password');

  togglePwdBtn?.addEventListener('click', () => {
    const type = loginPwdInput.getAttribute('type') === 'password' ? 'text' : 'password';
    loginPwdInput.setAttribute('type', type);
  });

  // No WebSocket/SSE in v1 — short-interval polling while the chat view is
  // open is the simplest correct way to surface inbound WhatsApp messages
  // and delivery-status changes that arrive via the Meta webhook server-side
  // (see server/src/routes/metaWebhook.js) without the user refreshing.
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (state.currentView !== 'chat' || !state.user) return;
      try {
        if (state.activeChatId) {
          const since = state.lastMessageAt;
          const fresh = await authFetch(`/api/chats/${state.activeChatId}/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`);
          if (fresh.length) {
            const byId = new Map((state.activeChatMessages || []).map(m => [m.id, m]));
            fresh.forEach(m => byId.set(m.id, m));
            state.activeChatMessages = Array.from(byId.values()).sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
            state.lastMessageAt = state.activeChatMessages[state.activeChatMessages.length - 1].sent_at;
            renderMessages(state.activeChatMessages);
          }
          // Unconditional, not just on new messages — the window's
          // remaining-time countdown (and whether it just closed) changes
          // with the clock even when nothing new arrived.
          renderChatWindowStatus();
        }
        const chats = await authFetch('/api/chats');
        state.chats = chats.map(adaptChat);
        renderChatList(state.chatTagFilter);
      } catch (_err) {
        // Transient poll failure — don't spam a toast every 4s over it.
      }
    }, 4000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function enterApp(client) {
    state.user = client;
    authView.style.display = 'none';
    appShell.style.display = 'flex';

    // The sidebar account indicator was a hardcoded "Mohamed" left over from
    // the original mockup — every client saw the same name/avatar regardless
    // of which account was actually logged in, which is exactly what made a
    // resumed/wrong session look like "a different account" instead of an
    // obvious, catchable mismatch. Same class of bug initialsFor's own
    // comment describes for chat avatars ("AK" for every contact).
    const profileItem = document.getElementById('user-profile-item');
    if (profileItem) {
      const nameEl = profileItem.querySelector('.nav-text');
      const avatarEl = profileItem.querySelector('.avatar');
      if (nameEl) nameEl.textContent = client.name || client.email || 'Account';
      if (avatarEl) avatarEl.textContent = initialsFor(client.name || client.email);
    }

    try {
      await loadInitialData();
    } catch (err) {
      showToast(err.message);
    }
    // Restores whichever top-level view the URL hash names (kept in sync by
    // switchView below) instead of always landing on Chat — a reload used to
    // silently discard wherever the user actually was (Templates, Broadcasts,
    // etc.), which after the session-resume confirmation card already felt
    // like being logged out, this made it worse by also losing their place.
    // Falls back to 'chat' for a missing/unrecognized hash (a fresh login,
    // a stale/renamed view, or a hash left over from something else).
    const requestedView = location.hash.slice(1);
    switchView(VALID_VIEWS.has(requestedView) ? requestedView : 'chat');
    startPolling();
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('client_token', data.token);
      await enterApp(data.client);
    } catch (err) {
      showToast(err.message);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.getElementById('forgot-password-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = prompt('Enter your account email — we’ll send a reset link:');
    if (!email) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      showToast(data.message || 'If that email is registered, a reset link has been sent.');
    } catch (err) {
      showToast('Could not reach the server. Please try again.');
    }
  });

  document.getElementById('user-profile-item')?.addEventListener('click', () => {
    if (confirm('Do you want to log out?')) {
      stopPolling();
      localStorage.removeItem('client_token');
      showAuthView();
    }
  });

  // Resumes a session on page load if a token is already stored (spec §3
  // step 7: don't force a returning user to re-type their password every
  // refresh). A reload must land the user straight back on the same page
  // with no interruption — a "resume as {account}?" confirmation card was
  // tried here previously as an anti-mismatch safeguard, but from the
  // user's side a click-to-continue on every single reload reads exactly
  // like a logout, which is the opposite of the goal. Straight back to a
  // silent resume.
  (async () => {
    const token = localStorage.getItem('client_token');
    if (!token) return;
    try {
      const client = await authFetch('/api/auth/me');
      await enterApp(client);
    } catch (err) {
      // Only clear the token on a genuine auth failure (a real 401 — already
      // handled/logged by authFetch itself above). This used to clear it on
      // ANY failure, including a network error or the request simply timing
      // out — both very possible on this very first request of the page
      // (a cold-started server, a slow connection), and both had nothing to
      // do with whether the token was actually still valid. That bug looked
      // exactly like "automatically logged out" on first load: the token
      // was gone before the user ever saw why, so even a manual reload
      // could only start a fresh login, never actually resume. Leaving the
      // token in place on a non-auth failure means a reload gets a clean
      // second attempt and can resume normally once whatever was transient
      // clears up.
      if (err.isAuthError) {
        localStorage.removeItem('client_token');
      }
    }
  })();

  // --- Navigation Router ---
  const navItems = document.querySelectorAll('.nav-item');
  const viewContainers = document.querySelectorAll('.view-container');
  // Every real top-level view a URL hash is allowed to name — derived from
  // the nav markup itself so this can't drift out of sync with it.
  const VALID_VIEWS = new Set(Array.from(navItems, (item) => item.dataset.view).filter(Boolean));
  let isProgrammaticHashChange = false;

  const switchView = (targetView) => {
    state.currentView = targetView;
    // Keeps the URL hash in sync with whatever view is showing, so a reload
    // (or the browser's own back/forward) lands back here instead of always
    // resetting to Chat — see enterApp's own comment for why this mattered.
    // The isProgrammaticHashChange guard on the hashchange listener below
    // stops this from re-triggering switchView on its own write.
    if (location.hash.slice(1) !== targetView) {
      isProgrammaticHashChange = true;
      location.hash = targetView;
    }

    navItems.forEach(item => {
      if (item.dataset.view === targetView) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    viewContainers.forEach(container => {
      if (container.id === `view-${targetView}`) {
        container.classList.add('active');
      } else {
        container.classList.remove('active');
      }
    });

    if (targetView === 'chat') {
      // Render whatever's cached immediately (no blank flash), then refresh
      // from the server — state.chats is only otherwise updated by the
      // poller (startPolling), which is a no-op while any other view is
      // active, so a chat that arrived while the user was elsewhere never
      // shows up here until this explicit refetch.
      renderChatList(state.chatTagFilter);
      authFetch('/api/chats').then(chats => {
        state.chats = chats.map(adaptChat);
        if (state.currentView === 'chat') renderChatList(state.chatTagFilter);
      }).catch(() => {});
    }
    if (targetView === 'contacts') {
      // Same staleness fix as the chat view above: state.contacts is only
      // otherwise updated by loadInitialData() at login, so a contact
      // created since then (e.g. by an inbound message, or by connecting a
      // WhatsApp number that syncs new data) never shows up here without
      // this explicit refetch.
      renderContacts();
      authFetch('/api/contacts').then(contacts => {
        state.contacts = contacts.map(adaptContact);
        if (state.currentView === 'contacts') renderContacts();
      }).catch(() => {});
    }
    if (targetView === 'campaigns') renderBroadcasts();
    if (targetView === 'automation') { renderAutomation(); renderFlowsList(); }
    if (targetView === 'template') {
      // Same staleness fix — a template synced after login (e.g. right
      // after connecting a WhatsApp number, which pulls in existing
      // approved templates from Meta) never appeared here until a full page
      // reload, since state.templates was never refetched on view switch.
      renderTemplates();
      authFetch('/api/templates').then(templates => {
        state.templates = templates;
        if (state.currentView === 'template') renderTemplates();
      }).catch(() => {});
    }
    if (targetView === 'template-library') {
      // Curated reference content, not live per-client data (unlike
      // chat/contacts above) — only changes when an admin re-runs
      // seedTemplateLibrary.js, so caching for the session avoids refetching
      // the same 36+ rows every time this view is opened.
      if (!state.libraryEntries.length) loadTemplateLibrary();
      else renderLibraryGrid();
      if (!state.metaLibraryEntries.length) loadMetaTemplateLibrary();
      else renderMetaLibraryGrid();
    }
    if (targetView === 'support') renderTickets();
    if (targetView === 'analytics') renderMessageAnalytics();
    if (targetView === 'payments') renderPaymentsTable();
    // The Whatsapp sub-tab ships marked active by default (index.html) but
    // previously only rendered real data on an explicit sub-nav click —
    // landing here from the main nav showed static placeholder markup
    // indefinitely. renderWhatsAppSettings itself no-ops safely if the
    // client hasn't clicked into a different sub-tab (its target selector
    // only matches inside #sec-view-whatsapp).
    if (targetView === 'settings') renderWhatsAppSettings();

    refreshIcons();
  };

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      if (view) switchView(view);
    });
  });

  // Lets the browser's own back/forward buttons move between views too,
  // now that switchView keeps the hash in sync — a real side benefit of the
  // fix, not the main point of it. Ignores the hashchange switchView's own
  // `location.hash = ...` write fires (isProgrammaticHashChange), so this
  // never re-runs switchView on a change it just caused itself, and ignores
  // any change before the user is actually logged in (nothing to switch to
  // yet — enterApp reads the hash directly once login/resume completes).
  window.addEventListener('hashchange', () => {
    if (isProgrammaticHashChange) { isProgrammaticHashChange = false; return; }
    if (!state.user) return;
    const requestedView = location.hash.slice(1);
    if (VALID_VIEWS.has(requestedView) && requestedView !== state.currentView) {
      switchView(requestedView);
    }
  });

  // --- Chat View Handlers ---
  const chatEmptyPlaceholder = document.getElementById('chat-empty-placeholder');
  const chatActiveWorkspace = document.getElementById('chat-active-workspace');

  // Mobile-only back button (chat-header, index.html) — returns to the chat
  // list. Just removes the class openActiveChat sets; doesn't touch
  // state.activeChatId or the desktop inline display toggles, so reopening
  // the same chat (or the desktop layout) is unaffected.
  document.getElementById('chat-back-to-list-btn')?.addEventListener('click', () => {
    document.getElementById('view-chat')?.classList.remove('chat-mobile-conversation-open');
  });

  // Status ticks mirror WhatsApp's own convention; 'failed' gets a retry
  // affordance instead since silently dropping a message is worse than
  // surfacing that it needs one click to resend.
  function statusBadge(m) {
    if (m.direction !== 'out') return '';
    if (m.status === 'failed') {
      return `<button type="button" class="msg-retry-btn" data-retry-id="${m.id}" title="${(m.error_reason || 'Send failed').replace(/"/g, '&quot;')}">⚠ Retry</button>`;
    }
    const tick = { pending: '🕒', sent: '✓', delivered: '✓✓', read: '✓✓' }[m.status] || '';
    return `<span class="msg-status" data-status="${m.status}">${tick}</span>`;
  }

  function renderMessages(messages) {
    const msgContainer = document.getElementById('chat-messages-container');
    if (!msgContainer) return;
    msgContainer.innerHTML = messages.map(m => `
      <div class="msg-bubble ${m.direction === 'in' ? 'msg-in' : 'msg-out'}">
        <div>${m.body.replace(/</g, '&lt;')}</div>
        <div class="msg-time">${timeLabel(m.sent_at)} ${statusBadge(m)}</div>
      </div>
    `).join('');
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  // Delegated once — renderMessages rebuilds the container's innerHTML on
  // every poll tick, so a listener bound to an individual button would be
  // gone by the time the user clicks it.
  document.getElementById('chat-messages-container')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-retry-id]');
    if (!btn || !state.activeChatId) return;
    try {
      await authFetch(`/api/chats/${state.activeChatId}/messages/${btn.dataset.retryId}/retry`, { method: 'POST' });
      await refreshActiveChatMessages();
    } catch (err) {
      showToast(err.message);
    }
  });

  async function refreshActiveChatMessages() {
    if (!state.activeChatId) return;
    const messages = await authFetch(`/api/chats/${state.activeChatId}/messages`);
    state.activeChatMessages = messages;
    state.lastMessageAt = messages.length ? messages[messages.length - 1].sent_at : null;
    renderMessages(messages);
    renderChatWindowStatus();
  }

  // Mirrors messagingService.js's SESSION_WINDOW_MS / canSendFreeform exactly
  // (24h since the last INBOUND message) — same client-side-mirror reasoning
  // as extractTemplateParams: no server module to require() from a
  // no-build-step page. GET /api/chats/:id/messages returns full history, no
  // limit (chatsRepo.listMessages), so this is safe to compute from
  // state.activeChatMessages rather than needing a dedicated endpoint.
  const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

  function computeSessionWindow(messages) {
    const inboundTimes = (messages || [])
      .filter(m => m.direction === 'in')
      .map(m => new Date(m.sent_at).getTime());
    if (!inboundTimes.length) return { open: false, lastInboundAt: null, closesAt: null };
    const lastInboundMs = Math.max(...inboundTimes);
    const closesAtMs = lastInboundMs + SESSION_WINDOW_MS;
    return { open: Date.now() < closesAtMs, lastInboundAt: new Date(lastInboundMs).toISOString(), closesAt: new Date(closesAtMs).toISOString() };
  }

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  // Drives both the visible banner and whether plain text is even
  // attemptable — the whole point being asked for here: an agent should
  // never be able to type into a dead composer and think it sent. Nothing
  // previously surfaced this at all (README-level gap, not a bug fix).
  function renderChatWindowStatus() {
    const banner = document.getElementById('chat-window-status');
    if (!banner || !state.activeChatId) return;
    const window_ = computeSessionWindow(state.activeChatMessages);
    state.sessionWindowOpen = window_.open;

    if (window_.open) {
      const remaining = new Date(window_.closesAt).getTime() - Date.now();
      banner.style.display = '';
      banner.style.background = '#F0FDF4';
      banner.style.color = '#15803D';
      banner.textContent = `Session window open — closes in ${formatDuration(remaining)}. Free-form text and templates both work.`;
      if (chatMessageInput) { chatMessageInput.disabled = false; chatMessageInput.placeholder = "Type a message or '/' for templates..."; }
      if (sendMsgBtn) sendMsgBtn.disabled = false;
    } else {
      banner.style.display = '';
      banner.style.background = '#FEF2F2';
      banner.style.color = '#B91C1C';
      banner.textContent = window_.lastInboundAt
        ? 'Session window closed — free-form text will fail. Type / to send a template instead.'
        : 'No inbound message yet from this contact — only a template can start the conversation.';
      if (chatMessageInput) chatMessageInput.placeholder = "Window closed — type '/' to send a template";
      if (sendMsgBtn) sendMsgBtn.disabled = true;
    }
  }

  // First letter of the first two words of a name — used to replace what
  // was a hardcoded "AK" (Alex Kumar's initials) shown for every contact
  // regardless of their actual name.
  function initialsFor(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  async function openActiveChat(chat) {
    state.activeChatId = chat.id;
    if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'none';
    if (chatActiveWorkspace) chatActiveWorkspace.style.display = 'flex';
    // Mobile-only (<=640px, index.css): swaps the single visible panel from
    // the chat list to the active conversation. No-op at desktop widths —
    // nothing there reads this class.
    document.getElementById('view-chat')?.classList.add('chat-mobile-conversation-open');

    const initials = initialsFor(chat.name);
    document.getElementById('active-chat-avatar').innerText = initials;
    document.getElementById('active-chat-name').innerText = chat.name;
    document.getElementById('drawer-contact-avatar').innerText = initials;
    document.getElementById('drawer-contact-name').innerText = chat.name;
    document.getElementById('drawer-contact-phone').innerText = chat.phone;

    // chat.tag is already resolved to the contact's real (single) tag name,
    // or the '—' placeholder for untagged (see adaptChat) — a contact has
    // exactly one tag_id, never the two-badge "Lead" + "High Intent" pair
    // this used to hardcode for every contact regardless of reality.
    const headerTag = document.getElementById('active-chat-tag');
    const hasTag = chat.tag && chat.tag !== '—';
    headerTag.style.display = hasTag ? '' : 'none';
    headerTag.innerText = hasTag ? chat.tag : '';
    document.getElementById('drawer-contact-tags').innerHTML = hasTag
      ? `<span class="tag-badge">${escapeHtml(chat.tag)}</span>`
      : '<span style="font-size:0.8rem;color:#9CA3AF;">No tag assigned</span>';

    try {
      await refreshActiveChatMessages();
    } catch (err) {
      showToast(err.message);
    }

    // chats.unread_count only ever increments server-side (an inbound
    // message bumps it — chatsRepo.insertInbound) — nothing previously
    // cleared it back to 0 on view, anywhere in this codebase. Update the
    // local badge immediately (chat.count is a live reference into
    // state.chats, see adaptChat), then persist so it stays cleared across
    // a reload/poll refresh instead of a stale count reappearing.
    if (chat.count) {
      chat.count = 0;
      renderChatList(state.chatTagFilter);
      try {
        await authFetch(`/api/chats/${chat.id}`, { method: 'PATCH', body: JSON.stringify({ unread_count: 0 }) });
      } catch (_err) {
        // Non-fatal — the badge already cleared locally; next poll will
        // just re-show the count if this write didn't stick.
      }
    }
  }

  /* ---------------------------------------------------------------
     New Conversation — the only way to originate a chat with a contact
     who's never messaged in. Two steps: pick a contact (or enter a new
     number), then — only if the 24h session window isn't already open —
     an approved template, handed off to the existing Send Chat Template
     modal for the actual params/preview/send. WhatsApp's Cloud API can't
     originate or re-open a conversation with free text, so the template
     step isn't optional whenever the window is closed, whether this is a
     brand-new chat (never opened) or an existing one that's gone quiet.
     --------------------------------------------------------------- */
  function openNewConversationModal() {
    document.getElementById('new-conversation-contact-search').value = '';
    document.getElementById('new-conversation-contact-results').innerHTML = '';
    document.getElementById('new-conversation-contact-results').style.display = 'none';
    document.getElementById('new-conversation-new-number-fields').style.display = 'none';
    document.getElementById('new-conversation-new-name').value = '';
    document.getElementById('new-conversation-new-phone').value = '';
    document.getElementById('new-conversation-step-who').style.display = '';
    document.getElementById('new-conversation-step-template').style.display = 'none';
    document.getElementById('modal-new-conversation')?.classList.add('open');
  }
  function closeNewConversationModal() {
    document.getElementById('modal-new-conversation')?.classList.remove('open');
  }
  document.getElementById('new-conversation-trigger')?.addEventListener('click', openNewConversationModal);
  document.getElementById('start-new-chat-btn')?.addEventListener('click', openNewConversationModal);

  document.getElementById('new-conversation-contact-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const resultsEl = document.getElementById('new-conversation-contact-results');
    if (!q) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; return; }

    const matches = state.contacts.filter(c =>
      c.name.toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q)
    ).slice(0, 20);
    resultsEl.style.display = '';
    resultsEl.innerHTML = matches.length
      ? matches.map(c => `
          <div class="new-conversation-contact-item" data-contact-id="${c.id}" style="padding:10px 16px; cursor:pointer; border-bottom:1px solid var(--border-light); display:flex; justify-content:space-between; gap:10px;">
            <span style="font-weight:600; font-size:0.85rem;">${escapeHtml(c.name)}</span>
            <span style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(c.phone)}</span>
          </div>
        `).join('')
      : '<div style="padding:10px 16px; font-size:0.85rem; color:var(--text-muted);">No contacts match.</div>';
    resultsEl.querySelectorAll('.new-conversation-contact-item').forEach(item => {
      item.addEventListener('click', () => {
        const contact = state.contacts.find(c => c.id === item.dataset.contactId);
        if (contact) proceedWithContact(contact);
      });
    });
  });

  document.getElementById('new-conversation-toggle-new-number')?.addEventListener('click', () => {
    document.getElementById('new-conversation-new-number-fields').style.display = '';
  });

  document.getElementById('new-conversation-new-number-continue')?.addEventListener('click', async () => {
    const name = document.getElementById('new-conversation-new-name').value.trim();
    const phone = document.getElementById('new-conversation-new-phone').value.trim();
    if (!name || !phone) { showToast('Enter a name and phone number.'); return; }

    const btn = document.getElementById('new-conversation-new-number-continue');
    btn.disabled = true;
    try {
      // opt_in_status is never set here — it defaults to 'unknown' at the
      // DB level (contacts table, migration 012_consent_tracking.js), the
      // same as every contact added via the Contacts view's Add Contact
      // form. That's what makes assertConsentForTemplate correctly refuse
      // a Marketing-category template to a number nobody has actually
      // opted in yet, even though this flow makes it easy to reach one.
      const contact = await authFetch('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({ name, phone }),
      });
      const adapted = adaptContact(contact);
      state.contacts.unshift(adapted);
      await proceedWithContact(adapted);
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Always goes through POST /api/chats with contact_id set — the backend
  // dedupes via findOrCreateByContact (server/src/routes/chats.js), so this
  // is safe to call for a contact who already has a chat: it returns that
  // same chat rather than creating a duplicate. Real message history is
  // then fetched to compute the actual session-window state — never
  // inferred from "is this chat new or old", since an existing chat can be
  // just as cold as a brand-new one.
  async function proceedWithContact(contact) {
    try {
      const chatRaw = await authFetch('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ name: contact.name, phone: contact.phone, contact_id: contact.id }),
      });
      const messages = await authFetch(`/api/chats/${chatRaw.id}/messages`);
      const windowOpen = computeSessionWindow(messages).open;

      let chat = state.chats.find(c => c.id === chatRaw.id);
      if (!chat) {
        chat = adaptChat(chatRaw);
        state.chats.unshift(chat);
      }

      if (state.currentView !== 'chat') switchView('chat');
      await openActiveChat(chat);
      renderChatList(state.chatTagFilter);

      if (windowOpen) {
        closeNewConversationModal();
        return;
      }

      // Window closed (or never opened) — a template is required. The chat
      // is already open underneath (state.activeChatId is set), so once a
      // template is picked, the existing Send Chat Template modal sends
      // straight into it and refreshes this same view.
      document.getElementById('new-conversation-step-who').style.display = 'none';
      document.getElementById('new-conversation-step-template').style.display = '';
      renderNewConversationTemplateList();
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderNewConversationTemplateList() {
    const listEl = document.getElementById('new-conversation-template-list');
    const introEl = document.getElementById('new-conversation-template-intro');
    introEl.textContent = "This contact hasn't messaged in the last 24 hours, so the conversation has to start with an approved template.";

    const approved = (state.templates || []).filter(t => t.status === 'approved');
    if (!approved.length) {
      listEl.innerHTML = '<div style="padding:12px 16px; font-size:0.85rem; color:var(--text-muted);">No approved templates on this account yet.</div>';
      return;
    }
    listEl.innerHTML = approved.map(t => `
      <div class="new-conversation-template-item" data-template-name="${escapeHtml(t.name)}" style="padding:10px 16px; cursor:pointer; border-bottom:1px solid var(--border-light);">
        <div style="font-weight:600; font-size:0.85rem;">${escapeHtml(t.name)}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(t.category)} &middot; ${escapeHtml((t.body || '').slice(0, 60))}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.new-conversation-template-item').forEach(item => {
      item.addEventListener('click', () => {
        const template = approved.find(t => t.name === item.dataset.templateName);
        closeNewConversationModal();
        if (template) openSendTemplateModal(template);
      });
    });
  }

  document.getElementById('new-conversation-back-btn')?.addEventListener('click', () => {
    document.getElementById('new-conversation-step-template').style.display = 'none';
    document.getElementById('new-conversation-step-who').style.display = '';
  });

  const chatMessageInput = document.getElementById('chat-message-input');
  const sendMsgBtn = document.getElementById('send-msg-btn');

  async function sendCurrentMessage() {
    const text = chatMessageInput?.value.trim();
    if (!text || !state.activeChatId) return;
    // Proactive, not just reactive — sendMsgBtn is already disabled when the
    // window is closed (renderChatWindowStatus), but Enter-to-send bypasses
    // a disabled button, and this is exactly the failure mode reported live:
    // a message that looked sent (input cleared optimistically below) but
    // never left, with only a toast that's easy to miss as the only sign.
    if (state.sessionWindowOpen === false) {
      showToast('Session window is closed — use / to send a template instead.');
      return;
    }
    chatMessageInput.value = '';

    try {
      await authFetch(`/api/chats/${state.activeChatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ type: 'text', body: text })
      });
      await refreshActiveChatMessages();
    } catch (err) {
      // session_window_closed / waba_not_connected are real, explainable
      // states (see server/src/services/messagingService.js) — surface the
      // server's message as-is rather than a generic "request failed".
      showToast(err.message);
      chatMessageInput.value = text; // give the draft back so it isn't lost
    }
  }

  sendMsgBtn?.addEventListener('click', sendCurrentMessage);
  chatMessageInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isSlashPickerOpen()) { selectHighlightedSlashItem(); return; }
      sendCurrentMessage();
    }
    if (e.key === 'Escape' && isSlashPickerOpen()) closeSlashPicker();
  });

  /* ---------------------------------------------------------------
     Slash-command template picker
     --------------------------------------------------------------- */
  const slashPicker = document.getElementById('template-slash-picker');
  let slashHighlightIndex = 0;

  function isSlashPickerOpen() {
    return slashPicker && slashPicker.style.display !== 'none';
  }

  function closeSlashPicker() {
    if (slashPicker) slashPicker.style.display = 'none';
  }

  function renderSlashPicker(filterText) {
    if (!slashPicker) return;
    const approved = (state.templates || []).filter(t => t.status === 'approved');
    const matches = approved.filter(t => t.name.toLowerCase().includes(filterText.toLowerCase()));

    if (!matches.length) {
      slashPicker.innerHTML = approved.length
        ? '<div style="padding:12px 16px; font-size:0.85rem; color:var(--text-muted);">No approved templates match.</div>'
        : '<div style="padding:12px 16px; font-size:0.85rem; color:var(--text-muted);">No approved templates on this account yet.</div>';
      slashPicker.style.display = '';
      return;
    }

    slashHighlightIndex = 0;
    slashPicker.innerHTML = matches.map((t, i) => `
      <div class="slash-picker-item" data-template-name="${escapeHtml(t.name)}" data-index="${i}"
           style="padding:10px 16px; cursor:pointer; ${i === 0 ? 'background:var(--color-primary-50, #F0FDF4);' : ''}">
        <div style="font-weight:600; font-size:0.85rem;">${escapeHtml(t.name)}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(t.category)} &middot; ${escapeHtml((t.body || '').slice(0, 60))}</div>
      </div>
    `).join('');
    slashPicker.style.display = '';

    slashPicker.querySelectorAll('.slash-picker-item').forEach(item => {
      item.addEventListener('click', () => selectSlashTemplate(item.dataset.templateName));
    });
  }

  function selectHighlightedSlashItem() {
    const highlighted = slashPicker?.querySelector(`.slash-picker-item[data-index="${slashHighlightIndex}"]`);
    if (highlighted) selectSlashTemplate(highlighted.dataset.templateName);
  }

  function selectSlashTemplate(templateName) {
    const template = (state.templates || []).find(t => t.name === templateName);
    closeSlashPicker();
    chatMessageInput.value = '';
    if (template) openSendTemplateModal(template);
  }

  chatMessageInput?.addEventListener('input', () => {
    const val = chatMessageInput.value;
    if (val.startsWith('/')) {
      renderSlashPicker(val.slice(1));
    } else {
      closeSlashPicker();
    }
  });

  // Outside-click closes the picker without needing a blur-timing race
  // against the item click handlers above.
  document.addEventListener('click', (e) => {
    if (!isSlashPickerOpen()) return;
    if (e.target === chatMessageInput || slashPicker?.contains(e.target)) return;
    closeSlashPicker();
  });

  /* ---------------------------------------------------------------
     Send Template modal — the actual send, reusing the exact backend
     path (POST /api/chats/:id/messages, type: 'template') broadcasts
     and flow send_template nodes already use, so opt-in enforcement
     (assertConsentForTemplate in messagingService.sendChatMessage)
     applies automatically — nothing here bypasses it, it can't be
     bypassed from this layer since the check lives server-side.
     --------------------------------------------------------------- */
  let sendTemplateTarget = null; // the template object while this modal is open
  let sendTemplateHeaderMediaAssetId = null; // set once a new header file has been uploaded for this send

  // Body params + (if TEXT) header params, deduped — mirrors
  // routes/broadcasts.js's requiredParamNames on the server for the same
  // template shape, but this is a one-off ad hoc send with values typed
  // directly, not a contact-field/static mapping like broadcasts use.
  function requiredParamsFor(template) {
    const names = extractTemplateParams(template.body || '');
    if (template.header_type === 'TEXT' && template.header_content) {
      extractTemplateParams(template.header_content).forEach(p => { if (!names.includes(p)) names.push(p); });
    }
    return names;
  }

  function setSendTemplateError(message) {
    const el = document.getElementById('send-chat-template-error');
    if (!el) return;
    el.textContent = message || '';
    el.style.display = message ? '' : 'none';
  }

  function openSendTemplateModal(template) {
    sendTemplateTarget = template;
    sendTemplateHeaderMediaAssetId = null;
    setSendTemplateError(null);
    document.getElementById('send-chat-template-name').textContent = template.name;

    const mediaField = document.getElementById('send-chat-template-media');
    const mediaFileInput = document.getElementById('send-chat-template-media-file');
    const mediaStatus = document.getElementById('send-chat-template-media-status');
    mediaFileInput.value = '';
    mediaStatus.textContent = '';
    mediaField.style.display = MEDIA_HEADER_TYPES.includes(template.header_type) ? '' : 'none';

    const params = requiredParamsFor(template);
    const paramsContainer = document.getElementById('send-chat-template-params');
    paramsContainer.innerHTML = params.length
      ? params.map(p => `
          <div class="form-group">
            <label class="form-label">${escapeHtml(p)}</label>
            <input type="text" class="form-input send-chat-template-param-input" data-param="${escapeHtml(p)}" />
          </div>
        `).join('')
      : '<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">This template has no parameters.</div>';

    paramsContainer.querySelectorAll('.send-chat-template-param-input').forEach(input => {
      input.addEventListener('input', updateSendTemplatePreview);
    });

    updateSendTemplatePreview();
    document.getElementById('modal-send-chat-template')?.classList.add('open');
  }

  function collectSendTemplateParamValues() {
    const values = {};
    document.querySelectorAll('.send-chat-template-param-input').forEach(input => {
      values[input.dataset.param] = input.value.trim();
    });
    return values;
  }

  // Shared by the send-to-a-contact preview below AND the standalone
  // Templates-view preview (openTemplateChatPreview) AND the Create/Edit
  // Template modal's own live preview (updateTemplatePreview) — one bubble
  // renderer so all three can never drift into showing a template
  // differently from how it actually sends. header/body/footer text runs
  // through substituteTemplateParams so a {{param}} shows its real sample
  // value (or "[param]" if one isn't set yet) instead of the raw
  // placeholder syntax. headerMediaNote is optional context specific to
  // the send flow ("will send with the file you chose above") — omitted
  // entirely for a read-only preview, where there's nothing to choose.
  function renderTemplateBubbleMarkup(t, values, headerMediaNote) {
    let html = '';
    if (t.header_type === 'TEXT' && t.header_content) {
      html += `<div class="template-preview-header">${escapeHtml(substituteTemplateParams(t.header_content, values))}</div>`;
    } else if (MEDIA_HEADER_TYPES.includes(t.header_type)) {
      const label = `${t.header_type.charAt(0)}${t.header_type.slice(1).toLowerCase()} header`;
      html += `<div class="template-preview-header">${headerMediaNote ? `${label} — ${headerMediaNote}` : label}</div>`;
    }
    html += `<div>${escapeHtml(substituteTemplateParams(t.body || '', values))}</div>`;
    if (t.footer_text) {
      html += `<div class="template-preview-footer">${escapeHtml(t.footer_text)}</div>`;
    }
    if (Array.isArray(t.buttons) && t.buttons.length > 0) {
      const icon = { URL: '&#128279;', PHONE_NUMBER: '&#128222;', QUICK_REPLY: '&#8617;' };
      html += `<div class="template-preview-buttons">${t.buttons.map(b =>
        `<div class="template-preview-button">${icon[b.type] || ''} ${escapeHtml(b.text || '')}</div>`
      ).join('')}</div>`;
    }
    return html;
  }

  function updateSendTemplatePreview() {
    const bubble = document.getElementById('send-chat-template-preview');
    if (!bubble || !sendTemplateTarget) return;
    const values = collectSendTemplateParamValues();
    const headerMediaNote = sendTemplateHeaderMediaAssetId
      ? 'will send with the file you chose above'
      : 'will send with the approval sample — choose a file above to send something else';
    bubble.innerHTML = renderTemplateBubbleMarkup(sendTemplateTarget, values, headerMediaNote);
  }

  // Read-only preview of an EXISTING template (Templates view's per-card
  // preview button) — no params to fill in, just the template's own saved
  // body_param_examples standing in for what a real send would fill.
  function openTemplateChatPreview(template) {
    document.getElementById('template-chat-preview-name').textContent = template.name;
    const bubble = document.getElementById('template-chat-preview-bubble');
    if (bubble) bubble.innerHTML = renderTemplateBubbleMarkup(template, template.body_param_examples || {});
    document.getElementById('modal-template-chat-preview')?.classList.add('open');
  }

  // Same split-by-component-type logic as
  // server/src/utils/templateParamMapping.js's buildTemplateComponents,
  // duplicated client-side for the same no-build-step reason as
  // extractTemplateParams — a template's body and header params share the
  // same {{name}} syntax but Meta sends them as separate component types.
  function buildSendTemplateComponents(template, values) {
    const bodyNames = extractTemplateParams(template.body || '');
    const headerNames = template.header_type === 'TEXT' && template.header_content
      ? extractTemplateParams(template.header_content)
      : [];

    const components = [];
    if (headerNames.length) {
      components.push({
        type: 'header',
        parameters: headerNames.map(name => ({ type: 'text', parameter_name: name, text: values[name] || '' })),
      });
    }
    if (bodyNames.length) {
      components.push({
        type: 'body',
        parameters: bodyNames.map(name => ({ type: 'text', parameter_name: name, text: values[name] || '' })),
      });
    }
    return components;
  }

  // Uploaded immediately on choice (not deferred to submit) so a failed
  // upload — bad file type, WhatsApp not connected — surfaces right away,
  // not after the recipient/params are already filled in. Not picking a
  // file at all leaves sendTemplateHeaderMediaAssetId null, which sends
  // headerMediaAssetId as undefined — the backend's existing fallback to
  // the template's approval-time sample (see mediaHeaderService.js).
  document.getElementById('send-chat-template-media-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const status = document.getElementById('send-chat-template-media-status');
    sendTemplateHeaderMediaAssetId = null;
    if (!file || !sendTemplateTarget) { status.textContent = ''; updateSendTemplatePreview(); return; }
    status.textContent = 'Uploading…';
    try {
      const form = new FormData();
      form.append('file', file);
      const asset = await authFetch(`/api/templates/${sendTemplateTarget.id}/header-media`, { method: 'POST', body: form });
      sendTemplateHeaderMediaAssetId = asset.id;
      status.textContent = `Ready — will send with "${file.name}".`;
    } catch (err) {
      status.textContent = `Upload failed: ${err.message}`;
    }
    updateSendTemplatePreview();
  });

  document.getElementById('send-chat-template-submit-btn')?.addEventListener('click', async () => {
    if (!sendTemplateTarget || !state.activeChatId) return;
    setSendTemplateError(null);

    const values = collectSendTemplateParamValues();
    const missing = requiredParamsFor(sendTemplateTarget).filter(p => !values[p]);
    if (missing.length) {
      setSendTemplateError(`Fill in every parameter before sending — missing: ${missing.join(', ')}.`);
      return;
    }

    const btn = document.getElementById('send-chat-template-submit-btn');
    btn.disabled = true;
    try {
      await authFetch(`/api/chats/${state.activeChatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'template',
          templateName: sendTemplateTarget.name,
          templateLanguage: sendTemplateTarget.language,
          templateComponents: buildSendTemplateComponents(sendTemplateTarget, values),
          headerMediaAssetId: sendTemplateHeaderMediaAssetId || undefined,
        }),
      });
      document.getElementById('modal-send-chat-template')?.classList.remove('open');
      await refreshActiveChatMessages();
      showToast('Template sent.');
    } catch (err) {
      // Left open on failure, on purpose — assertConsentForTemplate's
      // "not opted in" message, a session/plan-limit error, or a real Meta
      // rejection all need to be seen and acted on, not flashed in a toast
      // and lost. This is the exact class of failure the window-status
      // banner and this whole picker exist to make visible instead of silent.
      setSendTemplateError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Chat Filters Dropdown ---
  const chatFiltersBtn = document.getElementById('chat-filters-btn');
  const chatFiltersPanel = document.getElementById('chat-filters-panel');

  chatFiltersBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    chatFiltersPanel?.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (chatFiltersPanel && !chatFiltersPanel.contains(e.target) && e.target !== chatFiltersBtn) {
      chatFiltersPanel.classList.remove('open');
    }
  });

  chatFiltersPanel?.querySelectorAll('.filter-option').forEach(btn => {
    btn.addEventListener('click', () => {
      chatFiltersPanel.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderChatList(btn.dataset.tagFilter);
      chatFiltersPanel.classList.remove('open');
    });
  });

  // Chat attachment button is disabled in index.html (no upload backend
  // exists) — used to insert a fake sent-message bubble here with no
  // network call at all. Removed along with it, not left as dead code.

  function renderChatList(tagFilter) {
    const inboxChatList = document.getElementById('inbox-chat-list');
    if (!inboxChatList) return;

    const filter = tagFilter || state.chatTagFilter || 'all';
    state.chatTagFilter = filter;

    inboxChatList.innerHTML = '';
    state.chats.filter(c => filter === 'all' || c.tag === filter).forEach(chat => {
      const itemHTML = `
        <div class="chat-item" data-chat-id="${chat.id}" style="padding: 12px 16px; border-bottom: 1px solid #F1F5F9; display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="chat-avatar" style="width: 36px; height: 36px; font-size: 0.8rem; background: #E2E8F0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600;">
              <i data-lucide="user" style="width:16px; color:#475569;"></i>
            </div>
            <div>
              <div style="font-size: 0.85rem; font-weight: 600; color: #1F2937;">${chat.name}</div>
              <div style="font-size: 0.75rem; color: #6B7280;">WhatsApp</div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
            <span style="font-size: 0.7rem; color: #6B7280;">${chat.time}</span>
            <span style="background: #4AC959; color: white; border-radius: 50%; font-size: 0.7rem; font-weight: 700; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;">${chat.count}</span>
          </div>
        </div>
      `;
      inboxChatList.innerHTML += itemHTML;
    });

    document.querySelectorAll('.chat-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.chatId;
        const selected = state.chats.find(c => c.id === id);
        if (selected) openActiveChat(selected);
      });
    });

    refreshIcons();
  }

  // --- Contacts Table ---
  const OPT_IN_BADGE = {
    opted_in: { label: 'Opted In', bg: '#DCFCE7', color: '#15803D' },
    opted_out: { label: 'Opted Out', bg: '#FEE2E2', color: '#B91C1C' },
    unknown: { label: 'Unknown', bg: '#F1F5F9', color: '#475569' }
  };

  function renderContacts() {
    const contactsTableBody = document.getElementById('contacts-table-body');
    if (!contactsTableBody) return;

    if (!state.contacts.length) {
      contactsTableBody.innerHTML = '<tr><td colspan="6" style="padding:1rem;color:#6B7280;text-align:center;">No contacts yet. Contacts appear here once someone messages your connected WhatsApp number.</td></tr>';
      return;
    }

    contactsTableBody.innerHTML = '';
    state.contacts.forEach(c => {
      const badge = OPT_IN_BADGE[c.optInStatus] || OPT_IN_BADGE.unknown;
      const detail = c.optInSource
        ? `${c.optInSource}${c.optInAt ? ' · ' + c.optInAt.slice(0, 10) : ''}`
        : '—';
      const tr = `
        <tr>
          <td style="font-weight: 600;">${c.name}</td>
          <td>${c.phone}</td>
          <td><span class="tag-badge">${c.tag}</span></td>
          <td><span class="status-badge active">${c.status}</span></td>
          <td>
            <span class="status-badge" style="background: ${badge.bg}; color: ${badge.color};" title="${detail}">${badge.label}</span>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">${detail}</div>
          </td>
          <td>${c.created}</td>
        </tr>
      `;
      contactsTableBody.innerHTML += tr;
    });
  }

  // --- Broadcasts Table ---
  function renderBroadcasts() {
    const broadcastsTableBody = document.getElementById('broadcasts-table-body');
    if (!broadcastsTableBody) return;

    broadcastsTableBody.innerHTML = '';
    state.broadcasts.forEach(b => {
      const skippedCell = b.skippedConsent > 0
        ? `<span class="status-badge" style="background: #FEF3C7; color: #B45309;" title="Contacts not opted in for marketing — skipped, not sent">${b.skippedConsent} skipped</span>`
        : '—';
      const tr = `
        <tr>
          <td style="font-weight: 600;">${b.title}</td>
          <td><span class="tag-badge">${b.tag}</span></td>
          <td><span class="status-badge active">${b.status}</span></td>
          <td>${b.delivered}</td>
          <td>${b.readRate}</td>
          <td>${skippedCell}</td>
          <td>${b.date}</td>
        </tr>
      `;
      broadcastsTableBody.innerHTML += tr;
    });
  }

  // --- Automation Rules ---
  function renderAutomation() {
    const automationRulesGrid = document.getElementById('automation-rules-grid');
    if (!automationRulesGrid) return;

    if (!state.automationRules.length) {
      automationRulesGrid.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">No rules yet.</div>';
      return;
    }

    automationRulesGrid.innerHTML = '';
    state.automationRules.forEach(rule => {
      const actionLine = rule.flow_id
        ? `<strong>Starts flow:</strong> ${escapeHtml(state.flows.find(f => f.id === rule.flow_id)?.name || 'Unknown flow')}`
        : `<strong>Action:</strong> ${escapeHtml(rule.action || '')}`;
      const card = `
        <div style="background: white; border: 1px solid var(--border-light); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-weight: 700; font-size: 1rem; color: var(--color-heading);">${escapeHtml(rule.title)}</span>
            <span class="status-badge active">${escapeHtml(rule.status)}</span>
          </div>
          <div style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;"><strong>Trigger:</strong> ${escapeHtml(rule.trigger)}</div>
          <div style="font-size: 0.875rem; color: var(--text-muted);">${actionLine}</div>
        </div>
      `;
      automationRulesGrid.innerHTML += card;
    });
  }

  // --- Flows (step-list editor) ---
  // Client-side mirror of flowEngine.js's LEGAL_EDGE_TYPES_BY_NODE_TYPE —
  // same duplication reasoning as extractTemplateParams above (no-build-step
  // page, can't require() the server module). The server re-validates on
  // POST .../edges regardless; this only drives which options the "When"
  // dropdown offers, so a legal-but-wrong-looking option is never even shown.
  const FLOW_EDGE_TYPES_BY_NODE_TYPE = {
    send_interactive_buttons: ['button_id', 'keyword', 'default', 'timeout'],
    delay: ['always'],
    send_text: ['always'],
    send_template: ['always'],
    action: ['always'],
    end: [],
  };
  const FLOW_EDGE_TYPE_LABELS = {
    always: 'Always (continues automatically)',
    button_id: 'A specific button is tapped',
    keyword: 'The reply matches a keyword',
    default: "Nothing else matched (fallback)",
    timeout: 'No reply arrives in time',
  };
  const FLOW_NODE_TYPE_LABELS = {
    send_text: 'Send Text', send_interactive_buttons: 'Send Buttons', send_template: 'Send Template',
    delay: 'Delay', action: 'Action', end: 'End',
  };

  async function refreshFlows() {
    state.flows = await authFetch('/api/automation-flows');
  }

  function renderFlowsList() {
    const grid = document.getElementById('bot-flows-grid');
    if (!grid) return;
    if (!state.flows.length) {
      grid.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">No flows yet.</div>';
      return;
    }
    grid.innerHTML = state.flows.map(f => `
      <div class="flow-card" data-flow-id="${f.id}" style="background: white; border: 1px solid var(--border-light); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm); cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 700; font-size: 1rem; color: var(--color-heading);">${escapeHtml(f.name)}</span>
          <span class="status-badge ${f.status === 'active' ? 'active' : ''}">${escapeHtml(f.status)}</span>
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">Click to edit</div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-flow-id]').forEach(card => {
      card.addEventListener('click', () => openFlowEditor(card.getAttribute('data-flow-id')));
    });
  }

  function nodeConfigSummary(node) {
    const c = node.config || {};
    if (node.type === 'send_text') return escapeHtml(c.body || '');
    if (node.type === 'send_interactive_buttons') return `${escapeHtml(c.body || '')} — buttons: ${(c.buttons || []).map(b => escapeHtml(b.title)).join(', ')}`;
    if (node.type === 'send_template') return `Template: ${escapeHtml(c.templateName || '')}`;
    if (node.type === 'delay') return `${c.duration_minutes ?? '?'} minute(s)`;
    if (node.type === 'action') {
      if (c.kind === 'assign_tag') return `Assign tag: ${escapeHtml(state.tagsById[c.tag_id]?.name || c.tag_id || '')}`;
      if (c.kind === 'set_opt_in') return `Set opt-in: ${escapeHtml(c.opt_in_event || '')}`;
      if (c.kind === 'human_handoff') return 'Hand off to a human';
      return escapeHtml(c.kind || '');
    }
    return '';
  }

  function findNode(id) {
    return (state.currentFlowGraph?.nodes || []).find(n => n.id === id);
  }

  async function openFlowEditor(flowId) {
    state.currentFlowGraph = await authFetch(`/api/automation-flows/${flowId}`);
    document.getElementById('bot-flow-editor-title').textContent = state.currentFlowGraph.name;
    document.getElementById('modal-bot-flow-editor')?.classList.add('open');
    const visualLink = document.getElementById('bot-flow-editor-open-visual-link');
    if (visualLink) visualLink.href = `/flow-editor/?flow=${flowId}`;
    state.flowView = 'list';
    renderFlowEditor();
    applyFlowView();
  }

  // Shared by both the list and the canvas — a node's issues need to look
  // identical (same text, same nodes flagged) in both places. The whole
  // point of putting issues on the canvas at all is that a graph which
  // hides the one real bug the spike found (an unrouted button) is worse
  // than the list, not better — see the spike report.
  function issuesByNodeMap(graph) {
    const map = {};
    (graph.issues || []).forEach(issue => {
      if (!issue.nodeId) return;
      (map[issue.nodeId] = map[issue.nodeId] || []).push(issue);
    });
    return map;
  }

  function renderFlowEditor() {
    const graph = state.currentFlowGraph;
    if (!graph) return;

    const issues = graph.issues || [];
    const issuesByNode = issuesByNodeMap(graph);

    const statusBadge = document.getElementById('bot-flow-editor-status-badge');
    statusBadge.textContent = graph.status;
    statusBadge.className = `status-badge ${graph.status === 'active' ? 'active' : ''}`;
    const toggleBtn = document.getElementById('bot-flow-editor-toggle-status-btn');
    toggleBtn.textContent = graph.status === 'active' ? 'Archive Flow' : 'Activate Flow';
    // Only gate the draft/archived -> active direction — archiving an
    // already-active flow never fails validation, so it's never blocked
    // here. The server re-checks regardless (routes/automationFlows.js's
    // PATCH /:id) since this is a convenience, not the real enforcement.
    const blocksActivation = graph.status !== 'active' && issues.length > 0;
    toggleBtn.disabled = blocksActivation;
    toggleBtn.title = blocksActivation ? `Fix ${issues.length} issue${issues.length === 1 ? '' : 's'} before activating this flow.` : '';
    document.getElementById('bot-flow-editor-entry-label').textContent = graph.entry_node_id
      ? `Entry node: ${findNode(graph.entry_node_id)?.type ? FLOW_NODE_TYPE_LABELS[findNode(graph.entry_node_id).type] : '—'}`
      : 'No entry node yet — the first node you add becomes the entry point.';

    const banner = document.getElementById('bot-flow-editor-issues-banner');
    if (banner) {
      banner.innerHTML = issues.length
        ? `<div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.85rem; color: #991B1B;">
            <strong>${issues.length} issue${issues.length === 1 ? '' : 's'} found</strong> — these would fail or misbehave at runtime and block activating this flow.
            <ul style="margin: 0.4rem 0 0; padding-left: 1.2rem;">
              ${issues.map(i => `<li>${escapeHtml(i.message)}</li>`).join('')}
            </ul>
          </div>`
        : '';
    }

    const container = document.getElementById('bot-flow-editor-nodes');
    if (!graph.nodes.length) {
      container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; padding: 1rem 0;">No nodes yet — add one to get started.</div>';
      return;
    }

    container.innerHTML = graph.nodes.map(node => {
      const edges = graph.edges.filter(e => e.from_node_id === node.id);
      const isEntry = node.id === graph.entry_node_id;
      const nodeIssues = issuesByNode[node.id] || [];
      // Reordering only makes sense among non-'default' siblings — a
      // default edge always sorts last regardless of priority
      // (flowEdgesRepo.listForNode), so moving it up/down would be a no-op
      // control that does nothing, which is worse than not offering it.
      const reorderableEdges = edges.filter(e => e.condition_type !== 'default');
      const edgeRows = edges.map(e => {
        const idxInReorderable = reorderableEdges.findIndex(r => r.id === e.id);
        const canReorder = idxInReorderable !== -1;
        const moveButtons = canReorder ? `
          <button type="button" class="move-flow-edge-btn" data-edge-id="${e.id}" data-direction="up" ${idxInReorderable === 0 ? 'disabled' : ''} title="Move up" style="border: none; background: none; color: ${idxInReorderable === 0 ? '#CBD5E1' : '#475569'}; cursor: ${idxInReorderable === 0 ? 'default' : 'pointer'}; font-size: 0.75rem; padding: 0 2px;">&uarr;</button>
          <button type="button" class="move-flow-edge-btn" data-edge-id="${e.id}" data-direction="down" ${idxInReorderable === reorderableEdges.length - 1 ? 'disabled' : ''} title="Move down" style="border: none; background: none; color: ${idxInReorderable === reorderableEdges.length - 1 ? '#CBD5E1' : '#475569'}; cursor: ${idxInReorderable === reorderableEdges.length - 1 ? 'default' : 'pointer'}; font-size: 0.75rem; padding: 0 2px;">&darr;</button>
        ` : '';
        return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.6rem; background: #F8FAFC; border-radius: 6px; margin-top: 0.4rem; font-size: 0.8rem;">
          <span>${FLOW_EDGE_TYPE_LABELS[e.condition_type] || e.condition_type}${e.condition_value ? ` "${escapeHtml(e.condition_value)}"` : ''} &rarr; ${escapeHtml(findNode(e.to_node_id) ? FLOW_NODE_TYPE_LABELS[findNode(e.to_node_id).type] : '—')}</span>
          <span style="display: flex; align-items: center; gap: 4px;">
            ${moveButtons}
            <button type="button" class="delete-flow-edge-btn" data-edge-id="${e.id}" style="border: none; background: none; color: #DC2626; cursor: pointer; font-size: 0.75rem;">Remove</button>
          </span>
        </div>
      `;
      }).join('');
      const canAddEdge = (FLOW_EDGE_TYPES_BY_NODE_TYPE[node.type] || []).length > 0;
      const issueRows = nodeIssues.length ? `
        <div style="background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 6px; padding: 0.5rem 0.7rem; margin: 0.5rem 0; font-size: 0.78rem; color: #991B1B;">
          ${nodeIssues.map(i => `<div>${escapeHtml(i.message)}</div>`).join('')}
        </div>
      ` : '';
      return `
        <div style="border: 1px solid ${nodeIssues.length ? '#FCA5A5' : 'var(--border-light)'}; border-radius: 10px; padding: 1rem; margin-bottom: 0.75rem;" data-node-id="${node.id}">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-weight: 700;">${FLOW_NODE_TYPE_LABELS[node.type] || node.type}</span>
              ${isEntry ? '<span class="status-badge active" style="margin-left: 8px; font-size: 0.7rem;">Entry</span>' : ''}
            </div>
            <div style="display: flex; gap: 8px;">
              ${!isEntry ? `<button type="button" class="set-entry-node-btn btn-secondary" data-node-id="${node.id}" style="width: auto; padding: 2px 10px; font-size: 0.75rem;">Set as Entry</button>` : ''}
              <button type="button" class="delete-flow-node-btn" data-node-id="${node.id}" style="border: none; background: none; color: #DC2626; cursor: pointer; font-size: 0.8rem;"><i data-lucide="trash-2" style="width: 14px;"></i></button>
            </div>
          </div>
          <div style="font-size: 0.85rem; color: var(--text-muted); margin: 0.5rem 0;">${nodeConfigSummary(node)}</div>
          ${issueRows}
          ${edgeRows}
          ${canAddEdge ? `<button type="button" class="add-flow-edge-btn btn-secondary" data-node-id="${node.id}" style="width: auto; padding: 2px 10px; font-size: 0.75rem; margin-top: 0.5rem;"><i data-lucide="plus" style="width: 12px;"></i> Add Branch</button>` : ''}
        </div>
      `;
    }).join('');
    refreshIcons();
  }

  // BFS depth from the entry node (or, absent one, from every node with no
  // incoming edge) picks each node's column; nodes at the same depth stack
  // in a column. Cycle-safe via the depth-already-set check — flowEngine.js
  // explicitly supports a self-loop edge (e.g. "didn't understand, repeat"),
  // which would infinite-loop a naive BFS without one. Anything never
  // reached (a disconnected node, or a flow with zero edges at all) gets
  // appended as its own trailing column rather than silently vanishing.
  // Only used as a FALLBACK for a node whose real flow_nodes.position is
  // null — which is every node today, since nothing has ever written to
  // that column (see migration 023's comment) — but a node WITH a real
  // stored position always wins over this.
  function computeFlowLayout(graph) {
    const incoming = {};
    graph.edges.forEach(e => { incoming[e.to_node_id] = true; });
    const roots = graph.entry_node_id
      ? [graph.entry_node_id]
      : graph.nodes.filter(n => !incoming[n.id]).map(n => n.id);

    const edgesByFrom = {};
    graph.edges.forEach(e => { (edgesByFrom[e.from_node_id] = edgesByFrom[e.from_node_id] || []).push(e); });

    const depth = {};
    roots.forEach(id => { depth[id] = 0; });
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift();
      (edgesByFrom[id] || []).forEach(e => {
        if (depth[e.to_node_id] === undefined) {
          depth[e.to_node_id] = depth[id] + 1;
          queue.push(e.to_node_id);
        }
      });
    }

    let nextCol = Math.max(-1, ...Object.values(depth)) + 1;
    graph.nodes.forEach(n => { if (depth[n.id] === undefined) depth[n.id] = nextCol++; });

    const colCounts = {};
    const positions = {};
    graph.nodes.forEach(n => {
      const col = depth[n.id];
      positions[n.id] = { x: 60 + col * 320, y: 40 + (colCounts[col] || 0) * 190 };
      colCounts[col] = (colCounts[col] || 0) + 1;
    });
    return positions;
  }

  function flowCanvasEdgeLabel(fromNode, edge) {
    if (edge.condition_type === 'button_id') {
      const button = (fromNode.config?.buttons || []).find(b => b.id === edge.condition_value);
      return button ? `"${button.title}"` : `button "${edge.condition_value}"`;
    }
    if (edge.condition_type === 'keyword') return `"${edge.condition_value}"`;
    return FLOW_EDGE_TYPE_LABELS[edge.condition_type] || edge.condition_type;
  }

  function jumpToListNode(nodeId) {
    state.flowView = 'list';
    applyFlowView();
    requestAnimationFrame(() => {
      const card = document.querySelector(`#bot-flow-editor-nodes [data-node-id="${nodeId}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.transition = 'background-color 0.3s';
      card.style.backgroundColor = '#FEF9C3';
      setTimeout(() => { card.style.backgroundColor = ''; }, 1200);
    });
  }

  // Read-only render — editor.editor_mode = 'view' below, no drag, no
  // add/remove. Every issue the step list shows is shown here too (same
  // issuesByNodeMap), on the node itself: the spike found a plain graph
  // hides an unrouted button completely, and a pretty picture that hides
  // the one real bug in the only real flow tested is worse than the list.
  function renderFlowCanvas() {
    const graph = state.currentFlowGraph;
    const container = document.getElementById('bot-flow-editor-canvas');
    if (!graph || !container) return;

    if (typeof Drawflow === 'undefined') {
      container.innerHTML = '<div style="padding:1rem; color:var(--text-muted); font-size:0.85rem;">Canvas library failed to load — check your connection and reopen this flow. The list above still works.</div>';
      return;
    }

    container.innerHTML = '';
    const editor = new Drawflow(container);
    editor.reroute = true;
    editor.start();
    state.flowCanvasEditor = editor;

    if (!graph.nodes.length) {
      container.innerHTML = '<div style="padding:1rem; color:var(--text-muted); font-size:0.85rem;">No nodes yet.</div>';
      return;
    }

    const issuesByNode = issuesByNodeMap(graph);
    const layout = computeFlowLayout(graph);
    const incoming = {};
    graph.edges.forEach(e => { incoming[e.to_node_id] = true; });
    const edgesByFrom = {};
    graph.edges.forEach(e => { (edgesByFrom[e.from_node_id] = edgesByFrom[e.from_node_id] || []).push(e); });

    const nodeIdToDfId = {};
    const usedConditionTypes = new Set();

    graph.nodes.forEach(node => {
      // Real, persisted position wins whenever one exists — this reads
      // flow_nodes.position, it doesn't only ever compute its own layout.
      // It's always the fallback today only because nothing has ever
      // written to that column yet (no editor does).
      const pos = node.position || layout[node.id] || { x: 0, y: 0 };
      const isEntry = node.id === graph.entry_node_id;
      const nodeIssues = issuesByNode[node.id] || [];
      const outEdges = edgesByFrom[node.id] || [];

      const outputRows = outEdges.map(e => {
        usedConditionTypes.add(e.condition_type);
        return `<div style="font-size:0.68rem; color:#666; padding:2px 0; border-top:1px dashed #E5E7EB;">&rarr; ${escapeHtml(flowCanvasEdgeLabel(node, e))}</div>`;
      }).join('');

      const html = `<div class="flow-canvas-node-inner">
        ${isEntry ? '<span class="flow-canvas-entry-badge">ENTRY</span><br>' : ''}
        <div class="flow-canvas-node-type">${escapeHtml(FLOW_NODE_TYPE_LABELS[node.type] || node.type)}</div>
        <div class="flow-canvas-node-body">${nodeConfigSummary(node) || '&nbsp;'}</div>
        ${outputRows ? `<div style="margin-top:4px;">${outputRows}</div>` : ''}
        ${nodeIssues.length ? `<div class="flow-canvas-node-issue">${nodeIssues.map(i => escapeHtml(i.message)).join('<br>')}</div>` : ''}
      </div>`;

      const dfId = editor.addNode(node.type, incoming[node.id] ? 1 : 0, outEdges.length, pos.x, pos.y, node.type, {}, html, false);
      nodeIdToDfId[node.id] = dfId;

      const nodeEl = container.querySelector(`#node-${dfId}`);
      if (nodeEl) {
        if (nodeIssues.length) nodeEl.classList.add('flow-node-issue');
        if (isEntry) nodeEl.classList.add('flow-node-entry');
      }
    });

    const outputCounters = {};
    graph.edges.forEach(e => {
      outputCounters[e.from_node_id] = (outputCounters[e.from_node_id] || 0) + 1;
      const fromDfId = nodeIdToDfId[e.from_node_id];
      const toDfId = nodeIdToDfId[e.to_node_id];
      if (fromDfId == null || toDfId == null) return; // dangling edge — flowValidation already flags this on the node; nothing to draw
      editor.addConnection(fromDfId, toDfId, `output_${outputCounters[e.from_node_id]}`, 'input_1');
    });

    // Color each connection by condition_type — Drawflow's addConnection
    // takes no per-connection class, so this is a direct DOM pass matching
    // its own node_in_node-X/node_out_node-Y class pair (confirmed against
    // the real library in the earlier spike).
    graph.edges.forEach(e => {
      const fromDfId = nodeIdToDfId[e.from_node_id];
      const toDfId = nodeIdToDfId[e.to_node_id];
      if (fromDfId == null || toDfId == null) return;
      container.querySelectorAll(`.connection.node_in_node-${toDfId}.node_out_node-${fromDfId}`)
        .forEach(el => el.classList.add(`flow-edge-${e.condition_type}`));
    });

    editor.editor_mode = 'view';

    const legend = document.getElementById('bot-flow-editor-canvas-legend');
    if (legend) {
      const swatchColor = { button_id: '#1E6E5A', keyword: '#2E5F8A', default: '#9A6A1F', timeout: '#A4402F', always: '#888' };
      legend.innerHTML = [...usedConditionTypes].map(ct => `
        <span style="display:flex; align-items:center; gap:4px;">
          <span style="width:10px; height:10px; border-radius:50%; background:${swatchColor[ct] || '#888'}; display:inline-block;"></span>
          ${escapeHtml(FLOW_EDGE_TYPE_LABELS[ct] || ct)}
        </span>
      `).join('');
    }

    // The canvas's one interaction — click a node, land on the same node
    // in the list, where editing actually happens. It never edits anything
    // itself. A direct delegated DOM click, not Drawflow's own
    // 'nodeSelected' event — confirmed live that event doesn't fire once
    // editor_mode is 'view' (selection is part of what view mode disables,
    // not just dragging), so this reads the clicked node's own
    // Drawflow-assigned id="node-<n>" instead, which view mode does not
    // remove.
    container.addEventListener('click', (e) => {
      const nodeEl = e.target.closest('[id^="node-"]');
      if (!nodeEl) return;
      const dfId = Number(nodeEl.id.replace('node-', ''));
      const nodeId = Object.keys(nodeIdToDfId).find((id) => nodeIdToDfId[id] === dfId);
      if (nodeId) jumpToListNode(nodeId);
    });
  }

  function applyFlowView() {
    const listEl = document.getElementById('bot-flow-editor-nodes');
    const canvasWrapEl = document.getElementById('bot-flow-editor-canvas-wrap');
    if (!listEl || !canvasWrapEl) return;
    document.querySelectorAll('.flow-view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.flowView === state.flowView);
    });
    if (state.flowView === 'canvas') {
      listEl.style.display = 'none';
      canvasWrapEl.style.display = '';
      renderFlowCanvas();
    } else {
      listEl.style.display = '';
      canvasWrapEl.style.display = 'none';
    }
  }

  document.querySelectorAll('.flow-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.flowView = btn.dataset.flowView;
      applyFlowView();
    });
  });
  document.getElementById('bot-flow-canvas-zoom-in-btn')?.addEventListener('click', () => state.flowCanvasEditor?.zoom_in());
  document.getElementById('bot-flow-canvas-zoom-out-btn')?.addEventListener('click', () => state.flowCanvasEditor?.zoom_out());
  document.getElementById('bot-flow-canvas-zoom-reset-btn')?.addEventListener('click', () => state.flowCanvasEditor?.zoom_reset());

  function renderNewNodeConfigFields(type) {
    const container = document.getElementById('new-bot-flow-node-config-fields');
    if (type === 'send_text') {
      container.innerHTML = `
        <div class="form-group"><label class="form-label">Message</label><textarea id="new-bot-flow-node-body" class="form-input" rows="3" required></textarea></div>
      `;
    } else if (type === 'send_interactive_buttons') {
      container.innerHTML = `
        <div class="form-group"><label class="form-label">Message</label><textarea id="new-bot-flow-node-body" class="form-input" rows="3" required></textarea></div>
        <div class="form-group"><label class="form-label">Button 1</label><input type="text" id="new-bot-flow-node-btn-1" class="form-input" maxlength="20" required /></div>
        <div class="form-group"><label class="form-label">Button 2 (optional)</label><input type="text" id="new-bot-flow-node-btn-2" class="form-input" maxlength="20" /></div>
        <div class="form-group"><label class="form-label">Button 3 (optional)</label><input type="text" id="new-bot-flow-node-btn-3" class="form-input" maxlength="20" /></div>
        <div class="form-group"><label class="form-label">Timeout, minutes (optional — only used if a "no reply" branch is added)</label><input type="number" id="new-bot-flow-node-timeout" class="form-input" min="1" step="any" /></div>
      `;
    } else if (type === 'send_template') {
      const options = state.templates.filter(t => t.status === 'approved').map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');
      container.innerHTML = `
        <div class="form-group"><label class="form-label">Template</label><select id="new-bot-flow-node-template" class="form-input">${options}</select></div>
        <div id="new-bot-flow-node-template-params"></div>
      `;
      document.getElementById('new-bot-flow-node-template')?.addEventListener('change', renderNewNodeTemplateParams);
      renderNewNodeTemplateParams();
    } else if (type === 'delay') {
      container.innerHTML = `
        <div class="form-group"><label class="form-label">Duration (minutes)</label><input type="number" id="new-bot-flow-node-duration" class="form-input" min="0" step="any" required /></div>
      `;
    } else if (type === 'action') {
      container.innerHTML = `
        <div class="form-group"><label class="form-label">Action Kind</label>
          <select id="new-bot-flow-node-action-kind" class="form-input">
            <option value="assign_tag">Assign Tag</option>
            <option value="set_opt_in">Set Opt-In Status</option>
            <option value="human_handoff">Hand Off to a Human</option>
          </select>
        </div>
        <div id="new-bot-flow-node-action-fields"></div>
      `;
      document.getElementById('new-bot-flow-node-action-kind')?.addEventListener('change', renderNewNodeActionFields);
      renderNewNodeActionFields();
    } else {
      container.innerHTML = '<div style="font-size: 0.85rem; color: var(--text-muted);">Ends the flow — nothing further to configure.</div>';
    }
  }

  function renderNewNodeTemplateParams() {
    const container = document.getElementById('new-bot-flow-node-template-params');
    const name = document.getElementById('new-bot-flow-node-template')?.value;
    const template = state.templates.find(t => t.name === name);
    if (!container || !template) { if (container) container.innerHTML = ''; return; }
    const params = extractTemplateParams(template.body || '');
    if (template.header_type === 'TEXT' && template.header_content) {
      extractTemplateParams(template.header_content).forEach(p => { if (!params.includes(p)) params.push(p); });
    }
    if (!params.length) { container.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted);">This template has no parameters.</div>'; return; }
    container.innerHTML = params.map(p => `
      <div class="form-group param-map-row" data-param="${escapeHtml(p)}">
        <label class="form-label">{{${escapeHtml(p)}}}</label>
        <select class="form-input param-map-source">
          <option value="contact_field:name">Contact Name</option>
          <option value="contact_field:phone">Contact Phone</option>
          <option value="static">Static Value</option>
        </select>
        <input type="text" class="form-input param-map-static-value" placeholder="Value" style="display: none; margin-top: 6px;" />
      </div>
    `).join('');
    container.querySelectorAll('.param-map-source').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const staticInput = e.target.closest('.param-map-row').querySelector('.param-map-static-value');
        staticInput.style.display = e.target.value === 'static' ? '' : 'none';
      });
    });
  }

  function renderNewNodeActionFields() {
    const container = document.getElementById('new-bot-flow-node-action-fields');
    const kind = document.getElementById('new-bot-flow-node-action-kind')?.value;
    if (!container) return;
    if (kind === 'assign_tag') {
      const options = Object.values(state.tagsById).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      container.innerHTML = `<div class="form-group"><label class="form-label">Tag</label><select id="new-bot-flow-node-tag-id" class="form-input">${options}</select></div>`;
    } else if (kind === 'set_opt_in') {
      container.innerHTML = `
        <div class="form-group"><label class="form-label">New Status</label>
          <select id="new-bot-flow-node-opt-in-event" class="form-input">
            <option value="opted_in">Opted In</option>
            <option value="opted_out">Opted Out</option>
          </select>
        </div>
      `;
    } else {
      container.innerHTML = '';
    }
  }

  function collectNewNodeConfig(type) {
    if (type === 'send_text') {
      return { body: document.getElementById('new-bot-flow-node-body').value.trim() };
    }
    if (type === 'send_interactive_buttons') {
      const buttons = [];
      [1, 2, 3].forEach(i => {
        const title = document.getElementById(`new-bot-flow-node-btn-${i}`)?.value.trim();
        if (title) buttons.push({ id: `btn_${i}`, title });
      });
      const timeoutVal = document.getElementById('new-bot-flow-node-timeout').value;
      return {
        body: document.getElementById('new-bot-flow-node-body').value.trim(),
        buttons,
        ...(timeoutVal ? { timeout_minutes: Number(timeoutVal) } : {}),
      };
    }
    if (type === 'send_template') {
      const templateName = document.getElementById('new-bot-flow-node-template').value;
      const paramMappings = {};
      document.querySelectorAll('#new-bot-flow-node-template-params .param-map-row').forEach(row => {
        const param = row.dataset.param;
        const sourceVal = row.querySelector('.param-map-source').value;
        if (sourceVal === 'static') {
          paramMappings[param] = { source: 'static', value: row.querySelector('.param-map-static-value').value.trim() };
        } else {
          const [, field] = sourceVal.split(':');
          paramMappings[param] = { source: 'contact_field', field };
        }
      });
      return { templateName, paramMappings };
    }
    if (type === 'delay') {
      return { duration_minutes: Number(document.getElementById('new-bot-flow-node-duration').value) };
    }
    if (type === 'action') {
      const kind = document.getElementById('new-bot-flow-node-action-kind').value;
      if (kind === 'assign_tag') return { kind, tag_id: document.getElementById('new-bot-flow-node-tag-id').value };
      if (kind === 'set_opt_in') return { kind, opt_in_event: document.getElementById('new-bot-flow-node-opt-in-event').value };
      return { kind };
    }
    return {};
  }

  // --- Support Tickets ---
  const TICKET_STATUS_COLORS = {
    open: { bg: '#FEF3C7', color: '#B45309' },
    in_progress: { bg: '#DBEAFE', color: '#1D4ED8' },
    resolved: { bg: '#DCFCE7', color: '#15803D' },
    closed: { bg: '#F1F5F9', color: '#475569' }
  };

  function renderTickets() {
    const ticketsList = document.getElementById('tickets-list');
    if (!ticketsList) return;

    if (!state.tickets.length) {
      ticketsList.innerHTML = '<div class="empty-state">No support tickets yet.</div>';
      return;
    }

    ticketsList.innerHTML = state.tickets.map(t => {
      const colors = TICKET_STATUS_COLORS[t.status] || TICKET_STATUS_COLORS.open;
      return `
        <div style="background: white; border: 1px solid var(--border-light); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm); margin-bottom: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <span style="font-weight: 700; font-size: 1rem; color: var(--color-heading);">${t.subject}</span>
            <span class="status-badge" style="background: ${colors.bg}; color: ${colors.color};">${t.status.replace('_', ' ')}</span>
          </div>
          <p style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;">${t.message}</p>
          <div style="font-size: 0.75rem; color: var(--text-muted);">Opened ${new Date(t.created_at).toLocaleDateString()}</div>
        </div>
      `;
    }).join('');
  }

  // --- Templates Grid ---
  const TEMPLATE_STATUS_LABELS = {
    approved: 'Approved',
    pending: 'Pending',
    rejected: 'Rejected',
    paused: 'Paused',
    disabled: 'Disabled',
    pending_deletion: 'Pending Deletion',
    in_appeal: 'In Appeal',
  };

  function renderTemplates() {
    const templatesGrid = document.getElementById('templates-grid');
    if (!templatesGrid) return;

    if (!state.templates.length) {
      templatesGrid.innerHTML = '<p style="padding:1rem;color:#6B7280;">No templates yet. Connect a WhatsApp number to sync approved templates, or create one from Meta Business Manager.</p>';
      return;
    }

    templatesGrid.innerHTML = state.templates.map((t) => {
      const status = t.status || 'pending';
      const statusClass = status.replace(/_/g, '-');
      const statusLabel = TEMPLATE_STATUS_LABELS[status] || status;
      // Authentication templates have no author-written body — Meta
      // generates that text itself (see metaClient.js's
      // buildAuthenticationPayload) — so t.body is null for these, not a
      // display bug to work around with a fallback string.
      const bodyPreview = t.category === 'Authentication'
        ? 'Meta-generated verification message (code delivery, expiration notice, security disclaimer).'
        : escapeHtml(t.body || '');
      const rejectionNote = status === 'rejected' && t.rejection_reason
        ? `<p class="template-rejection-reason">${escapeHtml(t.rejection_reason)}</p>`
        : '';
      // orphaned_at: this row was previously confirmed to exist on Meta
      // (has a meta_template_id) but the last sync didn't find it there
      // anymore — most likely deleted directly in Business Manager. Never
      // deleted locally (see templateSyncService.js) — surfaced instead,
      // so it doesn't just silently vanish from view with no explanation.
      const orphanedNote = t.orphaned_at
        ? `<p class="template-rejection-reason">Not found on Meta as of the last sync — may have been deleted in WhatsApp Manager.</p>`
        : '';

      return `
        <div class="template-card">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span style="font-weight: 700; word-break: break-word; min-width: 0;">${escapeHtml(t.name)}</span>
              <span class="template-badge ${statusClass}" style="flex-shrink: 0; white-space: nowrap;">${escapeHtml(statusLabel)}</span>
            </div>
            <p style="font-size: 0.85rem; color: #4B5563; line-height: 1.4;">${bodyPreview}</p>
            ${rejectionNote}
            ${orphanedNote}
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
            <div style="font-size: 0.75rem; color: #6B7280; font-weight: 600;">Category: ${escapeHtml(t.category)}</div>
            <div style="display: flex; gap: 0.25rem;">
              <button type="button" class="preview-template-btn" data-preview-template="${t.id}" title="Preview in chat" style="border: none; background: none; color: #4B5563; cursor: pointer; padding: 0.25rem;"><i data-lucide="eye" style="width: 14px;"></i></button>
              <button type="button" class="edit-template-btn" data-edit-template="${t.id}" title="Edit template" style="border: none; background: none; color: #4B5563; cursor: pointer; padding: 0.25rem;"><i data-lucide="pencil" style="width: 14px;"></i></button>
              <button type="button" class="delete-template-btn" data-delete-template="${t.id}" title="Delete template" style="border: none; background: none; color: #DC2626; cursor: pointer; padding: 0.25rem;"><i data-lucide="trash-2" style="width: 14px;"></i></button>
            </div>
          </div>
        </div>
      `;
    }).join('');
    refreshIcons();
  }

  // --- Template Library (wasi-master-plan.md §2) ---
  // "Use this Template" reuses the EXISTING Create Template modal/submit
  // path entirely (open-create-template-modal's own handler, above) — this
  // section only ever populates that form's fields and opens it; it never
  // POSTs to /api/templates itself. GET /api/template-library and
  // POST /api/template-library/:id/use (usage logging only) are the only
  // new endpoints this feature touches.

  // Meta template names must be lowercase/underscore only
  // (messageTemplateCreateSchema's regex) and unique per client+language —
  // this is a starting suggestion, not a guaranteed-unique final value; the
  // name field stays fully editable and a real collision surfaces the
  // existing 409 error same as any manually-typed name would.
  function slugifyTemplateName(title) {
    const slug = (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    return slug || 'template';
  }

  function populateLibraryFilterOptions() {
    const useCases = [...new Set(state.libraryEntries.map((t) => t.use_case))].sort();

    const useCaseSelect = document.getElementById('library-filter-use-case');
    if (useCaseSelect) {
      const current = useCaseSelect.value;
      useCaseSelect.innerHTML = '<option value="">All Use Cases</option>' +
        useCases.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u.replace(/_/g, ' '))}</option>`).join('');
      useCaseSelect.value = current;
    }
  }

  function filteredLibraryEntries() {
    const category = document.getElementById('library-filter-category')?.value || '';
    const useCase = document.getElementById('library-filter-use-case')?.value || '';
    return state.libraryEntries.filter((t) =>
      (!category || t.category === category) &&
      (!useCase || t.use_case === useCase)
    );
  }

  function libraryTemplateCardHtml(t) {
    const preview = t.category === 'Authentication'
      ? 'Meta-generated verification message (code delivery, expiration notice).'
      : escapeHtml((t.body || '').length > 90 ? `${t.body.slice(0, 90)}…` : (t.body || ''));
    const selected = state.librarySelectedEntry?.id === t.id ? ' selected' : '';
    return `
      <div class="template-card library-template-card${selected}" data-library-id="${t.id}">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.5rem;">
            <span style="font-weight: 700; word-break: break-word; min-width: 0;">${escapeHtml(t.title)}</span>
            <span class="template-badge approved" style="flex-shrink: 0; white-space: nowrap;">${escapeHtml(t.category)}</span>
          </div>
          <p style="font-size: 0.85rem; color: #4B5563; line-height: 1.4;">${preview}</p>
        </div>
        <div style="font-size: 0.75rem; color: #6B7280; font-weight: 600;">${escapeHtml(t.use_case.replace(/_/g, ' '))}</div>
      </div>
    `;
  }

  // One section per industry, always visible (not gated behind a filter) —
  // each section names its industry and lists its own templates below it,
  // same layout for every industry. Category/use-case dropdowns still narrow
  // which cards show up within each section.
  function renderLibraryGrid() {
    const grid = document.getElementById('library-grid');
    if (!grid) return;
    const entries = filteredLibraryEntries();

    if (!entries.length) {
      grid.innerHTML = '<p style="padding:1rem;color:#6B7280;">No templates match these filters.</p>';
      return;
    }

    const industries = [...new Set(state.libraryEntries.map((t) => t.industry))];
    const sections = industries
      .map((industry) => ({ industry, items: entries.filter((t) => t.industry === industry) }))
      .filter((section) => section.items.length > 0);

    grid.innerHTML = sections.map(({ industry, items }) => `
      <div class="library-industry-section" data-industry="${escapeHtml(industry)}" style="margin-bottom: 1.75rem;">
        <h3 style="margin: 0 0 0.85rem; font-size: 1rem; display:flex; align-items:baseline; gap:0.5rem;">
          ${escapeHtml(industry)}
          <span style="font-weight: 400; color: #6B7280; font-size: 0.8rem;">${items.length} template${items.length === 1 ? '' : 's'}</span>
        </h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem;">
          ${items.map(libraryTemplateCardHtml).join('')}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('[data-library-id]').forEach((card) => {
      card.addEventListener('click', () => selectLibraryEntry(card.dataset.libraryId));
    });
  }

  function selectLibraryEntry(id) {
    const entry = state.libraryEntries.find((t) => t.id === id);
    if (!entry) return;
    state.librarySelectedEntry = entry;
    renderLibraryGrid();
    renderLibraryPreview(entry);
  }

  // Same WhatsApp-bubble preview markup/CSS as the Create Template modal's
  // own preview (template-preview-frame/-bubble/-header/-footer/-buttons) —
  // reused as-is, not reimplemented, so a library preview and the modal's
  // preview of the same content always look identical.
  function renderLibraryPreview(entry) {
    const panel = document.getElementById('library-preview-panel');
    if (!panel) return;

    let bubbleHtml;
    if (entry.category === 'Authentication') {
      bubbleHtml = `
        <div>Your verification code is *123456*. For your security, do not share this code with anyone.</div>
        <div class="template-preview-buttons"><div class="template-preview-button">&#128203; Copy Code</div></div>
      `;
    } else {
      const samples = entry.sample_values_json || {};
      let html = '';
      if (entry.header_type === 'TEXT' && entry.header_content) {
        html += `<div class="template-preview-header">${escapeHtml(substituteTemplateParams(entry.header_content, samples))}</div>`;
      }
      html += `<div>${escapeHtml(substituteTemplateParams(entry.body, samples))}</div>`;
      if (entry.footer) {
        html += `<div class="template-preview-footer">${escapeHtml(entry.footer)}</div>`;
      }
      const buttons = entry.buttons_json || [];
      if (buttons.length) {
        const icon = { URL: '&#128279;', PHONE_NUMBER: '&#128222;', QUICK_REPLY: '&#8617;' };
        html += `<div class="template-preview-buttons">${buttons.map((b) =>
          `<div class="template-preview-button">${icon[b.type] || ''} ${escapeHtml(b.text || '')}</div>`
        ).join('')}</div>`;
      }
      bubbleHtml = html;
    }

    panel.innerHTML = `
      <div class="library-preview-meta">${escapeHtml(entry.industry)} &middot; ${escapeHtml(entry.use_case.replace(/_/g, ' '))} &middot; ${escapeHtml(entry.category)}</div>
      <h3 style="margin:0 0 0.75rem;">${escapeHtml(entry.title)}</h3>
      <div class="template-preview-frame">
        <div class="msg-bubble msg-out template-preview-bubble" id="library-preview-bubble"></div>
      </div>
      <p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.75rem;">Pre-vetted against Meta's policy — first-attempt approval rates are higher, but this is not a guarantee of approval. Review and customize before submitting.</p>
      <button type="button" class="btn-primary" style="margin-top:0.5rem;" id="use-library-template-btn">Use This Template</button>
    `;
    const bubble = document.getElementById('library-preview-bubble');
    if (bubble) bubble.innerHTML = bubbleHtml;
    document.getElementById('use-library-template-btn')?.addEventListener('click', () => useTemplateFromLibrary(entry));
  }

  async function loadTemplateLibrary() {
    const grid = document.getElementById('library-grid');
    try {
      const entries = await authFetch('/api/template-library');
      state.libraryEntries = entries;
      populateLibraryFilterOptions();
      renderLibraryGrid();
    } catch (err) {
      if (grid) grid.innerHTML = '<p style="padding:1rem;color:#B91C1C;">Could not load the template library. Please try again.</p>';
    }
  }

  // --- Meta Official Template Library (wasi-master-plan.md §2b) ---
  // A second, clearly separate source from state.libraryEntries above —
  // never merged into the same array/grid (Phase 0 decision: conflating the
  // two would mislead a client about which templates still need to wait for
  // Meta's review). GET /api/template-library/meta already only returns
  // zero-variable entries (server-side filter, routes/templateLibrary.js) —
  // this UI doesn't need to re-check that itself.
  const LIBRARY_SOURCE_SUBTITLES = {
    wasi: 'Pre-vetted, ready-to-customize WhatsApp templates by industry — checked against Meta\'s real policy, first-attempt approval rates are higher, but nothing here is guaranteed approved. Pick one, adjust it, and submit it as your own.',
    meta: 'Meta\'s own official template catalog — fixed content, Utility category only, written and pre-approved by Meta itself. Using one skips the normal review wait entirely; you can only fill in a name and any button destinations, not the wording.',
  };

  function switchLibrarySource(source) {
    document.getElementById('library-source-subtitle').textContent = LIBRARY_SOURCE_SUBTITLES[source];
    document.getElementById('library-source-wasi').style.display = source === 'wasi' ? '' : 'none';
    document.getElementById('library-source-meta').style.display = source === 'meta' ? '' : 'none';
    document.querySelectorAll('.library-source-tab').forEach((btn) => {
      const active = btn.dataset.librarySource === source;
      btn.classList.toggle('active', active);
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
    });
  }

  document.querySelectorAll('.library-source-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchLibrarySource(btn.dataset.librarySource));
  });

  async function loadMetaTemplateLibrary() {
    const grid = document.getElementById('meta-library-grid');
    try {
      const entries = await authFetch('/api/template-library/meta');
      state.metaLibraryEntries = entries;
      const useCaseSelect = document.getElementById('meta-library-filter-usecase');
      if (useCaseSelect) {
        const useCases = [...new Set(entries.map((e) => e.usecase).filter(Boolean))].sort();
        const current = useCaseSelect.value;
        useCaseSelect.innerHTML = '<option value="">All Use Cases</option>' +
          useCases.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u.replace(/_/g, ' '))}</option>`).join('');
        useCaseSelect.value = current;
      }
      renderMetaLibraryGrid();
    } catch (err) {
      if (grid) grid.innerHTML = '<p style="padding:1rem;color:#B91C1C;">Could not load Meta\'s template library. Please try again.</p>';
    }
  }

  function filteredMetaLibraryEntries() {
    const useCase = document.getElementById('meta-library-filter-usecase')?.value || '';
    const search = (document.getElementById('meta-library-search')?.value || '').trim().toLowerCase();
    return state.metaLibraryEntries.filter((e) =>
      (!useCase || e.usecase === useCase) &&
      (!search || e.name.toLowerCase().includes(search) || (e.body || '').toLowerCase().includes(search))
    );
  }

  function renderMetaLibraryGrid() {
    const grid = document.getElementById('meta-library-grid');
    if (!grid) return;
    const entries = filteredMetaLibraryEntries();

    if (!entries.length) {
      grid.innerHTML = '<p style="padding:1rem;color:#6B7280;">No templates match these filters.</p>';
      return;
    }

    grid.innerHTML = entries.map((e) => {
      const selected = state.metaLibrarySelectedEntry?.id === e.id ? ' selected' : '';
      const preview = escapeHtml((e.body || '').length > 90 ? `${e.body.slice(0, 90)}…` : (e.body || ''));
      return `
        <div class="template-card library-template-card${selected}" data-meta-library-id="${e.id}">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span style="font-weight: 700; word-break: break-word; min-width: 0;">${escapeHtml(e.name)}</span>
              <span class="template-badge approved" style="flex-shrink: 0; white-space: nowrap;">Meta Official</span>
            </div>
            <p style="font-size: 0.85rem; color: #4B5563; line-height: 1.4;">${preview}</p>
          </div>
          <div style="font-size: 0.75rem; color: #6B7280; font-weight: 600;">${escapeHtml((e.usecase || '').replace(/_/g, ' ') || 'General')}</div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('[data-meta-library-id]').forEach((card) => {
      card.addEventListener('click', () => selectMetaLibraryEntry(card.dataset.metaLibraryId));
    });
  }

  function selectMetaLibraryEntry(id) {
    const entry = state.metaLibraryEntries.find((e) => e.id === id);
    if (!entry) return;
    state.metaLibrarySelectedEntry = entry;
    renderMetaLibraryGrid();
    renderMetaLibraryPreview(entry);
  }

  // Same template-preview-bubble markup as everything else in this app
  // (renderTemplateBubbleMarkup, shared with the Create Template modal and
  // the read-only per-card preview) — a small field-name adapter since this
  // entry comes from meta_template_library_cache's own column names
  // (header_text/buttons_json), not message_templates'.
  function renderMetaLibraryPreview(entry) {
    const panel = document.getElementById('meta-library-preview-panel');
    if (!panel) return;

    const bubbleShim = {
      header_type: entry.header_text ? 'TEXT' : 'NONE',
      header_content: entry.header_text,
      body: entry.body,
      footer_text: entry.footer_text,
      buttons: entry.buttons_json || [],
    };

    panel.innerHTML = `
      <div class="library-preview-meta">${escapeHtml((entry.usecase || '').replace(/_/g, ' ') || 'General')} &middot; Meta Official &middot; Utility</div>
      <h3 style="margin:0 0 0.75rem;">${escapeHtml(entry.name)}</h3>
      <div class="template-preview-frame">
        <div class="msg-bubble msg-out template-preview-bubble" id="meta-library-preview-bubble"></div>
      </div>
      <p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.75rem;">Written and pre-approved by Meta — skips the normal review wait entirely. Content can't be edited; only the name and button destinations below.</p>
      <button type="button" class="btn-primary" style="margin-top:0.5rem;" id="use-meta-library-template-btn">Use This Template</button>
    `;
    const bubble = document.getElementById('meta-library-preview-bubble');
    if (bubble) bubble.innerHTML = renderTemplateBubbleMarkup(bubbleShim, {});
    document.getElementById('use-meta-library-template-btn')?.addEventListener('click', () => openUseMetaLibraryTemplateModal(entry));
  }

  // Opens the narrow "Use Meta Official Template" modal (Phase 0 decision —
  // NOT the rich Create Template modal, since this content can't be edited).
  // One button-destination input per URL/PHONE_NUMBER button the entry has;
  // other button types (e.g. QUICK_REPLY) need no input, their text is fixed.
  function openUseMetaLibraryTemplateModal(entry) {
    document.getElementById('meta-use-preview-bubble').innerHTML = renderTemplateBubbleMarkup({
      header_type: entry.header_text ? 'TEXT' : 'NONE',
      header_content: entry.header_text,
      body: entry.body,
      footer_text: entry.footer_text,
      buttons: entry.buttons_json || [],
    }, {});
    document.getElementById('meta-use-template-name').value = slugifyTemplateName(entry.name);

    const inputsContainer = document.getElementById('meta-use-button-inputs');
    const editableButtons = (entry.buttons_json || []).filter((b) => b.type === 'URL' || b.type === 'PHONE_NUMBER');
    inputsContainer.innerHTML = editableButtons.map((b, i) => {
      if (b.type === 'URL') {
        return `
          <div class="form-group" style="margin-top:0.75rem;">
            <label class="form-label">Button "${escapeHtml(b.text || 'Link')}" — your website URL</label>
            <input type="text" class="form-input meta-use-button-input" data-button-index="${i}" data-button-type="URL" placeholder="https://your-site.example.com">
          </div>
        `;
      }
      return `
        <div class="form-group" style="margin-top:0.75rem;">
          <label class="form-label">Button "${escapeHtml(b.text || 'Call')}" — your phone number</label>
          <input type="text" class="form-input meta-use-button-input" data-button-index="${i}" data-button-type="PHONE_NUMBER" placeholder="+919876543210">
        </div>
      `;
    }).join('');

    document.getElementById('meta-use-error').style.display = 'none';
    document.getElementById('meta-use-submit-btn').onclick = () => submitUseMetaLibraryTemplate(entry);
    document.getElementById('modal-use-meta-library-template')?.classList.add('open');
  }

  async function submitUseMetaLibraryTemplate(entry) {
    const errorEl = document.getElementById('meta-use-error');
    errorEl.style.display = 'none';
    const name = document.getElementById('meta-use-template-name').value.trim();
    if (!name) {
      errorEl.textContent = 'Template name is required.';
      errorEl.style.display = 'block';
      return;
    }

    const buttonInputs = [];
    let missingInput = false;
    document.querySelectorAll('.meta-use-button-input').forEach((input) => {
      const type = input.dataset.buttonType;
      const value = input.value.trim();
      if (!value) { missingInput = true; return; }
      buttonInputs.push(type === 'URL'
        ? { type: 'URL', base_url: value }
        : { type: 'PHONE_NUMBER', phone_number: value });
    });
    if (missingInput) {
      errorEl.textContent = 'Every button above needs a value before this can be submitted.';
      errorEl.style.display = 'block';
      return;
    }

    try {
      await authFetch(`/api/template-library/meta/${entry.id}/use`, {
        method: 'POST',
        body: JSON.stringify({ name, buttonInputs: buttonInputs.length ? buttonInputs : undefined }),
      });
      document.getElementById('modal-use-meta-library-template')?.classList.remove('open');
      showToast('Submitted to Meta');
      switchView('template');
      refreshTemplates();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  }

  // Opens the EXISTING Create Template modal pre-filled from a library
  // entry — mirrors open-create-template-modal's own reset/WABA-status/
  // gating sequence exactly, then fills in the fields a manual author would
  // have typed. Everything stays editable before submit; nothing here
  // bypasses messageTemplateCreateSchema or validateTemplateText — the
  // actual POST /api/templates on submit is completely unchanged.
  async function useTemplateFromLibrary(entry) {
    document.getElementById('create-template-form')?.reset();
    templateButtons = [];

    try {
      const status = await authFetch('/api/onboarding/whatsapp/status');
      state.wabaConnected = Boolean(status.connected);
    } catch (err) {
      state.wabaConnected = false;
    }
    applyMediaHeaderGating();

    document.getElementById('new-template-name').value = slugifyTemplateName(entry.title);
    document.getElementById('new-template-category').value = entry.category;
    const languageSelect = document.getElementById('new-template-language');
    if (languageSelect && entry.language && [...languageSelect.options].some((o) => o.value === entry.language)) {
      languageSelect.value = entry.language;
    }

    if (entry.category !== 'Authentication') {
      document.getElementById('new-template-header-type').value = entry.header_type || 'NONE';
      document.getElementById('new-template-header-text').value = entry.header_content || '';
      document.getElementById('new-template-body').value = entry.body || '';
      document.getElementById('new-template-footer').value = entry.footer || '';
      templateButtons = (entry.buttons_json || []).map((b) => ({
        type: b.type, text: b.text || '', url: b.url || '', phone_number: b.phone_number || '',
      }));
    } else if (entry.auth_options) {
      // The library's suggested defaults for this Authentication entry
      // (e.g. a shorter code-expiration window for a login OTP vs. account
      // verification) — same fields the modal's own Authentication UI
      // already has, updateTemplateCategoryFields (triggered by
      // syncTemplateFormUI below) just shows/hides them, it doesn't reset
      // their values.
      const expirationInput = document.getElementById('new-template-auth-expiration');
      if (expirationInput && entry.auth_options.codeExpirationMinutes) {
        expirationInput.value = entry.auth_options.codeExpirationMinutes;
      }
      const disclaimerCheckbox = document.getElementById('new-template-auth-disclaimer');
      if (disclaimerCheckbox && typeof entry.auth_options.addSecurityDisclaimer === 'boolean') {
        disclaimerCheckbox.checked = entry.auth_options.addSecurityDisclaimer;
      }
    }
    renderTemplateButtonsList();

    switchView('template');
    document.getElementById('modal-create-template')?.classList.add('open');
    syncTemplateFormUI();

    // syncTemplateFormUI (above) already rendered one sample-value input per
    // {{param}} detected in the body — fill them from the library's own
    // sample values now that those inputs exist in the DOM.
    if (entry.category !== 'Authentication') {
      const samples = entry.sample_values_json || {};
      Object.entries(samples).forEach(([name, value]) => {
        const input = document.querySelector(`#template-sample-values-list [data-param-name="${name}"]`);
        if (input) input.value = value;
      });
      updateTemplatePreview();
    }

    // Usage logging only — never blocks or fails opening the prefilled
    // modal if it errors (e.g. a network blip), same "don't let analytics
    // break the actual feature" reasoning as the backend route itself.
    authFetch(`/api/template-library/${entry.id}/use`, { method: 'POST' }).catch(() => {});
  }

  // Opens the SAME Create Template modal pre-filled from an EXISTING
  // template (Templates view's per-card edit button) — same prefill
  // pattern as useTemplateFromLibrary above, but name/category/language get
  // disabled rather than left editable: routes/templates.js's PUT /:id
  // can't change any of the three (Meta's own edit endpoint doesn't accept
  // them either — the template id already identifies all three). A media
  // header (IMAGE/VIDEO/DOCUMENT) can't be changed via edit yet either
  // (that route's schema only accepts NONE/TEXT), so those options are
  // disabled here regardless of WhatsApp connection status — unlike
  // applyMediaHeaderGating's own gating, which is about connection, not
  // about edit-vs-create.
  async function openEditTemplateModal(template) {
    document.getElementById('create-template-form')?.reset();
    templateButtons = Array.isArray(template.buttons)
      ? template.buttons.map((b) => ({ type: b.type, text: b.text || '', url: b.url || '', phone_number: b.phone_number || '' }))
      : [];
    editingTemplateId = template.id;

    try {
      const status = await authFetch('/api/onboarding/whatsapp/status');
      state.wabaConnected = Boolean(status.connected);
    } catch (err) {
      state.wabaConnected = false;
    }
    applyMediaHeaderGating();

    document.getElementById('new-template-name').value = template.name;
    document.getElementById('new-template-category').value = template.category;
    const languageSelect = document.getElementById('new-template-language');
    if (languageSelect) languageSelect.value = template.language || 'en_US';
    document.getElementById('new-template-name').disabled = true;
    document.getElementById('new-template-category').disabled = true;
    languageSelect.disabled = true;

    const headerSelect = document.getElementById('new-template-header-type');
    headerSelect.value = template.header_type || 'NONE';
    MEDIA_HEADER_TYPES.forEach((type) => {
      const option = headerSelect.querySelector(`option[value="${type}"]`);
      if (option) option.disabled = true;
    });
    // A template that already HAS a media header can't have its header
    // touched at all in edit v1 (no re-upload path in this route) — lock
    // the whole dropdown, not just the other media options, so there's
    // nowhere to switch it to or from.
    headerSelect.disabled = MEDIA_HEADER_TYPES.includes(template.header_type);

    if (template.category !== 'Authentication') {
      document.getElementById('new-template-header-text').value = template.header_type === 'TEXT' ? (template.header_content || '') : '';
      document.getElementById('new-template-body').value = template.body || '';
      document.getElementById('new-template-footer').value = template.footer_text || '';
    } else {
      const auth = template.auth_options || {};
      document.getElementById('new-template-auth-expiration').value = auth.codeExpirationMinutes || '';
      document.getElementById('new-template-auth-disclaimer').checked = Boolean(auth.addSecurityDisclaimer);
    }
    renderTemplateButtonsList();

    document.getElementById('modal-create-template')?.classList.add('open');
    syncTemplateFormUI();

    if (template.category !== 'Authentication') {
      const examples = template.body_param_examples || {};
      Object.entries(examples).forEach(([name, value]) => {
        const input = document.querySelector(`#template-sample-values-list [data-param-name="${name}"]`);
        if (input) input.value = value;
      });
      // Re-checked after filling in the saved examples above, not just
      // relying on syncTemplateFormUI's earlier call — that ran before
      // these inputs had any value, so on its own it would have shown a
      // "missing sample value" warning for a template that actually has
      // one, and — since setting .value directly doesn't fire an input
      // event — nothing would ever have cleared it.
      updateTemplateSubmitGating();
      updateTemplatePreview();
    }

    const modalTitle = document.querySelector('#modal-create-template .modal-title');
    if (modalTitle) modalTitle.textContent = 'Edit Template';
    const submitBtn = document.querySelector('#create-template-form button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Save & Resubmit for Review';
  }

  document.getElementById('library-filter-category')?.addEventListener('change', renderLibraryGrid);
  document.getElementById('library-filter-use-case')?.addEventListener('change', renderLibraryGrid);
  document.getElementById('meta-library-filter-usecase')?.addEventListener('change', renderMetaLibraryGrid);
  document.getElementById('meta-library-search')?.addEventListener('input', renderMetaLibraryGrid);

  // --- Tag Manager ---
  function renderTagsManager() {
    const tagsManagerList = document.getElementById('tags-manager-list');
    if (!tagsManagerList) return;

    tagsManagerList.innerHTML = '';
    Object.values(state.tagsById).forEach(tag => {
      tagsManagerList.innerHTML += `<span class="tag-badge" style="font-size: 0.875rem; padding: 6px 14px; background: ${tag.bg}; color: ${tag.color};">${tag.name}</span>`;
    });
  }

  async function refreshTags() {
    const tags = await authFetch('/api/tags');
    state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));
  }

  function populateTagSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = Object.values(state.tagsById).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  }

  function populateTemplateSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = state.templates.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
  }

  // --- New Campaign Modal ---
  let newCampaignHeaderMediaAssetId = null; // set once a new header file has been uploaded for this campaign
  let campaignContactLists = []; // fetched fresh each time the modal opens

  function updateNewCampaignMediaField() {
    const templateName = document.getElementById('new-campaign-template').value;
    const template = state.templates.find(t => t.name === templateName);
    const mediaField = document.getElementById('new-campaign-media');
    mediaField.style.display = template && MEDIA_HEADER_TYPES.includes(template.header_type) ? '' : 'none';
  }

  function populateContactListSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = campaignContactLists.length
      ? campaignContactLists.map(l => `<option value="${l.id}">${escapeHtml(l.name)} (${l.member_count})</option>`).join('')
      : '<option value="">No contact lists yet — import one below</option>';
  }

  function updateCampaignAudienceModeUI() {
    const isList = document.getElementById('campaign-audience-mode-list').checked;
    document.getElementById('new-campaign-tag').style.display = isList ? 'none' : '';
    document.getElementById('campaign-audience-list-section').style.display = isList ? '' : 'none';
  }

  document.getElementById('open-create-broadcast-modal')?.addEventListener('click', async () => {
    populateTagSelect(document.getElementById('new-campaign-tag'));
    populateTemplateSelect(document.getElementById('new-campaign-template'));
    newCampaignHeaderMediaAssetId = null;
    document.getElementById('new-campaign-media-file').value = '';
    document.getElementById('new-campaign-media-status').textContent = '';
    document.getElementById('new-campaign-list-name').value = '';
    document.getElementById('new-campaign-list-file').value = '';
    document.getElementById('campaign-list-import-status').textContent = '';
    document.getElementById('new-campaign-pace').value = '';
    document.getElementById('campaign-audience-mode-tag').checked = true;
    updateCampaignAudienceModeUI();
    updateNewCampaignMediaField();
    document.getElementById('modal-create-campaign')?.classList.add('open');

    try {
      campaignContactLists = await authFetch('/api/contact-lists');
    } catch (err) {
      campaignContactLists = [];
    }
    populateContactListSelect(document.getElementById('new-campaign-contact-list'));
  });

  document.getElementById('campaign-audience-mode-tag')?.addEventListener('change', updateCampaignAudienceModeUI);
  document.getElementById('campaign-audience-mode-list')?.addEventListener('change', updateCampaignAudienceModeUI);

  document.getElementById('import-campaign-list-btn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-campaign-list-name');
    const fileInput = document.getElementById('new-campaign-list-file');
    const status = document.getElementById('campaign-list-import-status');
    const name = nameInput.value.trim();
    const file = fileInput.files[0];
    if (!name) { status.textContent = 'Give the list a name first.'; status.style.color = '#B91C1C'; return; }
    if (!file) { status.textContent = 'Choose a CSV file first.'; status.style.color = '#B91C1C'; return; }

    status.textContent = 'Importing…';
    status.style.color = 'var(--text-muted)';
    try {
      const list = await authFetch('/api/contact-lists', { method: 'POST', body: JSON.stringify({ name }) });
      const form = new FormData();
      form.append('file', file);
      const report = await authFetch(`/api/contact-lists/${list.id}/import`, { method: 'POST', body: form });
      campaignContactLists = await authFetch('/api/contact-lists');
      const select = document.getElementById('new-campaign-contact-list');
      populateContactListSelect(select);
      select.value = list.id;
      nameInput.value = '';
      fileInput.value = '';
      status.style.color = report.rejected > 0 ? '#B45309' : '#166534';
      status.textContent = report.rejected > 0
        ? `Imported ${report.imported} of ${report.rows_in_file} rows — ${report.rejected} rejected: ${report.errors.slice(0, 3).map(e => `row ${e.row}: ${e.reason}`).join('; ')}${report.errors.length > 3 ? '…' : ''}`
        : `Imported all ${report.imported} contacts into "${escapeHtml(name)}".`;
    } catch (err) {
      status.style.color = '#B91C1C';
      status.textContent = `Import failed: ${err.message}`;
    }
  });

  document.getElementById('new-campaign-template')?.addEventListener('change', () => {
    newCampaignHeaderMediaAssetId = null;
    document.getElementById('new-campaign-media-file').value = '';
    document.getElementById('new-campaign-media-status').textContent = '';
    updateNewCampaignMediaField();
  });

  // Same immediate-upload-on-choice pattern as the chat send-template modal
  // — a bad file surfaces before the campaign is launched, not after.
  document.getElementById('new-campaign-media-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const status = document.getElementById('new-campaign-media-status');
    const templateName = document.getElementById('new-campaign-template').value;
    const template = state.templates.find(t => t.name === templateName);
    newCampaignHeaderMediaAssetId = null;
    if (!file || !template) { status.textContent = ''; return; }
    status.textContent = 'Uploading…';
    try {
      const form = new FormData();
      form.append('file', file);
      const asset = await authFetch(`/api/templates/${template.id}/header-media`, { method: 'POST', body: form });
      newCampaignHeaderMediaAssetId = asset.id;
      status.textContent = `Ready — will send with "${file.name}" instead of the approval sample.`;
    } catch (err) {
      status.textContent = `Upload failed: ${err.message}`;
    }
  });

  document.getElementById('create-campaign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-campaign-name').value.trim();
    const isListMode = document.getElementById('campaign-audience-mode-list').checked;
    const tagId = isListMode ? null : document.getElementById('new-campaign-tag').value;
    const contactListId = isListMode ? document.getElementById('new-campaign-contact-list').value : null;
    const templateName = document.getElementById('new-campaign-template').value;
    const paceValue = document.getElementById('new-campaign-pace').value;
    if (!title) return;
    if (!templateName) {
      showToast('Create a message template first — campaigns send via an approved template.');
      return;
    }
    if (isListMode && !contactListId) {
      showToast('Select a contact list, or import one, before launching.');
      return;
    }

    try {
      const created = await authFetch('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify({
          title, tag_id: tagId || undefined, contact_list_id: contactListId || undefined, templateName,
          headerMediaAssetId: newCampaignHeaderMediaAssetId || undefined,
          pacingConfig: paceValue ? { messages_per_minute: Number(paceValue) } : undefined,
        })
      });
      await refreshBroadcasts();
      renderBroadcasts();
      e.target.reset();
      newCampaignHeaderMediaAssetId = null;
      document.getElementById('new-campaign-media-status').textContent = '';
      document.getElementById('modal-create-campaign')?.classList.remove('open');
      if (created?.consentWarning) {
        showToast(created.consentWarning);
      }
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Sync from Meta ---
  // Manual counterpart to the automatic sync that runs once right after
  // Embedded Signup (server/src/routes/onboarding.js) — for templates
  // approved/created on Meta's side after that point, or if the automatic
  // one failed silently (it's best-effort there so a Meta hiccup doesn't
  // fail the whole connect flow). Returns counts rather than a silent
  // refresh, so a client can actually see that something happened.
  document.getElementById('sync-templates-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Syncing…';
    try {
      const result = await authFetch('/api/templates/sync', { method: 'POST' });
      await refreshTemplates();
      renderTemplates();
      const parts = [];
      if (result.inserted) parts.push(`${result.inserted} new`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.orphaned) parts.push(`${result.orphaned} no longer on Meta`);
      showToast(parts.length ? `Synced: ${parts.join(', ')}.` : 'Synced — no changes.');
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      refreshIcons();
    }
  });

  // Preview / Edit / Delete — all three delegated on the grid container
  // since renderTemplates() rebuilds the card markup wholesale on every
  // call, which would drop a listener bound to an individual button.
  document.getElementById('templates-grid')?.addEventListener('click', async (e) => {
    const previewBtn = e.target.closest('[data-preview-template]');
    const editBtn = e.target.closest('[data-edit-template]');
    const deleteBtn = e.target.closest('[data-delete-template]');

    if (previewBtn) {
      const template = state.templates.find((t) => t.id === previewBtn.dataset.previewTemplate);
      if (template) openTemplateChatPreview(template);
      return;
    }

    if (editBtn) {
      const template = state.templates.find((t) => t.id === editBtn.dataset.editTemplate);
      if (template) await openEditTemplateModal(template);
      return;
    }

    if (deleteBtn) {
      if (!confirm('Delete this template? If it was submitted to Meta, it will be removed there too and can no longer be sent. This cannot be undone.')) return;
      deleteBtn.disabled = true;
      try {
        await authFetch(`/api/templates/${deleteBtn.dataset.deleteTemplate}`, { method: 'DELETE' });
        await refreshTemplates();
        renderTemplates();
        showToast('Template deleted');
      } catch (err) {
        showToast(err.message);
        deleteBtn.disabled = false;
      }
    }
  });

  // --- Create Template Modal (category-driven) ---
  // Static reference list of Meta's documented WhatsApp template language
  // codes — not fetched from anywhere live, this codebase has no such
  // endpoint. English (US) is first/default, matching what the backend
  // already defaults to (validate.js's messageTemplateCreateSchema).
  const TEMPLATE_LANGUAGES = [
    ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['en', 'English'],
    ['af', 'Afrikaans'], ['sq', 'Albanian'], ['ar', 'Arabic'], ['az', 'Azerbaijani'],
    ['bn', 'Bengali'], ['bg', 'Bulgarian'], ['ca', 'Catalan'], ['zh_CN', 'Chinese (CHN)'],
    ['zh_HK', 'Chinese (HKG)'], ['zh_TW', 'Chinese (TAI)'], ['hr', 'Croatian'], ['cs', 'Czech'],
    ['da', 'Danish'], ['nl', 'Dutch'], ['et', 'Estonian'], ['fil', 'Filipino'], ['fi', 'Finnish'],
    ['fr', 'French'], ['ka', 'Georgian'], ['de', 'German'], ['el', 'Greek'], ['gu', 'Gujarati'],
    ['ha', 'Hausa'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'],
    ['ga', 'Irish'], ['it', 'Italian'], ['ja', 'Japanese'], ['kn', 'Kannada'], ['kk', 'Kazakh'],
    ['ko', 'Korean'], ['lo', 'Lao'], ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['mk', 'Macedonian'],
    ['ms', 'Malay'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['nb', 'Norwegian'], ['fa', 'Persian'],
    ['pl', 'Polish'], ['pt_BR', 'Portuguese (BR)'], ['pt_PT', 'Portuguese (POR)'], ['pa', 'Punjabi'],
    ['ro', 'Romanian'], ['ru', 'Russian'], ['sr', 'Serbian'], ['sk', 'Slovak'], ['sl', 'Slovenian'],
    ['es', 'Spanish'], ['es_AR', 'Spanish (ARG)'], ['es_ES', 'Spanish (SPA)'], ['es_MX', 'Spanish (MEX)'],
    ['sw', 'Swahili'], ['sv', 'Swedish'], ['ta', 'Tamil'], ['te', 'Telugu'], ['th', 'Thai'],
    ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['uz', 'Uzbek'], ['vi', 'Vietnamese'], ['zu', 'Zulu'],
  ];

  // Calls the REAL server/src/utils/templateParams.js — served raw as
  // /templateParams.js (server/src/app.js) and loaded before this file
  // (index.html), so this is the exact same function
  // routes/templates.js's validateStandardTemplateFields runs at submit
  // time, not a hand-duplicated copy that can drift from server truth
  // (which this file's own history already hit once: the malformed-
  // placeholder check below used to be duplicated by hand for exactly this
  // reason, before templateParams.js was made shareable).
  function extractTemplateParams(text) {
    return [...new Set(window.templateParams.extractPlaceholders(text).map((p) => p.name))];
  }

  // Live "flag while typing" template validation — runs the FULL rule set
  // (malformed placeholders, numbered/mixed parameters, a variable at the
  // very start/end, the words-to-parameters ratio, and missing sample
  // values), not just the one rule (malformed placeholders) this modal
  // used to check live. Previously every other rule only surfaced after a
  // failed submit, via the err.body.details toast — a client could type an
  // obviously-doomed template (e.g. "{{name}}" alone, or three variables in
  // six words) and get no feedback until Meta/the server rejected it.
  //
  // Returns { hasErrors } so callers (the input listeners, and
  // updateTemplateSubmitGating below) can react without re-deriving it.
  function updateTemplateBodyValidation() {
    const field = document.getElementById('new-template-body');
    const warning = document.getElementById('template-body-warning');
    if (!field || !warning) return { hasErrors: false };

    const result = window.templateParams.validateTemplateText(field.value, { label: 'Body' });
    const errors = [...result.errors];

    // The words-to-parameters ratio rule is shown like every other warning
    // here, but must never by itself block Submit/Save — unlike the other
    // rules, it's an explicitly unofficial heuristic (templateParams.js's
    // own comment: calibrated against a small, real accept/reject sample,
    // confirmed to over-flag real, already-Meta-approved content — 19 of
    // 36 Template Library seed entries per this codebase's own tracked
    // gaps). Confirmed live: opening Edit on a real existing template
    // (invoice_document) that trips only this rule would otherwise disable
    // Save for an edit that has nothing to do with the body at all.
    // validateTemplateText returns EARLY per rule (never mixes the ratio
    // message with a different rule's in one result), so checking for
    // Meta's own named error string is a reliable, non-fragile way to tell
    // "only the heuristic fired" apart from every unambiguous rule.
    const isRatioOnly = errors.length > 0 && errors.every((e) => e.includes('Params Words Ratio Exceeds Limit'));
    let hasBlockingError = errors.length > 0 && !isRatioOnly;

    // Mirrors validateStandardTemplateFields's own missing-sample-value
    // check exactly (server/src/routes/templates.js) — same wording, same
    // "only checked once the body text itself is otherwise valid" order,
    // so a client never sees this warning for a reason the body-text
    // errors above already explain. Always a real, unambiguous rejection —
    // no equivalent carve-out to the ratio rule's.
    if (result.valid && result.params.length > 0) {
      const samples = getTemplateSampleValues();
      const missing = result.params.filter((p) => !String(samples[p] || '').trim());
      if (missing.length > 0) {
        errors.push(`Sample value required for: ${missing.join(', ')} — Meta rejects templates without one.`);
        hasBlockingError = true;
      }
    }

    warning.style.display = errors.length ? '' : 'none';
    warning.textContent = errors.join(' ');
    return { hasErrors: hasBlockingError };
  }

  function updateTemplateHeaderValidation() {
    const typeSelect = document.getElementById('new-template-header-type');
    const field = document.getElementById('new-template-header-text');
    const warning = document.getElementById('template-header-warning');
    if (!field || !warning) return { hasErrors: false };

    // Matches validateStandardTemplateFields's own gate exactly — a
    // NONE/media header has no text for this rule set to apply to.
    if (typeSelect?.value !== 'TEXT') {
      warning.style.display = 'none';
      warning.textContent = '';
      return { hasErrors: false };
    }

    const result = window.templateParams.validateHeaderText(field.value);
    warning.style.display = result.errors.length ? '' : 'none';
    warning.textContent = result.errors.join(' ');
    return { hasErrors: result.errors.length > 0 };
  }

  // Blocks submitting a template this modal's own live checks already know
  // Meta (or the server, before ever reaching Meta) would reject — the
  // direct fix for "the system doesn't flag anything until the template is
  // rejected." Authentication templates have no author-supplied body/header
  // at all (messageTemplateCreateSchema's own rule), so this never gates
  // them — matches validateStandardTemplateFields's identical
  // `data.category !== 'Authentication'` exemption server-side.
  function updateTemplateSubmitGating() {
    const submitBtn = document.querySelector('#create-template-form button[type="submit"]');
    if (!submitBtn) return;
    const category = document.getElementById('new-template-category')?.value;
    if (category === 'Authentication') {
      submitBtn.disabled = false;
      submitBtn.title = '';
      return;
    }
    const bodyState = updateTemplateBodyValidation();
    const headerState = updateTemplateHeaderValidation();
    const hasErrors = bodyState.hasErrors || headerState.hasErrors;
    submitBtn.disabled = hasErrors;
    submitBtn.title = hasErrors ? 'Fix the highlighted body/header issues above before submitting.' : '';
  }

  function substituteTemplateParams(text, samples) {
    return (text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (full, name) => {
      const val = samples[name];
      return val && val.trim() ? val : `[${name}]`;
    });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Surfaces the most specific reason available in a thrown authFetch error
  // — prefers a structured `details` array of strings (this app's own
  // validation failures: numbered params, missing samples, malformed
  // header, ...) over the generic top-level message, then falls back to a
  // singular `detail` string. The singular case matters for real upstream
  // rejections that only ever carry one — e.g. routes/templates.js's
  // `{ error: 'Meta rejected this template', detail: err.message }` on a
  // real Meta-side 502 — which previously fell all the way through both
  // checks to the generic top-level `error` text, silently dropping the
  // actual reason Meta gave for the rejection.
  function extractApiErrorDetail(err) {
    if (err.body && Array.isArray(err.body.details) && err.body.details.every((d) => typeof d === 'string')) {
      return err.body.details.join(' ');
    }
    if (err.body && typeof err.body.detail === 'string' && err.body.detail) {
      return err.body.detail;
    }
    return null;
  }

  function getTemplateSampleValues() {
    const values = {};
    document.querySelectorAll('#template-sample-values-list [data-param-name]').forEach((input) => {
      values[input.dataset.paramName] = input.value;
    });
    return values;
  }

  function renderTemplateLanguageOptions() {
    const select = document.getElementById('new-template-language');
    if (!select || select.options.length) return;
    select.innerHTML = TEMPLATE_LANGUAGES.map(([code, label]) =>
      `<option value="${code}" ${code === 'en_US' ? 'selected' : ''}>${label} (${code})</option>`
    ).join('');
  }

  function renderTemplateSampleInputs() {
    const body = document.getElementById('new-template-body').value;
    const params = extractTemplateParams(body);
    const wrapper = document.getElementById('template-sample-values');
    const container = document.getElementById('template-sample-values-list');
    const existing = getTemplateSampleValues();

    if (params.length === 0) {
      wrapper.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    wrapper.style.display = '';
    container.innerHTML = params.map((name) => `
      <div class="template-sample-row">
        <span class="template-sample-row-label">{{${escapeHtml(name)}}}</span>
        <input type="text" class="form-input" data-param-name="${escapeHtml(name)}" placeholder="e.g. Riyaz" value="${escapeHtml(existing[name] || '')}" />
      </div>
    `).join('');
    container.querySelectorAll('[data-param-name]').forEach((input) => {
      input.addEventListener('input', () => {
        updateTemplateSubmitGating(); // clears/raises the "missing sample value" warning live
        updateTemplatePreview();
      });
    });
  }

  // Button state lives in this array, not read back from the DOM each
  // time — dynamically added/removed rows make DOM-as-source-of-truth
  // fiddly, and this mirrors what actually gets submitted directly.
  let templateButtons = [];

  // The Create Template modal doubles as the Edit Template modal — set
  // whenever openEditTemplateModal opens it, cleared whenever the modal
  // opens fresh for a new template (open-create-template-modal's handler,
  // below) or a submit succeeds. The submit handler branches on this to
  // PUT instead of POST, and to send only the editable content fields
  // (name/category/language are locked in edit mode — see
  // openEditTemplateModal's own comment for why).
  let editingTemplateId = null;

  function templateButtonCounts() {
    return {
      url: templateButtons.filter((b) => b.type === 'URL').length,
      phone: templateButtons.filter((b) => b.type === 'PHONE_NUMBER').length,
    };
  }

  function updateTemplateAddButtonState() {
    const counts = templateButtonCounts();
    const urlBtn = document.querySelector('[data-add-button="URL"]');
    const phoneBtn = document.querySelector('[data-add-button="PHONE_NUMBER"]');
    const quickBtn = document.querySelector('[data-add-button="QUICK_REPLY"]');
    if (urlBtn) urlBtn.disabled = counts.url >= 2;
    if (phoneBtn) phoneBtn.disabled = counts.phone >= 1;
    if (quickBtn) quickBtn.disabled = templateButtons.length >= 10;
  }

  function renderTemplateButtonsList() {
    const container = document.getElementById('template-buttons-list');
    const typeLabel = { URL: 'URL', PHONE_NUMBER: 'Phone', QUICK_REPLY: 'Quick Reply' };
    container.innerHTML = templateButtons.map((b, i) => `
      <div class="template-button-row">
        <span class="template-button-row-type">${typeLabel[b.type]}</span>
        <input type="text" class="form-input" data-button-field="text" data-index="${i}" placeholder="Button text" maxlength="25" value="${escapeHtml(b.text)}" style="flex:1;" />
        ${b.type === 'URL' ? `<input type="text" class="form-input" data-button-field="url" data-index="${i}" placeholder="https://..." value="${escapeHtml(b.url || '')}" style="flex:1;" />` : ''}
        ${b.type === 'PHONE_NUMBER' ? `<input type="text" class="form-input" data-button-field="phone_number" data-index="${i}" placeholder="+919092766740" value="${escapeHtml(b.phone_number || '')}" style="flex:1;" />` : ''}
        <button type="button" class="template-row-remove-btn" data-remove-button="${i}"><i data-lucide="x"></i></button>
      </div>
    `).join('');
    refreshIcons();

    container.querySelectorAll('[data-button-field]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.index);
        templateButtons[i][e.target.dataset.buttonField] = e.target.value;
        updateTemplatePreview();
      });
    });
    container.querySelectorAll('[data-remove-button]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const i = Number(e.currentTarget.dataset.removeButton);
        templateButtons.splice(i, 1);
        renderTemplateButtonsList();
        updateTemplatePreview();
      });
    });
    updateTemplateAddButtonState();
  }

  function addTemplateButton(type) {
    const counts = templateButtonCounts();
    if (type === 'URL' && counts.url >= 2) return;
    if (type === 'PHONE_NUMBER' && counts.phone >= 1) return;
    if (type === 'QUICK_REPLY' && templateButtons.length >= 10) return;
    templateButtons.push({ type, text: '', url: '', phone_number: '' });
    renderTemplateButtonsList();
    updateTemplatePreview();
  }

  function updateTemplateCategoryFields() {
    const category = document.getElementById('new-template-category').value;
    const isAuth = category === 'Authentication';
    document.getElementById('template-fields-standard').style.display = isAuth ? 'none' : '';
    document.getElementById('template-fields-auth').style.display = isAuth ? '' : 'none';
    updateTemplatePreview();
  }

  const MEDIA_HEADER_TYPES = ['IMAGE', 'VIDEO', 'DOCUMENT'];
  const MEDIA_HEADER_ACCEPT = { IMAGE: '.jpg,.jpeg,.png', VIDEO: '.mp4', DOCUMENT: '.pdf' };
  const MEDIA_HEADER_HINT = { IMAGE: 'Max 5MB — JPEG or PNG.', VIDEO: 'Max 16MB — MP4.', DOCUMENT: 'Max 100MB — PDF.' };

  // Mirrors routes/templates.js's own gate ("Connect WhatsApp first" — a
  // media header has to upload to Meta immediately, both for the
  // creation-time example handle and the send-time media-id cache, so
  // there's nowhere to hold the file for later without a WABA). Previously
  // the dropdown offered IMAGE/VIDEO/DOCUMENT unconditionally and only the
  // server enforced this, at actual submit time — a client without
  // WhatsApp connected could fill out the whole form, pick a file, and
  // only then discover it was never going to work.
  function applyMediaHeaderGating() {
    const select = document.getElementById('new-template-header-type');
    const hint = document.getElementById('template-header-connect-hint');
    if (!select) return;
    MEDIA_HEADER_TYPES.forEach(type => {
      const option = select.querySelector(`option[value="${type}"]`);
      if (option) option.disabled = !state.wabaConnected;
    });
    if (hint) hint.style.display = state.wabaConnected ? 'none' : '';
  }

  function updateTemplateHeaderField() {
    const type = document.getElementById('new-template-header-type').value;
    const isMedia = MEDIA_HEADER_TYPES.includes(type);
    document.getElementById('new-template-header-text').style.display = type === 'TEXT' ? '' : 'none';
    const fileInput = document.getElementById('new-template-header-file');
    fileInput.style.display = isMedia ? '' : 'none';
    if (isMedia) fileInput.setAttribute('accept', MEDIA_HEADER_ACCEPT[type]);
    const hint = document.getElementById('template-header-media-hint');
    hint.textContent = isMedia ? MEDIA_HEADER_HINT[type] : '';
    hint.style.display = isMedia ? '' : 'none';
    updateTemplatePreview();
  }

  // Authentication's body isn't author-written — Meta generates it (see
  // metaClient.js's buildAuthenticationPayload) — so this preview shows
  // representative wording, not a live substitution of anything editable.
  function updateTemplatePreview() {
    const bubble = document.getElementById('template-preview-bubble');
    if (!bubble) return;
    const category = document.getElementById('new-template-category').value;

    if (category === 'Authentication') {
      const disclaimer = document.getElementById('new-template-auth-disclaimer').checked;
      bubble.innerHTML = `
        <div>Your verification code is *123456*.${disclaimer ? ' For your security, do not share this code.' : ''}</div>
        <div class="template-preview-buttons"><div class="template-preview-button">&#128203; Copy Code</div></div>
      `;
      return;
    }

    const samples = getTemplateSampleValues();
    const headerType = document.getElementById('new-template-header-type').value;
    const headerText = document.getElementById('new-template-header-text').value;
    const body = document.getElementById('new-template-body').value;
    const footer = document.getElementById('new-template-footer').value;

    let html = '';
    if (headerType === 'TEXT' && headerText.trim()) {
      html += `<div class="template-preview-header">${escapeHtml(substituteTemplateParams(headerText, samples))}</div>`;
    } else if (MEDIA_HEADER_TYPES.includes(headerType)) {
      const file = document.getElementById('new-template-header-file').files[0];
      const label = file ? file.name : `${headerType.charAt(0)}${headerType.slice(1).toLowerCase()} header — no file chosen yet`;
      html += `<div class="template-preview-header">${escapeHtml(label)}</div>`;
    }
    const bodyPreview = substituteTemplateParams(body, samples).trim();
    html += `<div>${bodyPreview ? escapeHtml(bodyPreview) : '<span style="color:var(--text-muted)">Body preview appears here</span>'}</div>`;
    if (footer.trim()) {
      html += `<div class="template-preview-footer">${escapeHtml(footer)}</div>`;
    }
    if (templateButtons.length > 0) {
      const icon = { URL: '&#128279;', PHONE_NUMBER: '&#128222;', QUICK_REPLY: '&#8617;' };
      html += `<div class="template-preview-buttons">${templateButtons.map((b) =>
        `<div class="template-preview-button">${icon[b.type]} ${escapeHtml(b.text || '(button text)')}</div>`
      ).join('')}</div>`;
    }
    bubble.innerHTML = html;
  }

  function syncTemplateFormUI() {
    updateTemplateCategoryFields();
    updateTemplateHeaderField();
    renderTemplateSampleInputs();
    const body = document.getElementById('new-template-body').value;
    document.getElementById('template-body-charcount').textContent = body ? `${body.length}/1024` : '';
    const footer = document.getElementById('new-template-footer').value;
    document.getElementById('template-footer-charcount').textContent = footer ? `${footer.length}/60` : '';
    updateTemplateSubmitGating();
    updateTemplatePreview();
  }

  // Undoes openEditTemplateModal's lock-fields-and-relabel treatment —
  // called whenever the modal opens fresh for a brand-new template, and
  // after any submit (success or failure of a DIFFERENT kind than the ones
  // that keep the modal open), so a previous edit's disabled/relabeled
  // state never leaks into the next "Create Template" click.
  function resetTemplateModalToCreateMode() {
    editingTemplateId = null;
    document.getElementById('new-template-name').disabled = false;
    document.getElementById('new-template-category').disabled = false;
    document.getElementById('new-template-language').disabled = false;
    document.getElementById('new-template-header-type').disabled = false;
    const modalTitle = document.querySelector('#modal-create-template .modal-title');
    if (modalTitle) modalTitle.textContent = 'Create Template';
    const submitBtn = document.querySelector('#create-template-form button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Submit for Approval';
  }

  document.getElementById('open-create-template-modal')?.addEventListener('click', async () => {
    // Reset unconditionally on open, not just after a successful submit.
    // templateButtons/header-type/etc. previously only got cleared by
    // e.target.reset() in the submit success path — so Cancel, closing the
    // modal, or a FAILED submission all left stale state (a half-added
    // button, a header type with no text) sitting there for next time.
    // A later, otherwise-clean attempt would then fail against fields the
    // user never even looked at, with no way to tell why — exactly what
    // "trying to submit and it just says Validation failed" looks like
    // from the outside.
    document.getElementById('create-template-form')?.reset();
    templateButtons = [];
    renderTemplateButtonsList();
    resetTemplateModalToCreateMode();

    // Checked fresh on every open rather than cached in state long-term —
    // connecting/disconnecting WhatsApp is rare, but this keeps the gate
    // honest against whatever the client's actual current status is
    // instead of whatever it was the last time any part of the app asked.
    try {
      const status = await authFetch('/api/onboarding/whatsapp/status');
      state.wabaConnected = Boolean(status.connected);
    } catch (err) {
      state.wabaConnected = false;
    }
    applyMediaHeaderGating();

    document.getElementById('modal-create-template')?.classList.add('open');
    syncTemplateFormUI();
  });

  renderTemplateLanguageOptions();
  document.getElementById('new-template-category')?.addEventListener('change', () => {
    updateTemplateCategoryFields();
    updateTemplateSubmitGating();
  });
  document.getElementById('new-template-header-type')?.addEventListener('change', () => {
    updateTemplateHeaderField();
    updateTemplateSubmitGating();
    updateTemplatePreview();
  });
  document.getElementById('new-template-header-file')?.addEventListener('change', updateTemplatePreview);
  document.getElementById('new-template-header-text')?.addEventListener('input', () => {
    updateTemplateSubmitGating();
    updateTemplatePreview();
  });
  document.getElementById('new-template-footer')?.addEventListener('input', () => {
    const footer = document.getElementById('new-template-footer').value;
    document.getElementById('template-footer-charcount').textContent = footer ? `${footer.length}/60` : '';
    updateTemplatePreview();
  });
  document.getElementById('new-template-auth-disclaimer')?.addEventListener('change', updateTemplatePreview);
  document.getElementById('new-template-body')?.addEventListener('input', () => {
    const body = document.getElementById('new-template-body').value;
    document.getElementById('template-body-charcount').textContent = `${body.length}/1024`;
    renderTemplateSampleInputs();
    updateTemplateSubmitGating();
    updateTemplatePreview();
  });
  document.querySelectorAll('.template-add-button-btn').forEach((btn) => {
    btn.addEventListener('click', () => addTemplateButton(btn.dataset.addButton));
  });
  syncTemplateFormUI();

  document.getElementById('create-template-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = document.getElementById('new-template-category').value;

    // Edit mode (openEditTemplateModal set this) — a completely separate
    // path from create below: no name/category/language (fixed once a
    // template exists — see routes/templates.js's PUT /:id), no media
    // header support yet (that route's schema only accepts NONE/TEXT), so
    // this never needs the FormData/headerFile branch create's path does.
    if (editingTemplateId) {
      const payload = {};
      if (category === 'Authentication') {
        const expiration = document.getElementById('new-template-auth-expiration').value;
        if (expiration) payload.codeExpirationMinutes = Number(expiration);
        payload.addSecurityDisclaimer = document.getElementById('new-template-auth-disclaimer').checked;
        payload.otpButtonType = 'COPY_CODE';
      } else {
        const body = document.getElementById('new-template-body').value.trim();
        if (!body) return;
        payload.body = body;
        payload.bodyParamExamples = getTemplateSampleValues();
        const headerType = document.getElementById('new-template-header-type').value;
        payload.header = headerType === 'TEXT'
          ? { type: headerType, text: document.getElementById('new-template-header-text').value.trim() }
          : { type: 'NONE' };
        const footer = document.getElementById('new-template-footer').value.trim();
        if (footer) payload.footer = footer;
        if (templateButtons.length > 0) {
          payload.buttons = templateButtons.map((b) => {
            if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url };
            if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
            return { type: 'QUICK_REPLY', text: b.text };
          });
        }
      }

      try {
        await authFetch(`/api/templates/${editingTemplateId}`, { method: 'PUT', body: JSON.stringify(payload) });
        await refreshTemplates();
        renderTemplates();
        e.target.reset();
        templateButtons = [];
        renderTemplateButtonsList();
        resetTemplateModalToCreateMode();
        syncTemplateFormUI();
        document.getElementById('modal-create-template')?.classList.remove('open');
        showToast('Template updated and resubmitted to Meta for review.');
      } catch (err) {
        showToast(extractApiErrorDetail(err) || err.message);
      }
      return;
    }

    const name = document.getElementById('new-template-name').value.trim();
    const language = document.getElementById('new-template-language').value;
    if (!name) return;

    const payload = { name, category, language };
    let headerFile = null;

    if (category === 'Authentication') {
      const expiration = document.getElementById('new-template-auth-expiration').value;
      if (expiration) payload.codeExpirationMinutes = Number(expiration);
      payload.addSecurityDisclaimer = document.getElementById('new-template-auth-disclaimer').checked;
      payload.otpButtonType = 'COPY_CODE';
    } else {
      const body = document.getElementById('new-template-body').value.trim();
      if (!body) return;
      payload.body = body;
      payload.bodyParamExamples = getTemplateSampleValues();

      const headerType = document.getElementById('new-template-header-type').value;
      if (headerType === 'TEXT') {
        payload.header = { type: headerType, text: document.getElementById('new-template-header-text').value.trim() };
      } else if (MEDIA_HEADER_TYPES.includes(headerType)) {
        headerFile = document.getElementById('new-template-header-file').files[0] || null;
        if (!headerFile) {
          showToast(`Choose a file for the ${headerType.toLowerCase()} header.`);
          return;
        }
        payload.header = { type: headerType };
      }
      const footer = document.getElementById('new-template-footer').value.trim();
      if (footer) payload.footer = footer;
      if (templateButtons.length > 0) {
        // Only the field relevant to each button's type — templateButtonSchema's
        // url/phone_number are optional but, if present, non-empty (.min(1)),
        // so sending an empty '' placeholder for the irrelevant field on every
        // row (every button object here always carries all three properties)
        // fails validation instead of being harmlessly ignored.
        payload.buttons = templateButtons.map((b) => {
          if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url };
          if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
          return { type: 'QUICK_REPLY', text: b.text };
        });
      }
    }

    try {
      // A media header sends the file as multipart, with the rest of the
      // payload as a 'data' field (JSON-stringified — buttons/samples don't
      // fit as flat form fields) — see routes/templates.js. authFetch skips
      // its default JSON Content-Type for a FormData body so the browser
      // can set its own multipart boundary, same as the profile-picture
      // upload already relies on.
      const requestBody = headerFile
        ? (() => {
            const form = new FormData();
            form.append('data', JSON.stringify(payload));
            form.append('headerFile', headerFile);
            return form;
          })()
        : JSON.stringify(payload);
      await authFetch('/api/templates', {
        method: 'POST',
        body: requestBody
      });
      await refreshTemplates();
      renderTemplates();
      e.target.reset();
      templateButtons = [];
      renderTemplateButtonsList();
      syncTemplateFormUI();
      document.getElementById('modal-create-template')?.classList.remove('open');
    } catch (err) {
      showToast(extractApiErrorDetail(err) || err.message);
    }
  });

  // --- Create Ticket Modal ---
  document.getElementById('open-create-ticket-modal')?.addEventListener('click', () => {
    document.getElementById('modal-create-ticket')?.classList.add('open');
  });

  document.getElementById('create-ticket-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = document.getElementById('new-ticket-subject').value.trim();
    const message = document.getElementById('new-ticket-message').value.trim();
    if (!subject || !message) return;

    try {
      await authFetch('/api/support-tickets', {
        method: 'POST',
        body: JSON.stringify({ subject, message })
      });
      await refreshTickets();
      renderTickets();
      e.target.reset();
      document.getElementById('modal-create-ticket')?.classList.remove('open');
      showToast('Support ticket submitted.');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Add Tag Modal ---
  document.getElementById('open-add-tag-modal')?.addEventListener('click', () => {
    document.getElementById('modal-add-tag')?.classList.add('open');
  });

  document.getElementById('add-tag-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-tag-name').value.trim();
    const color = document.getElementById('new-tag-color').value;
    if (!name) return;

    try {
      await authFetch('/api/tags', {
        method: 'POST',
        body: JSON.stringify({ name, bg: color + '22', color })
      });
      await refreshTags();
      renderTagsManager();
    } catch (err) {
      showToast(err.message);
      return;
    }

    e.target.reset();
    document.getElementById('modal-add-tag')?.classList.remove('open');
  });

  // --- Team ---
  async function renderTeamTable() {
    const tbody = document.getElementById('team-table-body');
    if (!tbody) return;
    try {
      const members = await authFetch('/api/team-members');
      tbody.innerHTML = members.length ? members.map(m => `
        <tr><td>${m.name}</td><td>${m.email}</td><td>${m.role}</td><td><span class="status-badge ${m.status === 'active' ? 'active' : ''}">${m.status === 'active' ? 'Active' : 'Invited'}</span></td><td>—</td></tr>
      `).join('') : '<tr><td colspan="5" style="text-align:center;color:#9CA3AF;">No team members yet</td></tr>';
    } catch (err) {
      showToast(err.message);
    }
  }

  document.getElementById('open-invite-member-modal')?.addEventListener('click', () => {
    document.getElementById('modal-invite-member')?.classList.add('open');
  });

  document.getElementById('invite-member-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-member-name').value.trim();
    const email = document.getElementById('new-member-email').value.trim();
    const role = document.getElementById('new-member-role').value;
    if (!name || !email) return;

    try {
      await authFetch('/api/team-members', { method: 'POST', body: JSON.stringify({ name, email, role }) });
      await renderTeamTable();
      e.target.reset();
      document.getElementById('modal-invite-member')?.classList.remove('open');
      showToast('Invite sent to ' + email);
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Custom Contact Attributes ---
  async function renderAttributesTable() {
    const tbody = document.getElementById('attributes-table-body');
    if (!tbody) return;
    try {
      const attrs = await authFetch('/api/contact-attributes');
      tbody.innerHTML = attrs.length ? attrs.map(a => `
        <tr><td style="font-weight:600;">${a.name}</td><td>${a.name.toLowerCase().replace(/\s+/g, '_')}</td><td>${a.type}</td><td>—</td></tr>
      `).join('') : '<tr><td colspan="4" style="text-align:center;color:#9CA3AF;">No custom attributes yet</td></tr>';
    } catch (err) {
      showToast(err.message);
    }
  }

  document.getElementById('open-add-attribute-modal')?.addEventListener('click', () => {
    document.getElementById('modal-add-attribute')?.classList.add('open');
  });

  document.getElementById('add-attribute-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-attribute-name').value.trim();
    const type = document.getElementById('new-attribute-type').value;
    if (!name) return;

    try {
      await authFetch('/api/contact-attributes', { method: 'POST', body: JSON.stringify({ name, type }) });
      await renderAttributesTable();
      e.target.reset();
      document.getElementById('modal-add-attribute')?.classList.remove('open');
      showToast('Attribute added');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Payment Links ---
  async function renderPaymentsTable() {
    const tbody = document.getElementById('payments-table-body');
    if (!tbody) return;
    try {
      const links = await authFetch('/api/payment-links');
      tbody.innerHTML = links.length ? links.map(p => `
        <tr><td>${p.razorpay_payment_link_id || p.id.slice(0, 8)}</td><td>${p.title}</td><td>₹${p.amount_inr.toFixed ? p.amount_inr.toFixed(2) : p.amount_inr}</td><td>Razorpay</td><td><span class="status-badge ${p.status === 'paid' ? 'active' : ''}">${p.status}</span></td></tr>
      `).join('') : '<tr><td colspan="5" style="text-align:center;color:#9CA3AF;">No payment links yet</td></tr>';
    } catch (err) {
      showToast(err.message);
    }
  }

  document.getElementById('open-create-payment-modal')?.addEventListener('click', () => {
    document.getElementById('modal-create-payment')?.classList.add('open');
  });

  document.getElementById('create-payment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const customer = document.getElementById('new-payment-customer').value.trim();
    const amount = Math.round(parseFloat(document.getElementById('new-payment-amount').value));
    if (!customer || !amount) return;

    try {
      const link = await authFetch('/api/payment-links', {
        method: 'POST',
        body: JSON.stringify({ title: `Payment from ${customer}`, amount_inr: amount })
      });
      await renderPaymentsTable();
      e.target.reset();
      document.getElementById('modal-create-payment')?.classList.remove('open');
      showToast(link.url ? `Payment link created: ${link.url}` : 'Payment link created');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Create Flow Modal ---
  document.getElementById('open-create-flow-modal')?.addEventListener('click', () => {
    document.getElementById('modal-create-flow')?.classList.add('open');
  });

  document.getElementById('create-flow-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = document.getElementById('new-flow-title').value.trim();
    const description = document.getElementById('new-flow-description').value.trim();
    if (!title || !description) return;

    document.getElementById('flows-grid')?.insertAdjacentHTML('beforeend', `
      <div style="border: 1px solid #E2E8F0; border-radius: 12px; padding: 1.25rem; background: white;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;"><span style="font-weight: 700;">${title}</span><span class="status-badge active">Draft</span></div>
        <p style="font-size: 0.85rem; color: #4B5563; margin-bottom: 0.75rem;">${description}</p>
        <div style="font-size: 0.75rem; color: #6B7280;">Submissions: 0 • Completion Rate: --</div>
      </div>
    `);

    e.target.reset();
    document.getElementById('modal-create-flow')?.classList.remove('open');
    showToast('Flow created');
  });

  // --- Wallet ---
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function renderWallet() {
    const balanceEl = document.getElementById('wallet-balance-display');
    if (!balanceEl) return;
    try {
      const { balance } = await authFetch('/api/wallet');
      balanceEl.textContent = '₹ ' + Number(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    } catch (err) {
      showToast(err.message);
    }
  }

  // Real GET /api/billing/subscription — was hardcoded fake "Pro Business
  // Plan" / Active regardless of whether the client had ever subscribed.
  const SUBSCRIPTION_STATUS_STYLE = {
    active: { bg: '#DCFCE7', color: '#15803D', label: 'Active' },
    pending_payment: { bg: '#FEF3C7', color: '#B45309', label: 'Pending Payment' },
    cancelled: { bg: '#F1F5F9', color: '#64748B', label: 'Cancelled' },
    failed: { bg: '#FEE2E2', color: '#B91C1C', label: 'Failed' },
  };

  async function renderSubscriptionTab() {
    const container = document.getElementById('subscription-content');
    if (!container) return;
    container.innerHTML = '<div style="color:#6B7280;">Loading…</div>';
    try {
      const [subscription, plans] = await Promise.all([
        authFetch('/api/billing/subscription'),
        authFetch('/api/billing/plans'),
      ]);

      if (!subscription) {
        container.innerHTML = `
          <div style="color:#6B7280; margin-bottom:1rem;">No active subscription yet.</div>
          <button class="btn-primary" style="width: auto; padding: 0 20px;" id="upgrade-subscription-btn">Choose a Plan</button>
        `;
      } else {
        const plan = plans.find(p => p.id === subscription.plan);
        const style = SUBSCRIPTION_STATUS_STYLE[subscription.status] || { bg: '#F1F5F9', color: '#64748B', label: subscription.status };
        const limitText = plan?.conversation_limit == null ? 'Unlimited conversations/month' : `${Number(plan.conversation_limit).toLocaleString('en-IN')} conversations/month`;
        container.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 1.25rem; font-weight: 700; color: #1F2937;">${escapeHtml(subscription.plan)} Plan</div>
              <div style="font-size: 0.85rem; color: #6B7280;">${plan ? `₹${plan.price_inr}/month · ${limitText}` : ''}</div>
            </div>
            <span class="status-badge" style="font-weight: 700; padding: 6px 14px; background:${style.bg}; color:${style.color};">${escapeHtml(style.label)}</span>
          </div>
          <button class="btn-primary" style="width: auto; padding: 0 20px; margin-top: 1rem;" id="upgrade-subscription-btn">Change Plan</button>
        `;
      }
      document.getElementById('upgrade-subscription-btn')?.addEventListener('click', () => {
        showToast('Redirecting to plan upgrade...');
      });
    } catch (err) {
      container.innerHTML = `<div style="color:#EF4444;">${escapeHtml(err.message)}</div>`;
    }
  }

  // Real GET /api/billing/invoices — was a single hardcoded fake "Paid"
  // invoice with a dead PDF link regardless of real billing history.
  const INVOICE_STATUS_STYLE = {
    paid: { bg: '#DCFCE7', color: '#15803D', label: 'Paid' },
    created: { bg: '#FEF3C7', color: '#B45309', label: 'Pending' },
    failed: { bg: '#FEE2E2', color: '#B91C1C', label: 'Failed' },
    refunded: { bg: '#F1F5F9', color: '#64748B', label: 'Refunded' },
  };

  async function renderBillingTab() {
    const tbody = document.getElementById('billing-invoices-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9CA3AF;">Loading…</td></tr>';
    try {
      const invoices = await authFetch('/api/billing/invoices');
      tbody.innerHTML = invoices.length ? invoices.map(inv => {
        const style = INVOICE_STATUS_STYLE[inv.status] || { bg: '#F1F5F9', color: '#64748B', label: inv.status };
        return `
          <tr>
            <td style="font-weight:600;">${escapeHtml(inv.id.slice(0, 8))}</td>
            <td>${(inv.created_at || '').slice(0, 10)}</td>
            <td>${escapeHtml(inv.plan)}</td>
            <td>₹ ${Number(inv.amount_inr).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            <td><span class="status-badge" style="background:${style.bg}; color:${style.color};">${escapeHtml(style.label)}</span></td>
          </tr>
        `;
      }).join('') : '<tr><td colspan="5" style="text-align:center;color:#9CA3AF;">No invoices yet</td></tr>';
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#EF4444;">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  document.getElementById('open-recharge-modal')?.addEventListener('click', () => {
    document.getElementById('modal-recharge-wallet')?.classList.add('open');
  });

  document.getElementById('recharge-wallet-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Math.round(parseFloat(document.getElementById('recharge-amount').value));
    if (!amount) return;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const order = await authFetch('/api/wallet/recharge', { method: 'POST', body: JSON.stringify({ amount_inr: amount }) });
      document.getElementById('modal-recharge-wallet')?.classList.remove('open');
      e.target.reset();

      if (!order.keyId) {
        showToast('Payment isn’t configured on this platform yet.');
        return;
      }

      await loadScriptOnce('https://checkout.razorpay.com/v1/checkout.js');
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.amount,
        currency: order.currency,
        name: 'Wasi CRM Wallet',
        description: `Recharge ₹${amount}`,
        theme: { color: '#4AC959' },
        handler: async () => {
          showToast('Payment received — updating balance…');
          setTimeout(renderWallet, 2000); // webhook lands asynchronously
        },
      });
      rzp.open();
    } catch (err) {
      showToast(err.message);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // --- Create Automation Rule Modal ---
  document.getElementById('open-create-rule-modal')?.addEventListener('click', () => {
    const flowSelect = document.getElementById('new-rule-flow-id');
    flowSelect.innerHTML = state.flows.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    document.getElementById('modal-create-rule')?.classList.add('open');
  });

  document.getElementById('new-rule-kind')?.addEventListener('change', (e) => {
    const isFlow = e.target.value === 'flow';
    document.getElementById('new-rule-action-group').style.display = isFlow ? 'none' : '';
    document.getElementById('new-rule-flow-group').style.display = isFlow ? '' : 'none';
  });

  document.getElementById('create-rule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-rule-title').value.trim();
    const trigger = document.getElementById('new-rule-trigger').value.trim();
    const kind = document.getElementById('new-rule-kind').value;
    if (!title || !trigger) return;

    const body = kind === 'flow'
      ? { title, trigger, flow_id: document.getElementById('new-rule-flow-id').value }
      : { title, trigger, action: document.getElementById('new-rule-action').value.trim() };
    if (kind === 'flow' && !body.flow_id) { showToast('Create a flow first, then pick it here.'); return; }
    if (kind !== 'flow' && !body.action) return;

    try {
      await authFetch('/api/automation-rules', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      await refreshAutomationRules();
      renderAutomation();
      e.target.reset();
      document.getElementById('new-rule-action-group').style.display = '';
      document.getElementById('new-rule-flow-group').style.display = 'none';
      document.getElementById('modal-create-rule')?.classList.remove('open');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Create Bot Flow Modal ---
  document.getElementById('open-create-bot-flow-btn')?.addEventListener('click', () => {
    document.getElementById('modal-create-bot-flow')?.classList.add('open');
  });

  document.getElementById('create-bot-flow-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-bot-flow-name').value.trim();
    if (!name) return;
    try {
      const flow = await authFetch('/api/automation-flows', { method: 'POST', body: JSON.stringify({ name }) });
      await refreshFlows();
      renderFlowsList();
      e.target.reset();
      document.getElementById('modal-create-bot-flow')?.classList.remove('open');
      openFlowEditor(flow.id);
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Bot Flow Editor Modal ---
  document.getElementById('bot-flow-editor-toggle-status-btn')?.addEventListener('click', async () => {
    const graph = state.currentFlowGraph;
    if (!graph) return;
    const newStatus = graph.status === 'active' ? 'archived' : 'active';
    try {
      await authFetch(`/api/automation-flows/${graph.id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
      state.currentFlowGraph.status = newStatus;
      renderFlowEditor();
      await refreshFlows();
      renderFlowsList();
      showToast(`Flow ${newStatus === 'active' ? 'activated' : 'archived'}.`);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('bot-flow-editor-add-node-btn')?.addEventListener('click', () => {
    document.getElementById('add-bot-flow-node-form')?.reset();
    document.getElementById('new-bot-flow-node-type').value = 'send_text';
    renderNewNodeConfigFields('send_text');
    document.getElementById('modal-add-bot-flow-node')?.classList.add('open');
  });

  document.getElementById('new-bot-flow-node-type')?.addEventListener('change', (e) => renderNewNodeConfigFields(e.target.value));

  document.getElementById('add-bot-flow-node-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('new-bot-flow-node-type').value;
    const config = collectNewNodeConfig(type);
    try {
      await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/nodes`, {
        method: 'POST',
        body: JSON.stringify({ type, config })
      });
      document.getElementById('modal-add-bot-flow-node')?.classList.remove('open');
      await openFlowEditor(state.currentFlowGraph.id);
      await refreshFlows();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Delegated — nodes are re-rendered on every change, so listeners attached
  // directly to them would be lost each time (same reasoning as this
  // codebase's other dynamically-rendered lists, e.g. broadcasts/contacts).
  document.getElementById('bot-flow-editor-nodes')?.addEventListener('click', async (e) => {
    const deleteNodeBtn = e.target.closest('.delete-flow-node-btn');
    const setEntryBtn = e.target.closest('.set-entry-node-btn');
    const addEdgeBtn = e.target.closest('.add-flow-edge-btn');
    const deleteEdgeBtn = e.target.closest('.delete-flow-edge-btn');
    const moveEdgeBtn = e.target.closest('.move-flow-edge-btn:not([disabled])');

    try {
      if (moveEdgeBtn) {
        const edge = state.currentFlowGraph.edges.find(x => x.id === moveEdgeBtn.dataset.edgeId);
        // Same filter as renderFlowEditor's reorderableEdges — the array is
        // already in display/priority order (the API returns edges
        // pre-sorted per flowEdgesRepo's default-last/priority/created_at
        // ordering), so no client-side re-sort is needed here.
        const siblings = state.currentFlowGraph.edges.filter(x => x.from_node_id === edge.from_node_id && x.condition_type !== 'default');
        const idx = siblings.findIndex(x => x.id === edge.id);
        const swapIdx = moveEdgeBtn.dataset.direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= siblings.length) return;
        const other = siblings[swapIdx];
        await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/edges/${edge.id}`, { method: 'PATCH', body: JSON.stringify({ priority: other.priority }) });
        await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/edges/${other.id}`, { method: 'PATCH', body: JSON.stringify({ priority: edge.priority }) });
        await openFlowEditor(state.currentFlowGraph.id);
      } else if (deleteNodeBtn) {
        await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/nodes/${deleteNodeBtn.dataset.nodeId}`, { method: 'DELETE' });
        await openFlowEditor(state.currentFlowGraph.id);
      } else if (setEntryBtn) {
        await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}`, {
          method: 'PATCH', body: JSON.stringify({ entry_node_id: setEntryBtn.dataset.nodeId })
        });
        await openFlowEditor(state.currentFlowGraph.id);
      } else if (addEdgeBtn) {
        const nodeId = addEdgeBtn.dataset.nodeId;
        const node = findNode(nodeId);
        const otherNodes = state.currentFlowGraph.nodes.filter(n => n.id !== nodeId);
        // A branch always needs a target — with only this one node in the
        // flow so far, "Go to node" would render as an empty <select> with
        // nothing to pick (reported live as a "checklist not showing up"
        // UI error). Catch it here with a clear message instead of opening
        // a modal with a broken-looking empty dropdown.
        if (otherNodes.length === 0) {
          showToast('Add another node first — a branch needs somewhere to go.');
          return;
        }
        const legalTypes = FLOW_EDGE_TYPES_BY_NODE_TYPE[node.type] || [];
        document.getElementById('add-bot-flow-edge-form').dataset.fromNodeId = nodeId;
        document.getElementById('new-bot-flow-edge-condition-type').innerHTML = legalTypes.map(t => `<option value="${t}">${FLOW_EDGE_TYPE_LABELS[t]}</option>`).join('');
        document.getElementById('new-bot-flow-edge-to-node').innerHTML = otherNodes
          .map(n => `<option value="${n.id}">${FLOW_NODE_TYPE_LABELS[n.type]}: ${nodeConfigSummary(n).slice(0, 40)}</option>`).join('');
        toggleEdgeValueField();
        document.getElementById('modal-add-bot-flow-edge')?.classList.add('open');
      } else if (deleteEdgeBtn) {
        await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/edges/${deleteEdgeBtn.dataset.edgeId}`, { method: 'DELETE' });
        await openFlowEditor(state.currentFlowGraph.id);
      }
    } catch (err) {
      showToast(err.message);
    }
  });

  function toggleEdgeValueField() {
    const type = document.getElementById('new-bot-flow-edge-condition-type').value;
    const group = document.getElementById('new-bot-flow-edge-value-group');
    const label = document.getElementById('new-bot-flow-edge-value-label');
    if (type === 'button_id') {
      group.style.display = '';
      label.textContent = 'Button (pick the exact button title from the source node)';
    } else if (type === 'keyword') {
      group.style.display = '';
      label.textContent = 'Keyword (exact match, not case-sensitive)';
    } else {
      group.style.display = 'none';
      // Hiding the field doesn't clear it — without this, a value typed for
      // a button_id/keyword edge earlier in the same modal session would
      // silently ride along on a later 'always'/'default'/'timeout' edge
      // (harmless functionally, since those condition_types never read
      // condition_value, but confusing in the edge list display).
      document.getElementById('new-bot-flow-edge-condition-value').value = '';
    }
  }
  document.getElementById('new-bot-flow-edge-condition-type')?.addEventListener('change', toggleEdgeValueField);

  document.getElementById('add-bot-flow-edge-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromNodeId = e.target.dataset.fromNodeId;
    const conditionType = document.getElementById('new-bot-flow-edge-condition-type').value;
    const conditionValue = document.getElementById('new-bot-flow-edge-condition-value').value.trim();
    const toNodeId = document.getElementById('new-bot-flow-edge-to-node').value;

    // button_id edges must carry the button's stable id, not its title —
    // resolve the typed title back to the id from the source node's config
    // (see flow_edges.condition_value's schema comment for why).
    let value = conditionValue;
    if (conditionType === 'button_id') {
      const fromNode = findNode(fromNodeId);
      const match = (fromNode?.config?.buttons || []).find(b => b.title.toLowerCase() === conditionValue.toLowerCase());
      if (!match) { showToast(`No button titled "${conditionValue}" on this node.`); return; }
      value = match.id;
    }

    try {
      await authFetch(`/api/automation-flows/${state.currentFlowGraph.id}/edges`, {
        method: 'POST',
        body: JSON.stringify({
          from_node_id: fromNodeId, to_node_id: toNodeId, condition_type: conditionType,
          ...(value ? { condition_value: value } : {}),
        })
      });
      document.getElementById('modal-add-bot-flow-edge')?.classList.remove('open');
      await openFlowEditor(state.currentFlowGraph.id);
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Website List Removal ---
  document.getElementById('website-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-website-btn');
    if (btn) btn.closest('div[style*="display: flex"]')?.remove();
  });

  // --- WhatsApp Channel Inner Tabs ---
  const innerTabBtns = document.querySelectorAll('.inner-tab-btn');
  innerTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      innerTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.inner-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `inner-tab-${btn.dataset.innerTab}`);
      });
      refreshIcons();
    });
  });

  // --- Simple Confirmation Actions ---
  document.getElementById('sync-catalog-btn')?.addEventListener('click', () => {
    showToast('Catalog synced successfully');
  });

  document.getElementById('refresh-reports-btn')?.addEventListener('click', async () => {
    const activeRepKey = document.querySelector('[data-rep-view].active')?.dataset.repView;
    if (activeRepKey === 'tags') await renderTagAnalytics();
    else if (activeRepKey === 'campaign') await renderCampaignAnalytics();
    else await renderMessageAnalytics();
    showToast('Report data refreshed');
  });

  // --- Hub API Keys (Settings > Developer) ---
  // The raw key value is never retrievable after creation — api_keys.key_hash
  // is a one-way hash (server/src/repositories/apiKeysRepo.js) and the
  // plaintext key is only ever shown once, in the response to the request
  // that just created it (POST /api/api-keys, build plan Phase 4 — added
  // specifically so a client can self-serve a key named "Zapier" without
  // contacting support; see server/src/routes/apiKeys.js's module comment).
  function apiKeyStatusBadge(key) {
    return key.revoked_at
      ? '<span class="status-badge">Revoked</span>'
      : '<span class="status-badge active">Active</span>';
  }

  async function renderApiKeysManager() {
    const tbody = document.getElementById('api-keys-table-body');
    const errorEl = document.getElementById('api-keys-error');
    if (!tbody) return;
    if (errorEl) errorEl.style.display = 'none';

    try {
      const keys = await authFetch('/api/api-keys');
      const activeCount = keys.filter((k) => !k.revoked_at).length;

      if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9CA3AF;">No API keys yet — click "+ New API Key" above to create one.</td></tr>';
        return;
      }

      tbody.innerHTML = keys.map((k) => {
        const isOnlyActiveKey = !k.revoked_at && activeCount <= 1;
        const lockTitle = 'This is your only active key. Contact support to add a replacement before removing this one.';
        const revokeBtn = k.revoked_at ? '' : `<button class="btn-secondary btn-sm" data-revoke-key="${k.id}" ${isOnlyActiveKey ? `disabled title="${lockTitle}"` : ''}>Revoke</button>`;
        const deleteBtn = `<button class="btn-secondary btn-sm" data-delete-key="${k.id}" style="margin-left:0.4rem;" ${isOnlyActiveKey ? `disabled title="${lockTitle}"` : ''}>Remove</button>`;
        const lockNote = isOnlyActiveKey
          ? `<tr><td colspan="5" style="font-size:0.75rem; color:#B45309; padding-top:0; padding-bottom:0.6rem;">${escapeHtml(lockTitle)}</td></tr>`
          : '';
        return `
          <tr>
            <td style="font-weight:600;">${escapeHtml(k.app_name)}</td>
            <td>${apiKeyStatusBadge(k)}</td>
            <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
            <td>${(k.created_at || '').slice(0, 10)}</td>
            <td style="text-align:right;">${revokeBtn}${deleteBtn}</td>
          </tr>
          ${lockNote}
        `;
      }).join('');
      refreshIcons();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
    }
  }

  document.getElementById('new-api-key-btn')?.addEventListener('click', async () => {
    const appName = prompt('Name this key (e.g. "Zapier") so you can recognize it later:');
    if (!appName || !appName.trim()) return;
    try {
      const created = await authFetch('/api/api-keys', { method: 'POST', body: JSON.stringify({ app_name: appName.trim() }) });
      const revealEl = document.getElementById('new-api-key-reveal');
      const valueEl = document.getElementById('new-api-key-value');
      if (revealEl && valueEl) {
        valueEl.value = created.key;
        revealEl.style.display = '';
      }
      showToast('API key created');
      renderApiKeysManager();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('copy-new-api-key-btn')?.addEventListener('click', () => {
    const valueEl = document.getElementById('new-api-key-value');
    if (!valueEl) return;
    navigator.clipboard.writeText(valueEl.value)
      .then(() => showToast('API key copied to clipboard'))
      .catch(() => showToast('Could not copy — clipboard permission denied'));
  });

  document.getElementById('api-keys-table-body')?.addEventListener('click', async (e) => {
    const revokeBtn = e.target.closest('[data-revoke-key]');
    const deleteBtn = e.target.closest('[data-delete-key]');

    if (revokeBtn && !revokeBtn.disabled) {
      if (!confirm('Revoke this API key? Any integration (including an MCP/Claude connection) using it will stop working immediately.')) return;
      try {
        await authFetch(`/api/api-keys/${revokeBtn.dataset.revokeKey}/revoke`, { method: 'POST' });
        showToast('API key revoked');
        renderApiKeysManager();
      } catch (err) {
        showToast(err.message);
      }
    } else if (deleteBtn && !deleteBtn.disabled) {
      if (!confirm('Remove this API key? This cannot be undone.')) return;
      try {
        await authFetch(`/api/api-keys/${deleteBtn.dataset.deleteKey}`, { method: 'DELETE' });
        showToast('API key removed');
        renderApiKeysManager();
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  // "Connect to Claude" MCP config snippet — WASI_API_BASE_URL is this
  // instance's own backend origin (same logic as API_BASE above: split
  // origin only in local dev, same-origin everywhere else), since that's
  // exactly the base URL an MCP server needs to reach this account's Hub
  // API. The key value itself is deliberately left as a placeholder — see
  // renderApiKeysManager's comment for why it can never be pre-filled here.
  function renderMcpConfigSnippet() {
    const el = document.getElementById('mcp-config-snippet');
    if (!el) return;
    const backendOrigin = API_BASE || location.origin;
    el.textContent = JSON.stringify({
      mcpServers: {
        wasi: {
          command: 'npx',
          args: ['-y', '@wasi/mcp-server'],
          env: {
            WASI_API_KEY: 'your-api-key-here',
            WASI_API_BASE_URL: backendOrigin,
          },
        },
      },
    }, null, 2);
  }

  document.getElementById('copy-mcp-config-btn')?.addEventListener('click', () => {
    const el = document.getElementById('mcp-config-snippet');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent)
      .then(() => showToast('MCP config copied to clipboard'))
      .catch(() => showToast('Could not copy — clipboard permission denied'));
  });

  // The raw secret is only ever held here, in memory, for the one render
  // right after a create/regenerate response — never written into the
  // #webhook-secret-display input's value (that field only ever shows the
  // masked form), so it can't leak via view-source/inspect element.
  function renderWebhookSecretField(webhook, revealedSecret) {
    const secretDisplay = document.getElementById('webhook-secret-display');
    const copyBtn = document.getElementById('copy-webhook-secret-btn');
    const regenBtn = document.getElementById('regenerate-webhook-secret-btn');
    const hint = document.getElementById('webhook-secret-hint');
    if (!secretDisplay) return;

    if (!webhook || !webhook.has_secret) {
      secretDisplay.value = 'Save a URL to generate one';
      copyBtn.style.display = 'none';
      regenBtn.style.display = 'none';
      hint.textContent = '';
      return;
    }

    secretDisplay.value = '•'.repeat(8) + (webhook.secret_last4 || '????');
    regenBtn.style.display = '';
    regenBtn.onclick = () => regenerateWebhookSecret();

    if (revealedSecret) {
      copyBtn.style.display = '';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(revealedSecret)
          .then(() => showToast('Secret copied to clipboard'))
          .catch(() => showToast('Could not copy — clipboard permission denied'));
      };
      hint.textContent = "New secret generated — copy it now, it won't be shown again.";
    } else {
      copyBtn.style.display = 'none';
      hint.textContent = 'Only the last 4 characters are shown after generation. Regenerate to get a fresh copyable secret.';
    }
  }

  async function renderClientWebhook() {
    const urlInput = document.getElementById('webhook-url-input');
    if (!urlInput) return;
    try {
      const webhook = await authFetch('/api/client-webhook');
      if (webhook) {
        urlInput.value = webhook.callback_url || '';
        renderWebhookSecretField(webhook, null);
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  async function regenerateWebhookSecret() {
    if (!confirm('Regenerate the webhook signing secret? The current secret will stop verifying immediately — update your endpoint with the new one before relying on it again.')) return;
    try {
      const saved = await authFetch('/api/client-webhook/regenerate-secret', { method: 'POST' });
      renderWebhookSecretField(saved, saved.secret);
      showToast('Webhook secret regenerated');
    } catch (err) {
      showToast(err.message);
    }
  }

  document.getElementById('save-webhook-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('webhook-url-input')?.value.trim();
    if (!url) return showToast('Enter a webhook URL first.');
    try {
      const saved = await authFetch('/api/client-webhook', { method: 'POST', body: JSON.stringify({ callback_url: url }) });
      // saved.secret is only present the very first time a secret is
      // generated for this client — every later save/reload only returns
      // the masked form (see server/src/routes/clientWebhook.js).
      renderWebhookSecretField(saved, saved.secret || null);
      showToast('Webhook settings saved');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Contacts Search Filter ---
  document.getElementById('contact-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#contacts-table-body tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // --- Contacts Export CSV ---
  // Real, not disabled — state.contacts is already loaded client-side, so
  // this needed no backend work, unlike Import (a parser/mapping UI and a
  // bulk-create endpoint neither of which exist yet).
  function csvField(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  document.getElementById('export-contacts-csv-btn')?.addEventListener('click', () => {
    if (!state.contacts.length) { showToast('No contacts to export.'); return; }

    const header = ['Name', 'Phone', 'Tag', 'Status', 'Opt-In', 'Created'];
    const rows = state.contacts.map(c => [
      c.name, c.phone, c.tag === '—' ? '' : c.tag, c.status, c.optInStatus, c.created,
    ].map(csvField).join(','));
    const csv = [header.join(','), ...rows].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wasi-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });

  // --- Secondary Sidebar Navigation inside Reports ---
  const repNavItems = document.querySelectorAll('[data-rep-view]');
  const repViews = document.querySelectorAll('.rep-content-view');

  repNavItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const repKey = item.dataset.repView;

      repNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      repViews.forEach(v => {
        if (v.id === `rep-view-${repKey}`) {
          v.style.display = 'block';
        } else {
          v.style.display = 'none';
        }
      });
      if (repKey === 'message') renderMessageAnalytics();
      if (repKey === 'tags') renderTagAnalytics();
      if (repKey === 'campaign') renderCampaignAnalytics();
      refreshIcons();
    });
  });

  // --- Reports: real data (spec Phase 3 — replaces hardcoded numbers) ---
  async function renderMessageAnalytics() {
    try {
      const m = await authFetch('/api/analytics/messages');
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('metric-sent', m.sent);
      set('metric-delivered', m.delivered);
      set('metric-read', m.read);
      set('metric-failed', m.failed);
      set('metric-incoming', m.incoming);
      set('metric-outgoing', m.outgoing);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function renderTagAnalytics() {
    const tbody = document.getElementById('tag-analytics-tbody');
    if (!tbody) return;
    try {
      const tags = await authFetch('/api/analytics/tags');
      tbody.innerHTML = tags.length ? tags.map(t => `
        <tr>
          <td><span class="tag-badge" style="background:${t.bg || '#F3F4F6'};color:${t.color || '#374151'};">${t.name}</span></td>
          <td>${t.contact_count}</td>
          <td>${t.conversion_rate}%</td>
          <td><span class="status-badge active">Active</span></td>
        </tr>
      `).join('') : '<tr><td colspan="4" style="text-align:center;color:#9CA3AF;">No tags yet</td></tr>';
    } catch (err) {
      showToast(err.message);
    }
  }

  async function renderCampaignAnalytics() {
    const tbody = document.getElementById('campaign-analytics-tbody');
    if (!tbody) return;
    try {
      const broadcasts = await authFetch('/api/broadcasts');
      tbody.innerHTML = broadcasts.length ? broadcasts.map(b => `
        <tr>
          <td style="font-weight:600;">${b.title}</td>
          <td>${b.delivered_count}</td>
          <td>${b.delivered_rate}%</td>
          <td>${b.read_rate}%</td>
        </tr>
      `).join('') : '<tr><td colspan="4" style="text-align:center;color:#9CA3AF;">No campaigns yet</td></tr>';
    } catch (err) {
      showToast(err.message);
    }
  }

  // --- Secondary Sidebar Navigation inside Account Settings ---
  const secNavItems = document.querySelectorAll('.sec-nav-item');
  const secViews = document.querySelectorAll('.sec-content-view');

  secNavItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const secKey = item.dataset.secView;

      secNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      secViews.forEach(v => {
        if (v.id === `sec-view-${secKey}`) {
          v.style.display = 'block';
        } else {
          v.style.display = 'none';
        }
      });
      if (secKey === 'tags') renderTagsManager();
      if (secKey === 'whatsapp') renderWhatsAppSettings();
      if (secKey === 'team') renderTeamTable();
      if (secKey === 'attributes') renderAttributesTable();
      if (secKey === 'wallet') renderWallet();
      if (secKey === 'webhook') renderClientWebhook();
      if (secKey === 'developer') { renderApiKeysManager(); renderMcpConfigSnippet(); }
      if (secKey === 'subscription') renderSubscriptionTab();
      if (secKey === 'billing') renderBillingTab();
      refreshIcons();
    });
  });

  // --- Settings: WhatsApp channel connection status + connect/reconnect ---
  // Uses the shared window.WasiEmbeddedSignup helper (embeddedSignup.js) —
  // the same Meta FB.login() flow the public onboarding wizard uses
  // (marketing/signup.js), so an already-signed-up client can (re)connect a
  // WABA from inside the app instead of only during initial signup.
  async function renderWhatsAppSettings() {
    const card = document.querySelector('#sec-view-whatsapp .channel-status-card');
    if (!card) return;
    card.innerHTML = '<div style="padding:1rem;color:#6B7280;">Checking connection…</div>';

    let status;
    try {
      status = await authFetch('/api/onboarding/whatsapp/status');
    } catch (err) {
      card.innerHTML = `<div style="padding:1rem;color:#EF4444;">${err.message}</div>`;
      renderWhatsAppProfileTabs(null);
      return;
    }

    renderWhatsAppProfileTabs(status);

    if (status.connected && status.waba) {
      card.innerHTML = `
        <div class="channel-info-left">
          <div class="wa-icon-circle"><i data-lucide="phone-call"></i></div>
          <div>
            <div style="font-weight:700;font-size:1.05rem;color:#1F2937;">${status.waba.display_name || 'WhatsApp Business'}</div>
            <div style="font-size:0.8rem;color:#6B7280;">Phone ID: ${status.waba.phone_number_id}</div>
            <div style="font-size:0.875rem;font-weight:600;color:#374151;margin-top:2px;">Quality: ${status.waba.quality_rating || 'Unknown'}</div>
          </div>
        </div>
        <span class="status-badge active" style="padding:4px 14px;font-weight:700;">Active</span>
      `;
      refreshIcons();
      return;
    }

    card.innerHTML = `
      <div class="channel-info-left">
        <div class="wa-icon-circle"><i data-lucide="phone-off"></i></div>
        <div style="font-weight:700;font-size:1.05rem;color:#1F2937;">No WhatsApp number connected</div>
      </div>
      <button type="button" class="btn-primary" id="settings-connect-wa-btn" style="padding:8px 16px;">Connect WhatsApp</button>
    `;
    refreshIcons();

    document.getElementById('settings-connect-wa-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('settings-connect-wa-btn');
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const config = await authFetch('/api/onboarding/config');
        if (!config.configured) {
          showToast('WhatsApp connection is not configured on this platform yet — contact your admin.');
          return;
        }
        const { code, waba_id, phone_number_id, via_coexistence } = await window.WasiEmbeddedSignup.connect({
          appId: config.appId,
          configId: config.configId,
          onProgress: (message) => { btn.textContent = message; },
        });
        btn.textContent = 'Finishing setup…';
        await authFetch('/api/onboarding/whatsapp/connect', {
          method: 'POST',
          body: JSON.stringify({ code, waba_id, phone_number_id, via_coexistence }),
          timeoutMs: 90_000,
        });
        showToast('WhatsApp connected!');
        await renderWhatsAppSettings();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Connect WhatsApp';
      }
    });
  }

  // Fills the Profile / Message Link / Channel Settings inner tabs (Settings
  // > WhatsApp) with the real connected number's identity, or an honest
  // "not connected" state — see renderWhatsAppSettings's header comment for
  // the bug this replaced (a permanently fake business name, phone number,
  // address, and email shown to every client regardless of what, if
  // anything, they'd actually connected). Meta's WhatsApp Business Profile
  // API (description/address/email/category/website links) isn't
  // integrated — there's no backend for those fields, so they get an honest
  // note instead of a fake pre-filled form with no save handler behind it.
  function attrEscape(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function renderWhatsAppProfileTabs(status) {
    const profileEl = document.getElementById('whatsapp-profile-content');
    const linkEl = document.getElementById('whatsapp-message-link-content');
    const settingsEl = document.getElementById('whatsapp-channel-settings-content');
    if (!profileEl && !linkEl && !settingsEl) return;

    const waba = status && status.connected ? status.waba : null;

    if (!waba) {
      const notConnected = '<div style="color:#6B7280;">Connect a WhatsApp number above to see its profile here.</div>';
      if (profileEl) profileEl.innerHTML = notConnected;
      if (linkEl) linkEl.innerHTML = notConnected;
      if (settingsEl) settingsEl.innerHTML = notConnected;
      return;
    }

    const name = waba.display_name || 'WhatsApp Business';
    const phone = waba.display_phone_number || null;
    const phoneLabel = phone || `Phone ID ${waba.phone_number_id} (dialable number not available — reconnect to fetch it)`;

    if (profileEl) {
      profileEl.innerHTML = '<div style="padding:1rem;color:#6B7280;">Loading business profile…</div>';
      renderBusinessProfileForm(waba);
    }

    if (linkEl) {
      linkEl.innerHTML = phone
        ? `
          <div class="form-group">
            <label class="form-label">Click-to-Chat Link</label>
            <input type="text" class="form-input" readonly value="https://wa.me/${attrEscape(phone.replace(/[^\d]/g, ''))}" />
          </div>
        `
        : '<div style="color:#6B7280;">Dialable phone number not available yet — reconnect this WhatsApp number to fetch it.</div>';
    }

    if (settingsEl) {
      settingsEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input type="text" class="form-input" readonly value="${attrEscape(name)}" />
        </div>
      `;
    }
  }

  const BUSINESS_PROFILE_VERTICALS = [
    ['UNDEFINED', 'Not specified'], ['OTHER', 'Other'], ['AUTO', 'Automotive'],
    ['BEAUTY', 'Beauty, Spa and Salon'], ['APPAREL', 'Clothing and Apparel'],
    ['EDU', 'Education'], ['ENTERTAIN', 'Entertainment'],
    ['EVENT_PLAN', 'Event Planning and Service'], ['FINANCE', 'Finance and Banking'],
    ['GROCERY', 'Food and Grocery'], ['GOVT', 'Public Service'],
    ['HOTEL', 'Hotel and Lodging'], ['HEALTH', 'Medical and Health'],
    ['NONPROFIT', 'Non-profit'], ['PROF_SERVICES', 'Professional Services'],
    ['RETAIL', 'Shopping and Retail'], ['TRAVEL', 'Travel and Transportation'],
    ['RESTAURANT', 'Restaurant'], ['NOT_A_BIZ', "I'm not a business"],
  ];
  const BUSINESS_PROFILE_TEXT_FIELDS = ['about', 'description', 'address', 'email', 'vertical'];
  const PROFILE_PICTURE_ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
  const PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

  // Meta's GET returns "about" even when it's just whitespace (seen live:
  // a single space) and omits address/description/email entirely — not as
  // "" — when they're unset. Both collapse to the same thing here: trim,
  // then treat a falsy/blank result as not-set.
  function trimField(value) {
    return (value || '').trim();
  }

  async function renderBusinessProfileForm(waba) {
    const container = document.getElementById('whatsapp-profile-content');
    if (!container) return;

    let result;
    try {
      result = await authFetch('/api/onboarding/whatsapp/business-profile');
    } catch (err) {
      container.innerHTML = `<div style="padding:1rem;color:#EF4444;">${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!result.connected) {
      container.innerHTML = '<div style="color:#6B7280;">Connect a WhatsApp number above to see its profile here.</div>';
      return;
    }

    const profile = result.profile || {};
    const original = {
      about: trimField(profile.about),
      address: trimField(profile.address),
      description: trimField(profile.description),
      email: trimField(profile.email),
      vertical: profile.vertical || 'UNDEFINED',
      websites: Array.isArray(profile.websites) ? profile.websites.slice(0, 2) : [],
    };
    const pictureUrl = profile.profile_picture_url || null;
    const name = waba.display_name || 'WhatsApp Business';
    const phoneLabel = waba.display_phone_number || `Phone ID ${waba.phone_number_id}`;

    container.innerHTML = `
      <div class="profile-workspace-grid">
        <div class="profile-form-card">
          <div class="form-group">
            <label class="form-label">About</label>
            <input type="text" class="form-input" id="bp-about" placeholder="Not set" maxlength="139" value="${attrEscape(original.about)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Business Description</label>
            <textarea class="form-input" id="bp-description" style="height: 100px; padding: 10px; line-height: 1.4;" placeholder="Not set" maxlength="512">${escapeHtml(original.description)}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Business address</label>
            <input type="text" class="form-input" id="bp-address" placeholder="Not set" maxlength="256" value="${attrEscape(original.address)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" class="form-input" id="bp-email" placeholder="Not set" maxlength="128" value="${attrEscape(original.email)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Business Category</label>
            <select class="form-input" id="bp-vertical">
              ${BUSINESS_PROFILE_VERTICALS.map(([val, label]) => `<option value="${val}" ${val === original.vertical ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Websites (up to 2)</label>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <input type="text" class="form-input" id="bp-website-0" placeholder="https://example.com" maxlength="256" value="${attrEscape(original.websites[0] || '')}" />
              <input type="text" class="form-input" id="bp-website-1" placeholder="https://example.com" maxlength="256" value="${attrEscape(original.websites[1] || '')}" />
            </div>
          </div>
          <button type="button" class="btn-primary" id="bp-save-btn" style="width: auto; padding: 0 20px;" disabled>Save Changes</button>
          <span id="bp-save-status" style="margin-left: 10px; font-size: 0.8rem; color: #6B7280;"></span>
        </div>

        <div class="whatsapp-preview-card">
          <div id="bp-picture-wrap" style="width: 64px; height: 64px; margin: 0 auto 8px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--color-primary-100);">
            ${pictureUrl
              ? `<img src="${attrEscape(pictureUrl)}" alt="Profile picture" style="width:100%;height:100%;object-fit:cover;" />`
              : `<span style="font-weight:700;color:var(--color-primary-900);">${escapeHtml(initialsFor(name))}</span>`}
          </div>
          <div style="font-weight: 700; font-size: 1.05rem; color: #1F2937;">${escapeHtml(name)}</div>
          <div style="font-size: 0.85rem; font-weight: 600; color: #4B5563; margin-top: 2px;">${escapeHtml(phoneLabel)}</div>
          <div style="font-size: 0.75rem; color: #9CA3AF; margin-top: 6px;">${pictureUrl ? 'A profile picture is already set.' : 'No profile picture set.'}</div>
          <button type="button" class="btn-secondary" id="bp-replace-picture-btn" style="margin-top: 10px; width: auto; padding: 0 14px;">Replace picture</button>
          <input type="file" id="bp-picture-file-input" accept="image/jpeg,image/png" style="display:none;" />
          <div id="bp-picture-status" style="font-size: 0.75rem; color: #6B7280; margin-top: 6px;"></div>
        </div>
      </div>
    `;
    refreshIcons();

    const saveBtn = document.getElementById('bp-save-btn');
    const saveStatus = document.getElementById('bp-save-status');

    function currentValue(field) {
      const el = document.getElementById(`bp-${field}`);
      return field === 'vertical' ? el.value : el.value.trim();
    }
    function currentWebsites() {
      return [document.getElementById('bp-website-0').value.trim(), document.getElementById('bp-website-1').value.trim()].filter(Boolean);
    }
    function websitesEqual(a, b) {
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    function isDirty() {
      return BUSINESS_PROFILE_TEXT_FIELDS.some((f) => currentValue(f) !== original[f])
        || !websitesEqual(currentWebsites(), original.websites);
    }
    function checkDirty() {
      saveBtn.disabled = !isDirty();
      saveStatus.textContent = '';
    }
    [...BUSINESS_PROFILE_TEXT_FIELDS.map((f) => `bp-${f}`), 'bp-website-0', 'bp-website-1'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('input', checkDirty);
      el.addEventListener('change', checkDirty);
    });

    saveBtn.addEventListener('click', async () => {
      // Only ever include a field that actually changed AND is non-blank —
      // this is what makes "send only what changed, never wipe with blank"
      // true. Clearing a field to blank is deliberately not supported yet
      // (see the toast below) rather than silently sent as "" to Meta,
      // which would clear it on the live profile for real.
      const payload = {};
      let clearedSomething = false;
      BUSINESS_PROFILE_TEXT_FIELDS.forEach((f) => {
        const val = currentValue(f);
        if (val === original[f]) return;
        if (val) payload[f] = val; else clearedSomething = true;
      });
      const newWebsites = currentWebsites();
      if (!websitesEqual(newWebsites, original.websites)) {
        if (newWebsites.length) payload.websites = newWebsites; else clearedSomething = true;
      }

      if (!Object.keys(payload).length) {
        if (clearedSomething) showToast("Clearing a field isn't supported yet — only changed or added values are saved.");
        return;
      }

      saveBtn.disabled = true;
      saveStatus.textContent = 'Saving…';
      try {
        await authFetch('/api/onboarding/whatsapp/business-profile', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast('Business profile updated.');
        await renderBusinessProfileForm(waba);
      } catch (err) {
        saveStatus.textContent = '';
        saveBtn.disabled = false;
        showToast(err.message);
      }
    });

    // Replace picture — file input stays hidden, the visible button just
    // triggers it. profile_picture_handle is never part of the Save-Changes
    // payload above; this is the only path that can ever set it, and only
    // once a real file has actually been chosen.
    const pictureInput = document.getElementById('bp-picture-file-input');
    const pictureStatus = document.getElementById('bp-picture-status');
    document.getElementById('bp-replace-picture-btn').addEventListener('click', () => pictureInput.click());
    pictureInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;

      if (!PROFILE_PICTURE_ACCEPTED_TYPES.includes(file.type)) {
        showToast('Only JPEG or PNG images are accepted.');
        return;
      }
      if (file.size > PROFILE_PICTURE_MAX_BYTES) {
        showToast('Image is too large — max 5MB.');
        return;
      }

      pictureStatus.textContent = 'Uploading…';
      const formData = new FormData();
      formData.append('file', file);
      try {
        await authFetch('/api/onboarding/whatsapp/business-profile/picture', {
          method: 'POST',
          body: formData,
        });
        showToast('Profile picture updated.');
        await renderBusinessProfileForm(waba);
      } catch (err) {
        pictureStatus.textContent = '';
        showToast(err.message);
      }
    });
  }

  // --- Modals ---
  const closeModalBtns = document.querySelectorAll('[data-close-modal]');
  closeModalBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = document.getElementById(btn.dataset.closeModal);
      if (modal) modal.classList.remove('open');
    });
  });

  document.getElementById('open-add-contact-modal')?.addEventListener('click', () => {
    document.getElementById('modal-add-contact')?.classList.add('open');
  });

  document.getElementById('add-contact-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-contact-name').value.trim();
    const phone = document.getElementById('new-contact-phone').value.trim();
    if (!name || !phone) return;

    try {
      await authFetch('/api/contacts', { method: 'POST', body: JSON.stringify({ name, phone }) });
      await refreshContacts();
      renderContacts();
      e.target.reset();
      document.getElementById('modal-add-contact')?.classList.remove('open');
    } catch (err) {
      showToast(err.message);
    }
  });

});
