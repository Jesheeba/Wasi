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
      throw new Error(body.error || `Request failed (${res.status})`);
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
      created: (c.created_at || '').slice(0, 10)
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
      date: (b.scheduled_date || b.created_at || '').toString().slice(0, 10)
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
    const [tags, contacts, chats, broadcasts, automationRules, templates, tickets] = await Promise.all([
      authFetch('/api/tags'),
      authFetch('/api/contacts'),
      authFetch('/api/chats'),
      authFetch('/api/broadcasts'),
      authFetch('/api/automation-rules'),
      authFetch('/api/templates'),
      authFetch('/api/support-tickets')
    ]);

    state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));
    state.contacts = contacts.map(adaptContact);
    state.chats = chats.map(adaptChat);
    state.broadcasts = broadcasts.map(adaptBroadcast);
    state.automationRules = automationRules;
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

    if (targetView === 'chat') renderChatList();
    if (targetView === 'contacts') renderContacts();
    if (targetView === 'campaigns') renderBroadcasts();
    if (targetView === 'automation') renderAutomation();
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
  function renderContacts() {
    const contactsTableBody = document.getElementById('contacts-table-body');
    if (!contactsTableBody) return;

    contactsTableBody.innerHTML = '';
    state.contacts.forEach(c => {
      const tr = `
        <tr>
          <td style="font-weight: 600;">${c.name}</td>
          <td>${c.phone}</td>
          <td><span class="tag-badge">${c.tag}</span></td>
          <td><span class="status-badge active">${c.status}</span></td>
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
      const tr = `
        <tr>
          <td style="font-weight: 600;">${b.title}</td>
          <td><span class="tag-badge">${b.tag}</span></td>
          <td><span class="status-badge active">${b.status}</span></td>
          <td>${b.delivered}</td>
          <td>${b.readRate}</td>
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
      const card = `
        <div style="background: white; border: 1px solid var(--border-light); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-weight: 700; font-size: 1rem; color: var(--color-heading);">${rule.title}</span>
            <span class="status-badge active">${rule.status}</span>
          </div>
          <div style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem;"><strong>Trigger:</strong> ${rule.trigger}</div>
          <div style="font-size: 0.875rem; color: var(--text-muted);"><strong>Action:</strong> ${rule.action}</div>
        </div>
      `;
      automationRulesGrid.innerHTML += card;
    });
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
  function renderTemplates() {
    const templatesGrid = document.getElementById('templates-grid');
    if (!templatesGrid) return;

    templatesGrid.innerHTML = '';
    state.templates.forEach(t => {
      const card = `
        <div class="template-card">
          <div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="font-weight: 700;">${t.name}</span>
              <span class="template-badge approved">Approved</span>
            </div>
            <p style="font-size: 0.85rem; color: #4B5563; line-height: 1.4;">${t.body}</p>
          </div>
          <div style="font-size: 0.75rem; color: #6B7280; font-weight: 600;">Category: ${t.category}</div>
        </div>
      `;
      templatesGrid.innerHTML += card;
    });
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
      await authFetch('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify({ title, tag_id: tagId || undefined, templateName })
      });
      await refreshBroadcasts();
      renderBroadcasts();
      e.target.reset();
      document.getElementById('modal-create-campaign')?.classList.remove('open');
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Create Template Modal ---
  document.getElementById('open-create-template-modal')?.addEventListener('click', () => {
    document.getElementById('modal-create-template')?.classList.add('open');
  });

  document.getElementById('create-template-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-template-name').value.trim();
    const category = document.getElementById('new-template-category').value;
    const body = document.getElementById('new-template-body').value.trim();
    if (!name || !body) return;

    try {
      await authFetch('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ name, category, body })
      });
      await refreshTemplates();
      renderTemplates();
      e.target.reset();
      document.getElementById('modal-create-template')?.classList.remove('open');
    } catch (err) {
      showToast(err.message);
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
    document.getElementById('modal-create-rule')?.classList.add('open');
  });

  document.getElementById('create-rule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-rule-title').value.trim();
    const trigger = document.getElementById('new-rule-trigger').value.trim();
    const action = document.getElementById('new-rule-action').value.trim();
    if (!title || !trigger || !action) return;

    try {
      await authFetch('/api/automation-rules', {
        method: 'POST',
        body: JSON.stringify({ title, trigger, action })
      });
      await refreshAutomationRules();
      renderAutomation();
      e.target.reset();
      document.getElementById('modal-create-rule')?.classList.remove('open');
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
