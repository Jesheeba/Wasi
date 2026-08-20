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
    templates: [],
    tickets: []
  };

  const refreshIcons = () => {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  };
  refreshIcons();

  // --- API helpers ---
  async function authFetch(path, options = {}) {
    const token = localStorage.getItem('client_token');
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      localStorage.removeItem('client_token');
      stopPolling();
      showAuthView();
      throw new Error('Session expired, please log in again.');
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
    try {
      await loadInitialData();
    } catch (err) {
      showToast(err.message);
    }
    switchView('chat');
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

  // Resume session on page load if a token is already stored (spec §3 step 7: land
  // straight in the dashboard rather than re-prompting for login every refresh).
  (async () => {
    const token = localStorage.getItem('client_token');
    if (!token) return;
    try {
      const client = await authFetch('/api/auth/me');
      await enterApp(client);
    } catch {
      localStorage.removeItem('client_token');
    }
  })();

  // --- Navigation Router ---
  const navItems = document.querySelectorAll('.nav-item');
  const viewContainers = document.querySelectorAll('.view-container');

  const switchView = (targetView) => {
    state.currentView = targetView;

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
    if (targetView === 'contacts') renderContacts();
    if (targetView === 'campaigns') renderBroadcasts();
    if (targetView === 'automation') { renderAutomation(); renderFlowsList(); }
    if (targetView === 'template') renderTemplates();
    if (targetView === 'support') renderTickets();
    if (targetView === 'analytics') renderMessageAnalytics();
    if (targetView === 'payments') renderPaymentsTable();

    refreshIcons();
  };

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      if (view) switchView(view);
    });
  });

  // --- Chat View Handlers ---
  const chatEmptyPlaceholder = document.getElementById('chat-empty-placeholder');
  const chatActiveWorkspace = document.getElementById('chat-active-workspace');

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
  }

  async function openActiveChat(chat) {
    state.activeChatId = chat.id;
    if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'none';
    if (chatActiveWorkspace) chatActiveWorkspace.style.display = 'flex';

    document.getElementById('active-chat-name').innerText = chat.name;
    document.getElementById('drawer-contact-name').innerText = chat.name;
    document.getElementById('drawer-contact-phone').innerText = chat.phone;

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

  document.getElementById('new-conversation-trigger')?.addEventListener('click', () => {
    openActiveChat(state.chats[0]);
  });
  document.getElementById('start-new-chat-btn')?.addEventListener('click', () => {
    openActiveChat(state.chats[0]);
  });

  const chatMessageInput = document.getElementById('chat-message-input');
  const sendMsgBtn = document.getElementById('send-msg-btn');

  async function sendCurrentMessage() {
    const text = chatMessageInput?.value.trim();
    if (!text || !state.activeChatId) return;
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
      sendCurrentMessage();
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

  // --- Chat Attachment Picker ---
  const chatAttachmentBtn = document.getElementById('chat-attachment-btn');
  const chatAttachmentInput = document.getElementById('chat-attachment-input');

  chatAttachmentBtn?.addEventListener('click', () => chatAttachmentInput?.click());
  chatAttachmentInput?.addEventListener('change', () => {
    const file = chatAttachmentInput.files?.[0];
    if (!file || !state.activeChatId) return;

    const msgContainer = document.getElementById('chat-messages-container');
    if (msgContainer) {
      msgContainer.insertAdjacentHTML('beforeend', `
        <div class="msg-bubble msg-out">
          <div>📎 ${file.name}</div>
          <div class="msg-time">Just now</div>
        </div>
      `);
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
    chatAttachmentInput.value = '';
  });

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
    renderFlowEditor();
  }

  function renderFlowEditor() {
    const graph = state.currentFlowGraph;
    if (!graph) return;

    const statusBadge = document.getElementById('bot-flow-editor-status-badge');
    statusBadge.textContent = graph.status;
    statusBadge.className = `status-badge ${graph.status === 'active' ? 'active' : ''}`;
    const toggleBtn = document.getElementById('bot-flow-editor-toggle-status-btn');
    toggleBtn.textContent = graph.status === 'active' ? 'Archive Flow' : 'Activate Flow';
    document.getElementById('bot-flow-editor-entry-label').textContent = graph.entry_node_id
      ? `Entry node: ${findNode(graph.entry_node_id)?.type ? FLOW_NODE_TYPE_LABELS[findNode(graph.entry_node_id).type] : '—'}`
      : 'No entry node yet — the first node you add becomes the entry point.';

    const container = document.getElementById('bot-flow-editor-nodes');
    if (!graph.nodes.length) {
      container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; padding: 1rem 0;">No nodes yet — add one to get started.</div>';
      return;
    }

    container.innerHTML = graph.nodes.map(node => {
      const edges = graph.edges.filter(e => e.from_node_id === node.id);
      const isEntry = node.id === graph.entry_node_id;
      const edgeRows = edges.map(e => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.6rem; background: #F8FAFC; border-radius: 6px; margin-top: 0.4rem; font-size: 0.8rem;">
          <span>${FLOW_EDGE_TYPE_LABELS[e.condition_type] || e.condition_type}${e.condition_value ? ` "${escapeHtml(e.condition_value)}"` : ''} &rarr; ${escapeHtml(findNode(e.to_node_id) ? FLOW_NODE_TYPE_LABELS[findNode(e.to_node_id).type] : '—')}</span>
          <button type="button" class="delete-flow-edge-btn" data-edge-id="${e.id}" style="border: none; background: none; color: #DC2626; cursor: pointer; font-size: 0.75rem;">Remove</button>
        </div>
      `).join('');
      const canAddEdge = (FLOW_EDGE_TYPES_BY_NODE_TYPE[node.type] || []).length > 0;
      return `
        <div style="border: 1px solid var(--border-light); border-radius: 10px; padding: 1rem; margin-bottom: 0.75rem;" data-node-id="${node.id}">
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
          ${edgeRows}
          ${canAddEdge ? `<button type="button" class="add-flow-edge-btn btn-secondary" data-node-id="${node.id}" style="width: auto; padding: 2px 10px; font-size: 0.75rem; margin-top: 0.5rem;"><i data-lucide="plus" style="width: 12px;"></i> Add Branch</button>` : ''}
        </div>
      `;
    }).join('');
    refreshIcons();
  }

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
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="font-weight: 700;">${escapeHtml(t.name)}</span>
              <span class="template-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
            </div>
            <p style="font-size: 0.85rem; color: #4B5563; line-height: 1.4;">${bodyPreview}</p>
            ${rejectionNote}
            ${orphanedNote}
          </div>
          <div style="font-size: 0.75rem; color: #6B7280; font-weight: 600;">Category: ${escapeHtml(t.category)}</div>
        </div>
      `;
    }).join('');
  }

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
  document.getElementById('open-create-broadcast-modal')?.addEventListener('click', () => {
    populateTagSelect(document.getElementById('new-campaign-tag'));
    populateTemplateSelect(document.getElementById('new-campaign-template'));
    document.getElementById('modal-create-campaign')?.classList.add('open');
  });

  document.getElementById('create-campaign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-campaign-name').value.trim();
    const tagId = document.getElementById('new-campaign-tag').value;
    const templateName = document.getElementById('new-campaign-template').value;
    if (!title) return;
    if (!templateName) {
      showToast('Create a message template first — campaigns send via an approved template.');
      return;
    }

    try {
      const created = await authFetch('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify({ title, tag_id: tagId || undefined, templateName })
      });
      await refreshBroadcasts();
      renderBroadcasts();
      e.target.reset();
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

  // Mirrors server/src/utils/templateParams.js's extractPlaceholders/regex —
  // duplicated, not imported, since this is a no-build-step page that can't
  // require() a Node module. Kept intentionally minimal: this only drives
  // the sample-value inputs and the live preview, not the actual validation
  // rules (numbered-vs-named, words ratio, start/end position) — those stay
  // server-side, single source of truth, surfaced via the existing
  // err.body.details toast path below.
  function extractTemplateParams(text) {
    const re = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
    const names = [];
    let m;
    while ((m = re.exec(text || ''))) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
    return names;
  }

  // Mirrors server/src/utils/templateParams.js's findMalformedPlaceholders —
  // same duplication reasoning as extractTemplateParams above. Catches the
  // trap that function alone can't: a {{...}} span whose inner content
  // ISN'T a valid lowercase snake_case name (wrong case, a space, a symbol)
  // silently matches nothing in extractTemplateParams, so an author who
  // types {{Customer}} thinking they made a variable gets no sample-value
  // prompt and, previously, no warning either — the mistake just sat there.
  // This surfaces it live, as you type, not only on submit.
  function findMalformedTemplateParams(text) {
    const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
    const validName = /^[a-z0-9_]+$/;
    const found = [];
    let m;
    while ((m = re.exec(text || ''))) {
      if (!validName.test(m[1])) found.push(m[0]);
    }
    return found;
  }

  function updateTemplateMalformedWarning(fieldId, warningId, label) {
    const field = document.getElementById(fieldId);
    const warning = document.getElementById(warningId);
    if (!field || !warning) return;
    const malformed = findMalformedTemplateParams(field.value);
    if (malformed.length === 0) {
      warning.style.display = 'none';
      warning.textContent = '';
      return;
    }
    warning.style.display = '';
    warning.textContent = `${label} contains ${malformed.join(', ')}, which isn't a valid parameter name — ` +
      `parameter names must be lowercase letters, numbers, and underscores only (e.g. {{customer_name}}).`;
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
      input.addEventListener('input', updateTemplatePreview);
    });
  }

  // Button state lives in this array, not read back from the DOM each
  // time — dynamically added/removed rows make DOM-as-source-of-truth
  // fiddly, and this mirrors what actually gets submitted directly.
  let templateButtons = [];

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

  function updateTemplateHeaderField() {
    const type = document.getElementById('new-template-header-type').value;
    document.getElementById('new-template-header-text').style.display = type === 'TEXT' ? '' : 'none';
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
    updateTemplateMalformedWarning('new-template-body', 'template-body-warning', 'Body');
    updateTemplateMalformedWarning('new-template-header-text', 'template-header-warning', 'Header');
    updateTemplatePreview();
  }

  document.getElementById('open-create-template-modal')?.addEventListener('click', () => {
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
    document.getElementById('modal-create-template')?.classList.add('open');
    syncTemplateFormUI();
  });

  renderTemplateLanguageOptions();
  document.getElementById('new-template-category')?.addEventListener('change', updateTemplateCategoryFields);
  document.getElementById('new-template-header-type')?.addEventListener('change', updateTemplateHeaderField);
  document.getElementById('new-template-header-text')?.addEventListener('input', () => {
    updateTemplateMalformedWarning('new-template-header-text', 'template-header-warning', 'Header');
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
    updateTemplateMalformedWarning('new-template-body', 'template-body-warning', 'Body');
    updateTemplatePreview();
  });
  document.querySelectorAll('.template-add-button-btn').forEach((btn) => {
    btn.addEventListener('click', () => addTemplateButton(btn.dataset.addButton));
  });
  syncTemplateFormUI();

  document.getElementById('create-template-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-template-name').value.trim();
    const category = document.getElementById('new-template-category').value;
    const language = document.getElementById('new-template-language').value;
    if (!name) return;

    const payload = { name, category, language };

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
      if (headerType !== 'NONE') {
        payload.header = { type: headerType, text: document.getElementById('new-template-header-text').value.trim() };
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
      await authFetch('/api/templates', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await refreshTemplates();
      renderTemplates();
      e.target.reset();
      templateButtons = [];
      renderTemplateButtonsList();
      syncTemplateFormUI();
      document.getElementById('modal-create-template')?.classList.remove('open');
    } catch (err) {
      // Named-parameter validation failures (server/src/utils/templateParams.js)
      // and other structured errors come back as { error, details: [string, ...] }
      // — surface the specific reason (e.g. "numbered parameters not allowed",
      // "sample value required for: ...") rather than the generic top-level
      // message. (Zod's own 400s also have a `details` array, but of issue
      // objects, not strings — the typeof check below skips those.)
      const details = err.body && Array.isArray(err.body.details) && err.body.details.every((d) => typeof d === 'string')
        ? err.body.details.join(' ')
        : null;
      showToast(details || err.message);
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

    try {
      if (deleteNodeBtn) {
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

  document.getElementById('copy-api-key-btn')?.addEventListener('click', () => {
    const input = document.getElementById('api-key-input');
    if (!input) return;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(input.value)
        .then(() => showToast('API key copied to clipboard'))
        .catch(() => showToast('Could not copy — clipboard permission denied'));
    } else {
      showToast('Clipboard access not available in this browser');
    }
  });

  async function renderClientWebhook() {
    const urlInput = document.getElementById('webhook-url-input');
    const secretDisplay = document.getElementById('webhook-secret-display');
    if (!urlInput) return;
    try {
      const webhook = await authFetch('/api/client-webhook');
      if (webhook) {
        urlInput.value = webhook.callback_url;
        if (secretDisplay) secretDisplay.value = webhook.secret;
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  document.getElementById('save-webhook-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('webhook-url-input')?.value.trim();
    if (!url) return showToast('Enter a webhook URL first.');
    try {
      const saved = await authFetch('/api/client-webhook', { method: 'POST', body: JSON.stringify({ callback_url: url }) });
      const secretDisplay = document.getElementById('webhook-secret-display');
      if (secretDisplay) secretDisplay.value = saved.secret;
      showToast('Webhook settings saved');
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('upgrade-subscription-btn')?.addEventListener('click', () => {
    showToast('Redirecting to plan upgrade...');
  });

  // --- Contacts Search Filter ---
  document.getElementById('contact-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#contacts-table-body tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
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
      return;
    }

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
        const { code, waba_id, phone_number_id } = await window.WasiEmbeddedSignup.connect({
          appId: config.appId,
          configId: config.configId,
        });
        await authFetch('/api/onboarding/whatsapp/connect', {
          method: 'POST',
          body: JSON.stringify({ code, waba_id, phone_number_id }),
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
