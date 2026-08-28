/* ============================================================
   Wasi Admin Panel — vanilla JS, no build step, no framework.
   Talks to the live backend at API_BASE using fetch + JWT bearer auth.
   ============================================================ */

// See app.js for why this is conditional — same-origin in production
// (served by the same Express process), cross-port only in local dev.
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '4000')
  ? 'http://localhost:4000'
  : '';
const TOKEN_KEY = 'admin_token';
const ADMIN_KEY = 'admin_profile';

const state = {
  token: null,
  admin: null,
  clients: [],           // cache of GET /api/clients for the Clients page + client-detail lookups
  currentClientId: null,
  onboardingRows: [],
  wabaRows: [],
  auditRows: [],
  billingRows: [],
  templatesReviewRows: [],
  ticketRows: [],
  teamRows: [],
  apiKeyRows: [],
};

/* ---------------------------------------------------------------
   Fetch wrapper: attaches Authorization header, parses JSON,
   bounces to login on 401.
   --------------------------------------------------------------- */
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
  } catch (networkErr) {
    throw new ApiError('Network error — is the backend running at ' + API_BASE + '?', 0, null);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_e) { data = text; }
  }

  if (res.status === 401) {
    // Invalid/missing/expired token — bounce back to login.
    handleUnauthorized();
    throw new ApiError((data && data.error) || 'Session expired. Please sign in again.', 401, data);
  }

  if (!res.ok) {
    const message = (data && data.error) ? data.error : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }

  return data;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function handleUnauthorized() {
  state.token = null;
  state.admin = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_KEY);
  showLoginView();
}

/* ---------------------------------------------------------------
   Toast
   --------------------------------------------------------------- */
function showToast(message, variant = 'default') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (variant === 'error' ? ' toast-error' : variant === 'success' ? ' toast-success' : '');
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

function setInlineError(elId, message) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'flex';
  el.textContent = message;
}

/* ---------------------------------------------------------------
   Formatting helpers
   --------------------------------------------------------------- */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(status) {
  const label = status ? status.replace(/_/g, ' ') : 'unknown';
  const cls = status ? `status-${status}` : 'status-unknown';
  return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
}

const STUCK_AT_LABELS = {
  awaiting_payment: 'Awaiting Payment',
  awaiting_whatsapp_connection: 'Awaiting WhatsApp Connection',
  whatsapp_connection_in_progress: 'WhatsApp Connection In Progress',
  signup: 'Stuck at Signup',
};

function stuckAtBadge(stuckAt) {
  const label = STUCK_AT_LABELS[stuckAt] || (stuckAt || 'Unknown');
  return `<span class="stuck-badge">${escapeHtml(label)}</span>`;
}

/* ---------------------------------------------------------------
   Confirm modal (generic, reused for delete + retry-provisioning)
   --------------------------------------------------------------- */
function showConfirm({ title, body, confirmLabel = 'Confirm', danger = true, onConfirm }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-body').innerHTML = body;
  const actionBtn = document.getElementById('confirm-modal-action-btn');
  actionBtn.textContent = confirmLabel;
  actionBtn.style.background = danger ? '#DC2626' : '';
  actionBtn.className = danger ? 'btn-primary' : 'btn-primary';
  if (!danger) actionBtn.style.background = 'var(--color-primary)';

  const newBtn = actionBtn.cloneNode(true);
  actionBtn.parentNode.replaceChild(newBtn, actionBtn);
  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true;
    try {
      await onConfirm();
      closeConfirm();
    } catch (err) {
      // Leave modal open on failure? For our use cases the caller shows its own
      // toast/inline error and we still close so the user isn't stuck.
      closeConfirm();
    } finally {
      newBtn.disabled = false;
    }
  });

  modal.classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
}

/* ---------------------------------------------------------------
   Auth: login / logout
   --------------------------------------------------------------- */
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const submitBtn = document.getElementById('login-submit-btn');
  const submitLabel = document.getElementById('login-submit-label');

  setInlineError('login-error', null);
  submitBtn.disabled = true;
  submitLabel.textContent = 'Signing in…';

  try {
    const res = await fetch(`${API_BASE}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(data.error || 'Login failed', res.status, data);
    }
    state.token = data.token;
    state.admin = data.admin;
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(ADMIN_KEY, JSON.stringify(data.admin));
    showAppShell();
  } catch (err) {
    setInlineError('login-error', err.message || 'Login failed. Check your credentials.');
  } finally {
    submitBtn.disabled = false;
    submitLabel.textContent = 'Sign In';
  }
}

function handleLogout() {
  state.token = null;
  state.admin = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_KEY);
  showLoginView();
}

function showLoginView() {
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-password').value = '';
  setInlineError('login-error', null);
}

function showAppShell() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app-shell').style.display = 'flex';
  renderAdminProfile();
  if (window.lucide) lucide.createIcons();
  switchView('dashboard');
}

function renderAdminProfile() {
  if (!state.admin) return;
  document.getElementById('admin-name').textContent = state.admin.name;
  document.getElementById('admin-role').textContent = (state.admin.role || '').replace(/_/g, ' ');
  document.getElementById('admin-avatar').textContent = (state.admin.name || '?').trim().charAt(0).toUpperCase();
}

/* ---------------------------------------------------------------
   View router (CSS class toggling, matching the parent CRM's pattern)
   --------------------------------------------------------------- */
const VIEW_TITLES = {
  dashboard: 'Dashboard',
  statistics: 'Statistics',
  clients: 'Clients',
  'client-detail': 'Client Detail',
  onboarding: 'Onboarding Queue',
  'waba-health': 'WABA Health Monitor',
  'platform-overview': 'Platform Overview',
  'health-monitor': 'Health Monitor',
  volume: 'Usage & Volume',
  failures: 'Failures',
  billing: 'Billing',
  'templates-review': 'Templates Review',
  'api-keys': 'API Keys',
  tickets: 'Support / Tickets',
  team: 'Team & Roles',
  'audit-log': 'Audit Log',
  settings: 'Settings',
  'api-guide': 'API Guide',
};

// Set true only while the popstate handler below is restoring a view from a
// browser back/forward navigation — switchView() checks this so it doesn't
// push a *new* history entry in response to a navigation that came from
// history in the first place (which would break the back button: every
// "back" would immediately re-push forward).
let isRestoringViewFromHistory = false;

// KPI-card navigation and the sidebar both call plain switchView(viewName)
// with no extra params — client-detail's id and the clients status filter
// travel via `state` (already set by their callers: openClientDetail sets
// state.currentClientId before calling switchView; the dashboard cards and
// the status dropdown set state.clientsStatusFilter) rather than through
// switchView's signature, so every existing call site keeps working
// unchanged.
function hashForView(viewName) {
  if (viewName === 'client-detail' && state.currentClientId) return `#client-detail/${state.currentClientId}`;
  if (viewName === 'clients' && state.clientsStatusFilter) return `#clients?status=${encodeURIComponent(state.clientsStatusFilter)}`;
  return `#${viewName}`;
}

function switchView(viewName) {
  document.querySelectorAll('.admin-view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewName);
  });

  document.getElementById('header-title').textContent = VIEW_TITLES[viewName] || '';

  if (!isRestoringViewFromHistory) {
    const hash = hashForView(viewName);
    if (location.hash !== hash) history.pushState({ view: viewName }, '', hash);
  }

  if (viewName === 'dashboard') loadDashboard();
  else if (viewName === 'statistics') loadStatistics();
  else if (viewName === 'clients') loadClients();
  else if (viewName === 'onboarding') loadOnboarding();
  else if (viewName === 'waba-health') loadWabas();
  else if (viewName === 'platform-overview') loadPlatformOverview();
  else if (viewName === 'health-monitor') loadHealthMonitor();
  else if (viewName === 'volume') loadVolume();
  else if (viewName === 'failures') loadFailures();
  else if (viewName === 'billing') loadBilling();
  else if (viewName === 'templates-review') loadTemplatesReview();
  else if (viewName === 'api-keys') loadApiKeys();
  else if (viewName === 'tickets') loadTickets();
  else if (viewName === 'team') loadTeam();
  else if (viewName === 'audit-log') loadAuditLog();
  else if (viewName === 'settings') loadSettings();
}

function parseViewHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  if (!raw) return { viewName: 'dashboard' };
  const [pathPart, queryPart] = raw.split('?');
  const [viewName, id] = pathPart.split('/');
  const params = new URLSearchParams(queryPart || '');
  return { viewName, id, status: params.get('status') };
}

// Only meaningful once state.token exists (i.e. after showAppShell has run) —
// a back/forward navigation while still on the login screen has nothing to
// restore into.
window.addEventListener('popstate', () => {
  if (!state.token) return;
  isRestoringViewFromHistory = true;
  try {
    const { viewName, id, status } = parseViewHash(location.hash);
    if (viewName === 'client-detail' && id) {
      state.currentClientId = id;
      switchView('client-detail');
      loadClientDetail(id);
    } else if (viewName === 'clients') {
      state.clientsStatusFilter = status || null;
      switchView('clients');
    } else {
      switchView(viewName || 'dashboard');
    }
  } finally {
    isRestoringViewFromHistory = false;
  }
});

/* ---------------------------------------------------------------
   Dashboard
   --------------------------------------------------------------- */
async function loadDashboard() {
  setInlineError('dashboard-error', null);
  const grid = document.getElementById('dashboard-stats');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const overview = await apiFetch('/api/admin/overview');
    renderDashboard(overview);
  } catch (err) {
    if (err.status === 401) return;
    grid.innerHTML = '';
    setInlineError('dashboard-error', err.message);
  }
}

function renderDashboard(overview) {
  const byStatus = overview.clientsByStatus || [];
  const totalClients = byStatus.reduce((sum, s) => sum + s.count, 0);
  const activeCount = (byStatus.find((s) => s.status === 'active') || { count: 0 }).count;
  const failedOnboardings = overview.failedOnboardings || 0;
  const sent = overview.messagesToday?.sent ?? 0;
  const received = overview.messagesToday?.received ?? 0;

  const cards = [
    { icon: 'users', label: 'Total Clients', val: totalClients, onNavigate: () => { state.clientsStatusFilter = null; switchView('clients'); } },
    { icon: 'check-circle', label: 'Active Clients', val: activeCount, onNavigate: () => { state.clientsStatusFilter = 'active'; switchView('clients'); } },
    { icon: 'alert-triangle', label: 'Failed Onboardings (WABA)', val: failedOnboardings, onNavigate: () => switchView('onboarding') },
    { icon: 'send', label: 'Messages Sent Today', val: sent, onNavigate: () => switchView('volume') },
    { icon: 'inbox', label: 'Messages Received Today', val: received, onNavigate: () => switchView('volume') },
  ];

  document.getElementById('dashboard-stats').innerHTML = cards.map((c, i) => `
    <div class="stat-card${c.onNavigate ? ' clickable' : ''}" ${c.onNavigate ? `role="button" tabindex="0" data-stat-card-index="${i}"` : ''}>
      <div class="stat-icon"><i data-lucide="${c.icon}"></i></div>
      <div>
        <div class="stat-val">${c.val}</div>
        <div class="stat-label">${c.label}</div>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('#dashboard-stats [data-stat-card-index]').forEach((el) => {
    const card = cards[Number(el.getAttribute('data-stat-card-index'))];
    el.addEventListener('click', card.onNavigate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.onNavigate(); }
    });
  });

  const maxCount = Math.max(1, ...byStatus.map((s) => s.count));
  const barsHtml = byStatus.length
    ? byStatus.map((s) => `
        <div class="status-bar-row">
          <div class="status-bar-label">${statusBadge(s.status)}</div>
          <div class="status-bar-track"><div class="status-bar-fill" style="width:${(s.count / maxCount) * 100}%;"></div></div>
          <div class="status-bar-count">${s.count}</div>
        </div>
      `).join('')
    : '<div class="empty-state">No client data yet.</div>';
  document.getElementById('clients-by-status-bars').innerHTML = barsHtml;

  if (window.lucide) lucide.createIcons();
}

/* ---------------------------------------------------------------
   Statistics / Analytics — read-only trend charts over GET /api/admin/stats.
   Chart.js instances are tracked and destroyed before every re-render (date
   range change, or revisiting the view) so repeated visits don't leak
   canvases/memory. --------------------------------------------------------------- */
const statisticsCharts = {};

function destroyStatChart(key) {
  if (statisticsCharts[key]) {
    statisticsCharts[key].destroy();
    delete statisticsCharts[key];
  }
}

async function loadStatistics() {
  setInlineError('statistics-error', null);
  const loading = document.getElementById('statistics-loading');
  const content = document.getElementById('statistics-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  const days = document.getElementById('statistics-range-select').value || '30';

  try {
    const stats = await apiFetch(`/api/admin/stats?days=${encodeURIComponent(days)}`);
    renderStatistics(stats);
    content.style.display = '';
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('statistics-error', err.message);
  } finally {
    loading.style.display = 'none';
  }
}

function renderStatChart(key, canvasId, emptyId, rows, config) {
  destroyStatChart(key);
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  const hasData = rows.length > 0;
  canvas.style.display = hasData ? '' : 'none';
  empty.style.display = hasData ? 'none' : 'block';
  if (hasData) statisticsCharts[key] = new Chart(canvas, config);
}

function renderStatistics(stats) {
  // Chart.js loads from a CDN (no bundler in this admin panel, same
  // approach as Lucide) — if that's blocked/offline, skip charts rather
  // than throw; the rest of the page (activity list, filters) still works.
  if (!window.Chart) return;

  const mv = stats.messageVolume || [];
  renderStatChart('messageVolume', 'chart-message-volume', 'chart-message-volume-empty', mv, {
    type: 'line',
    data: {
      labels: mv.map((r) => formatDate(r.date)),
      datasets: [
        { label: 'Sent', data: mv.map((r) => r.messages_sent), borderColor: '#4AC959', backgroundColor: 'rgba(74,201,89,0.1)', tension: 0.3 },
        { label: 'Received', data: mv.map((r) => r.messages_received), borderColor: '#3B82F6', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });

  const cg = stats.clientGrowth || [];
  renderStatChart('clientGrowth', 'chart-client-growth', 'chart-client-growth-empty', cg, {
    type: 'bar',
    data: { labels: cg.map((r) => formatDate(r.date)), datasets: [{ label: 'New Clients', data: cg.map((r) => r.new_clients), backgroundColor: '#4AC959' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const wd = (stats.webhookDeliveries && stats.webhookDeliveries.daily) || [];
  renderStatChart('webhookDeliveries', 'chart-webhook-deliveries', 'chart-webhook-deliveries-empty', wd, {
    type: 'bar',
    data: {
      labels: wd.map((r) => formatDate(r.date)),
      datasets: [
        { label: 'Delivered', data: wd.map((r) => r.delivered), backgroundColor: '#4AC959' },
        { label: 'Failed', data: wd.map((r) => r.failed), backgroundColor: '#DC2626' },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const ak = (stats.apiKeys && stats.apiKeys.daily) || [];
  renderStatChart('apiKeys', 'chart-api-keys', 'chart-api-keys-empty', ak, {
    type: 'bar',
    data: { labels: ak.map((r) => formatDate(r.date)), datasets: [{ label: 'Keys Issued', data: ak.map((r) => r.keys_issued), backgroundColor: '#6366F1' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  // Recently active API keys — each row links into that client's detail
  // page, per the "API usage stats connect to relevant client details"
  // requirement.
  const activity = (stats.apiKeys && stats.apiKeys.recentActivity) || [];
  const listEl = document.getElementById('statistics-api-activity-list');
  listEl.innerHTML = activity.length
    ? activity.map((a) => `
        <div class="detail-row clickable-row" data-client-id="${escapeHtml(a.client_id)}" style="cursor:pointer;">
          <span class="detail-row-label">${escapeHtml(a.client_name)} <span style="color:var(--text-muted); font-weight:400;">(${escapeHtml(a.app_name)})</span></span>
          <span class="detail-row-value">${formatDateTime(a.last_used_at)}</span>
        </div>
      `).join('')
    : '<div class="empty-state">No API activity in this range.</div>';
  listEl.querySelectorAll('[data-client-id]').forEach((row) => {
    row.addEventListener('click', () => openClientDetail(row.getAttribute('data-client-id')));
  });
}

/* ---------------------------------------------------------------
   Clients list
   --------------------------------------------------------------- */
async function loadClients() {
  setInlineError('clients-error', null);
  const tbody = document.getElementById('clients-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="5">Loading…</td></tr>';

  try {
    const clients = await apiFetch('/api/clients');
    state.clients = clients;
    // A KPI card (e.g. "Active Clients") may have set this before navigating
    // here — reflect it in the dropdown and apply it to this fresh fetch.
    const statusSelect = document.getElementById('clients-status-filter');
    if (statusSelect) statusSelect.value = state.clientsStatusFilter || '';
    filterClientsTable();
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('clients-error', err.message);
  }
}

function renderClientsTable(clients) {
  const tbody = document.getElementById('clients-table-body');
  document.getElementById('clients-count-label').textContent = `${clients.length} client${clients.length === 1 ? '' : 's'}`;

  if (!clients.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="5">No clients match.</td></tr>';
    return;
  }

  tbody.innerHTML = clients.map((c) => `
    <tr class="clickable-row" data-client-id="${escapeHtml(c.id)}">
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.email)}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${escapeHtml(c.tenant_slug)}</td>
      <td>${formatDate(c.created_at)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-client-id]').forEach((row) => {
    row.addEventListener('click', () => openClientDetail(row.getAttribute('data-client-id')));
  });
}

function filterClientsTable() {
  const q = document.getElementById('clients-search').value.trim().toLowerCase();
  const status = document.getElementById('clients-status-filter').value;
  state.clientsStatusFilter = status || null;

  let filtered = state.clients;
  if (status) filtered = filtered.filter((c) => c.status === status);
  if (q) {
    filtered = filtered.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.status || '').toLowerCase().includes(q) ||
      (c.tenant_slug || '').toLowerCase().includes(q)
    );
  }
  renderClientsTable(filtered);
}

/* ---------------------------------------------------------------
   Create Client
   --------------------------------------------------------------- */
function openCreateClientModal() {
  document.getElementById('create-client-form').reset();
  // form.reset() only resets form controls — the progressive-disclosure
  // <details> sections don't participate in that, so collapse them by hand
  // for a clean reopen.
  document.querySelectorAll('#create-client-form details.form-section-details').forEach((d) => { d.open = false; });
  document.getElementById('create-client-form').style.display = '';
  document.getElementById('create-client-submit-btn').style.display = '';
  document.getElementById('create-client-result').style.display = 'none';
  document.getElementById('create-client-result').innerHTML = '';
  setInlineError('create-client-error', null);
  document.getElementById('create-client-modal').classList.add('open');
}

function closeCreateClientModal() {
  document.getElementById('create-client-modal').classList.remove('open');
}

// Pre-fills the password field so the admin can see/edit it before
// submitting — leaving it blank still works, the server generates its own
// if none is sent (routes/clients.js).
function generateClientPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const pw = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
  document.getElementById('create-client-password').value = pw;
}

async function handleCreateClientSubmit(e) {
  e.preventDefault();
  setInlineError('create-client-error', null);
  const name = document.getElementById('create-client-name').value.trim();
  const email = document.getElementById('create-client-email').value.trim();
  const password = document.getElementById('create-client-password').value;
  const btn = document.getElementById('create-client-submit-btn');
  btn.disabled = true;

  try {
    const body = { name, email };
    if (password) body.password = password;
    // Every field below is optional (see migration 035_client_onboarding_fields.js)
    // — only send the ones the admin actually filled in, so an empty string
    // never reaches z.string().email().optional() and trips validation.
    const optionalFields = {
      contact_person_name: 'create-client-contact-name',
      contact_phone: 'create-client-contact-phone',
      company_details: 'create-client-company-details',
      developer_name: 'create-client-developer-name',
      developer_phone: 'create-client-developer-phone',
      developer_email: 'create-client-developer-email',
      integration_requirements: 'create-client-integration-requirements',
      additional_notes: 'create-client-additional-notes',
    };
    for (const [field, elId] of Object.entries(optionalFields)) {
      const value = document.getElementById(elId).value.trim();
      if (value) body[field] = value;
    }
    const created = await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(body) });

    document.getElementById('create-client-form').style.display = 'none';
    const resultEl = document.getElementById('create-client-result');
    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div class="inline-success" style="margin-bottom:0.75rem;">Client created — this password and API key are shown once, copy them now.</div>
      <div class="detail-row"><span class="detail-row-label">Login URL</span><span class="detail-row-value">${escapeHtml(created.loginUrl)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-value">${escapeHtml(created.email)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Password</span><span class="detail-row-value" style="font-family:monospace; user-select:all;">${escapeHtml(created.temporaryPassword)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Hub API Key</span><span class="detail-row-value" style="font-family:monospace; font-size:0.8rem; word-break:break-all; user-select:all;">${escapeHtml(created.apiKey)}</span></div>
      <div style="margin:1rem 0; padding:0.75rem; background:var(--bg-subtle,#F8FAFC); border-radius:6px; font-size:0.85rem; line-height:1.6;">
        <strong>Next steps:</strong>
        <ol style="margin:0.4rem 0 0 1.1rem; padding:0;">
          <li>Send them the login URL, email, and password above.</li>
          <li>They log in and connect WhatsApp (Embedded Signup) themselves.</li>
          <li>Any existing approved templates on their WABA sync in automatically once connected.</li>
          <li>Hand the Hub API Key to their CRM/developer to call <code>POST /api/v1/messages</code> and <code>/api/v1/templates</code> (Authorization: Bearer). If lost, issue a new one from the API Keys page — this one still works until revoked.</li>
        </ol>
      </div>
    `;
    showToast('Client created.', 'success');
    loadClients();
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('create-client-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------
   Client Detail
   --------------------------------------------------------------- */
function openClientDetail(clientId) {
  state.currentClientId = clientId;
  switchView('client-detail');
  loadClientDetail(clientId);
}

async function loadClientDetail(clientId) {
  setInlineError('client-detail-error', null);
  document.getElementById('client-detail-content').innerHTML = '';
  document.getElementById('client-detail-loading').style.display = 'block';

  try {
    const detail = await apiFetch(`/api/admin/clients/${clientId}`);
    state.currentClientDetail = detail;
    renderClientDetail(detail);
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('client-detail-error', err.message);
  } finally {
    document.getElementById('client-detail-loading').style.display = 'none';
  }
}

const CLIENT_STATUS_OPTIONS = ['pending_setup', 'payment_confirmed', 'active', 'suspended'];

// Mirrors server/src/utils/webhookEvents.js's WEBHOOK_EVENT_TYPES — no
// endpoint exposes this list, so it's kept in sync by hand; the server's
// zod schema is the actual source of truth and will reject anything else.
const HUB_FORWARD_EVENTS = ['message.received', 'message.status', 'message_template_status_update', 'account_update'];

// revealedForwardSecret is only ever set for the one render immediately
// after a generate/regenerate response — held in a local variable here, not
// on `waba` itself and never written into a DOM attribute, so it can't leak
// via inspectable HTML and disappears the moment the user navigates away or
// the view re-renders from a plain GET (which never carries the raw value).
function renderClientDetail(detail, { revealedForwardSecret = null } = {}) {
  const { client, subscription, waba, templates, auditTrail } = detail;

  const statusOptionsHtml = CLIENT_STATUS_OPTIONS.map((s) =>
    `<option value="${s}" ${s === client.status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`
  ).join('');

  const subscriptionHtml = subscription
    ? `
      <div class="detail-row"><span class="detail-row-label">Plan</span><span class="detail-row-value">${escapeHtml(subscription.plan || '—')}</span></div>
      <div class="detail-row"><span class="detail-row-label">Status</span><span class="detail-row-value">${statusBadge(subscription.status)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Renews At</span><span class="detail-row-value">${formatDate(subscription.renews_at)}</span></div>
    `
    : `<div class="empty-state">No subscription on record for this client.</div>`;

  const wabaHtml = waba
    ? `
      <div class="detail-row"><span class="detail-row-label">WABA ID</span><span class="detail-row-value">${escapeHtml(waba.waba_id || '—')}</span></div>
      <div class="detail-row"><span class="detail-row-label">Phone Number ID</span><span class="detail-row-value">${escapeHtml(waba.phone_number_id || '—')}</span></div>
      <div class="detail-row"><span class="detail-row-label">Display Name</span><span class="detail-row-value">${escapeHtml(waba.display_name || '—')}</span></div>
      <div class="detail-row"><span class="detail-row-label">Quality Rating</span><span class="detail-row-value">${escapeHtml(waba.quality_rating || '—')}</span></div>
      <div class="detail-row"><span class="detail-row-label">Status</span><span class="detail-row-value">${statusBadge(waba.status)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Verified At</span><span class="detail-row-value">${formatDate(waba.verified_at)}</span></div>
      <div id="retry-provisioning-result"></div>
      <button class="btn-secondary btn-sm" id="retry-provisioning-btn" style="margin-top:0.75rem; width:100%; justify-content:center;">
        <i data-lucide="refresh-cw" style="width:14px;"></i> Retry Provisioning
      </button>

      <div style="margin-top:1rem; padding-top:0.85rem; border-top:1px solid var(--border,#E2E8F0);">
        <div style="font-weight:600; font-size:0.82rem; margin-bottom:0.35rem;">CRM Inbound Forwarding</div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.6rem; line-height:1.5;">
          Pushes inbound WhatsApp replies and template/account status changes to the client's own CRM webhook. Ask the client for their CRM's webhook URL before filling this in.
        </div>
        ${waba.has_forward_secret ? `
        <div class="detail-row detail-row-secret" style="margin-bottom:0.6rem;">
          <span class="detail-row-label">Webhook Secret</span>
          <span class="detail-row-value" style="display:flex; align-items:center; gap:0.4rem;">
            <span style="font-family:monospace; font-size:0.75rem;">•••••••• ${escapeHtml((revealedForwardSecret || waba.forward_secret_last4 || '????').slice(-4))}</span>
            ${revealedForwardSecret ? `<button type="button" class="btn-secondary btn-sm" id="copy-forward-secret-btn" style="padding:2px 8px; flex-shrink:0;" title="Copy secret"><i data-lucide="copy" style="width:12px;"></i></button>` : ''}
            <button type="button" class="btn-secondary btn-sm" id="regenerate-forward-secret-btn" style="padding:2px 8px; flex-shrink:0;" title="Regenerate secret"><i data-lucide="refresh-cw" style="width:12px;"></i></button>
          </span>
        </div>
        ${revealedForwardSecret ? `<div class="inline-success" style="margin-bottom:0.6rem;">New secret generated — copy it now, it won't be shown again.</div>` : `<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.6rem;">Only the last 4 characters are ever shown again after generation. Regenerate to get a fresh copyable secret.</div>`}
        ` : ''}
        <input type="url" id="hub-forward-url" class="form-input" placeholder="https://client-crm.example.com/webhooks/wasi" value="${escapeHtml(waba.forward_to_url || '')}" style="margin-bottom:0.5rem; width:100%;">
        <div style="display:flex; flex-direction:column; gap:0.3rem; margin-bottom:0.6rem; font-size:0.8rem;">
          ${HUB_FORWARD_EVENTS.map((ev) => `
            <label class="hub-event-label" style="display:flex; align-items:center; gap:0.4rem;">
              <input type="checkbox" data-hub-event value="${escapeHtml(ev)}" ${(waba.forward_events || []).includes(ev) ? 'checked' : ''}>
              <span style="font-family:monospace;">${escapeHtml(ev)}</span>
            </label>
          `).join('')}
        </div>
        <div id="hub-forward-result"></div>
        <button class="btn-secondary btn-sm" id="hub-forward-save-btn" style="width:100%; justify-content:center;">Save Forwarding Config</button>
      </div>
    `
    : `
      <div class="empty-state">No WhatsApp Business Account connected yet.</div>
      <div id="retry-provisioning-result"></div>
      <button class="btn-secondary btn-sm" id="retry-provisioning-btn" style="margin-top:0.75rem; width:100%; justify-content:center;">
        <i data-lucide="refresh-cw" style="width:14px;"></i> Retry Provisioning
      </button>
    `;

  const templatesHtml = (templates && templates.length)
    ? templates.map((t) => `
        <div class="template-mini-card">
          <div class="template-mini-header">
            <span class="template-mini-name">${escapeHtml(t.name)}</span>
            ${statusBadge(t.status)}
          </div>
          <div class="template-mini-category">${escapeHtml(t.category || '—')}</div>
          <div class="template-mini-body">${escapeHtml(t.body || '')}</div>
        </div>
      `).join('')
    : `<div class="empty-state">No templates submitted yet.</div>`;

  const auditHtml = (auditTrail && auditTrail.length)
    ? auditTrail.map((a) => `
        <div class="audit-item">
          <div class="audit-actor-icon"><i data-lucide="${a.actor_type === 'admin' ? 'shield' : 'user'}" style="width:14px;"></i></div>
          <div class="audit-item-body">
            <div class="audit-item-action">${escapeHtml(a.action)} <span style="font-weight:400; color:var(--text-muted);">by ${escapeHtml(a.actor_type)}</span></div>
            <div class="audit-item-target">${escapeHtml(a.target || '')}</div>
            <div class="audit-item-time">${formatDateTime(a.created_at)}</div>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state">No audit trail entries for this client yet.</div>`;

  document.getElementById('client-detail-content').innerHTML = `
    <div class="page-title-bar">
      <div>
        <div class="page-title">${escapeHtml(client.name)}</div>
        <div class="page-subtitle">${escapeHtml(client.email)}</div>
      </div>
      <button class="btn-danger btn-secondary" id="delete-client-btn">
        <i data-lucide="trash-2" style="width:14px;"></i> Delete Client
      </button>
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-title">Client Profile</div>
        <div class="detail-row"><span class="detail-row-label">Name</span><span class="detail-row-value">${escapeHtml(client.name)}</span></div>
        <div class="detail-row">
          <span class="detail-row-label">Client ID</span>
          <span class="detail-row-value" style="display:flex; align-items:center; gap:0.4rem;">
            <span style="font-family:monospace; font-size:0.75rem; word-break:break-all;">${escapeHtml(client.id)}</span>
            <button type="button" class="btn-secondary btn-sm copy-btn" data-copy-value="${escapeHtml(client.id)}" style="padding:2px 8px; flex-shrink:0;"><i data-lucide="copy" style="width:12px;"></i></button>
          </span>
        </div>
        <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-value">${escapeHtml(client.email)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Tenant Slug</span><span class="detail-row-value">${escapeHtml(client.tenant_slug)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Created</span><span class="detail-row-value">${formatDate(client.created_at)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Current Status</span><span class="detail-row-value">${statusBadge(client.status)}</span></div>
        <div class="status-editor-row">
          <select id="status-editor-select">${statusOptionsHtml}</select>
          <button class="btn-primary btn-sm" id="status-editor-save-btn" style="width:auto; padding:0 16px;">Save</button>
        </div>
        <div id="status-editor-result"></div>

        <div style="margin-top:0.85rem; padding-top:0.85rem; border-top:1px solid var(--border,#E2E8F0);">
          <button class="btn-secondary btn-sm" id="reset-client-password-btn" style="width:100%; justify-content:center;">
            <i data-lucide="key-round" style="width:14px;"></i> Reset Password
          </button>
          <div id="reset-client-password-result"></div>
        </div>
      </div>

      <div class="detail-card">
        <div class="detail-card-title">Subscription</div>
        ${subscriptionHtml}
      </div>

      <div class="detail-card">
        <div class="detail-card-title">WhatsApp Business Account</div>
        ${wabaHtml}
      </div>

      <div class="detail-card">
        <div class="detail-card-title">Message Templates <span style="font-weight:400; color:var(--text-muted); font-size:0.8rem;">(${(templates || []).length})</span></div>
        ${templatesHtml}
      </div>

      <div class="detail-card detail-card-full">
        <div class="detail-card-title">Audit Trail</div>
        ${auditHtml}
      </div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.getAttribute('data-copy-value') || '').then(() => {
        showToast('Copied to clipboard.', 'success');
      });
    });
  });

  document.getElementById('status-editor-save-btn').addEventListener('click', () => saveClientStatus(client.id));
  document.getElementById('retry-provisioning-btn').addEventListener('click', () => retryProvisioning(client.id));
  document.getElementById('delete-client-btn').addEventListener('click', () => confirmDeleteClient(client));
  document.getElementById('reset-client-password-btn').addEventListener('click', () => confirmResetClientPassword(client));
  const hubForwardBtn = document.getElementById('hub-forward-save-btn');
  if (hubForwardBtn) hubForwardBtn.addEventListener('click', () => saveHubForward(client.id));

  const copyForwardSecretBtn = document.getElementById('copy-forward-secret-btn');
  if (copyForwardSecretBtn && revealedForwardSecret) {
    copyForwardSecretBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(revealedForwardSecret).then(() => showToast('Copied to clipboard.', 'success'));
    });
  }
  const regenerateForwardSecretBtn = document.getElementById('regenerate-forward-secret-btn');
  if (regenerateForwardSecretBtn) regenerateForwardSecretBtn.addEventListener('click', () => confirmRegenerateForwardSecret(client.id));
}

function confirmRegenerateForwardSecret(clientId) {
  showConfirm({
    title: 'Regenerate webhook secret?',
    body: '<p>The current secret will stop working immediately — any signature verification on the client\'s CRM using the old secret will start failing until it\'s updated with the new one.</p>',
    confirmLabel: 'Regenerate',
    danger: true,
    onConfirm: async () => {
      try {
        const updated = await apiFetch(`/api/admin/clients/${clientId}/hub-forward/regenerate-secret`, { method: 'POST' });
        state.currentClientDetail = { ...state.currentClientDetail, waba: updated };
        showToast('Webhook secret regenerated.', 'success');
        renderClientDetail(state.currentClientDetail, { revealedForwardSecret: updated.forward_secret });
      } catch (err) {
        if (err.status === 401) return;
        showToast('Failed to regenerate secret: ' + err.message, 'error');
      }
    },
  });
}

async function saveHubForward(clientId) {
  const btn = document.getElementById('hub-forward-save-btn');
  const resultEl = document.getElementById('hub-forward-result');
  const forward_to_url = document.getElementById('hub-forward-url').value.trim();
  const events = Array.from(document.querySelectorAll('[data-hub-event]:checked')).map((el) => el.value);
  resultEl.innerHTML = '';

  if (!forward_to_url || !events.length) {
    resultEl.innerHTML = `<div class="inline-error" style="margin-top:0.6rem; margin-bottom:0;">A webhook URL and at least one event are required.</div>`;
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Saving…';

  try {
    const updated = await apiFetch(`/api/admin/clients/${clientId}/hub-forward`, {
      method: 'POST',
      body: JSON.stringify({ forward_to_url, events }),
    });
    showToast('Hub forwarding config saved.', 'success');
    // updated.forward_secret is only present the very first time a secret is
    // generated for this WABA — reusing it here (instead of a plain reload)
    // is the only way the admin ever sees it, since every GET after this
    // point returns only the masked/last-4 view (see admin.js's maskWaba).
    state.currentClientDetail = { ...state.currentClientDetail, waba: updated };
    renderClientDetail(state.currentClientDetail, { revealedForwardSecret: updated.forward_secret || null });
  } catch (err) {
    if (err.status === 401) return;
    resultEl.innerHTML = `<div class="inline-error" style="margin-top:0.6rem; margin-bottom:0;">${escapeHtml(err.message)}</div>`;
    showToast('Failed to save forwarding config: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function saveClientStatus(clientId) {
  const select = document.getElementById('status-editor-select');
  const btn = document.getElementById('status-editor-save-btn');
  const newStatus = select.value;
  const resultEl = document.getElementById('status-editor-result');
  resultEl.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await apiFetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    showToast('Client status updated.', 'success');
    resultEl.innerHTML = `<div class="inline-success" style="margin-top:0.75rem; margin-bottom:0;">Status updated to "${escapeHtml(newStatus.replace(/_/g, ' '))}".</div>`;
    // Refresh the whole detail view so subscription/waba/audit reflect the change.
    loadClientDetail(clientId);
  } catch (err) {
    if (err.status === 401) return;
    resultEl.innerHTML = `<div class="inline-error" style="margin-top:0.75rem; margin-bottom:0;">${escapeHtml(err.message)}</div>`;
    showToast('Failed to update status: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function retryProvisioning(clientId) {
  const btn = document.getElementById('retry-provisioning-btn');
  const resultEl = document.getElementById('retry-provisioning-result');
  resultEl.innerHTML = '';
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="spin" style="width:14px;"></i> Retrying…';
  if (window.lucide) lucide.createIcons();

  try {
    const res = await apiFetch(`/api/admin/clients/${clientId}/retry-provisioning`, { method: 'POST' });
    resultEl.innerHTML = `<div class="inline-success" style="margin-top:0.75rem; margin-bottom:0;">
      Retry succeeded — WABA status is now "${escapeHtml(res.waba.status)}".
    </div>`;
    showToast('Provisioning retry succeeded.', 'success');
    loadClientDetail(clientId);
  } catch (err) {
    if (err.status === 401) return;
    // 400 = no WABA to retry, 502 = the call to Meta failed (expected in this dev
    // environment since no real Meta app is configured). Both are normal UI states,
    // not bugs — surface them clearly instead of hiding them.
    let explanation = err.message;
    if (err.status === 502) {
      explanation = `Retry failed when calling Meta: ${err.data && err.data.detail ? err.data.detail : err.message}. This is expected in this environment — no real Meta app is configured (see server/.env.example).`;
    } else if (err.status === 400) {
      explanation = err.message;
    }
    resultEl.innerHTML = `<div class="inline-warning" style="margin-top:0.75rem; margin-bottom:0;">${escapeHtml(explanation)}</div>`;
    showToast('Retry provisioning did not succeed — see details below.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    if (window.lucide) lucide.createIcons();
  }
}

function confirmDeleteClient(client) {
  showConfirm({
    title: 'Delete this client permanently?',
    body: `
      <p style="margin-bottom:0.75rem;">You are about to permanently delete <strong>${escapeHtml(client.name)}</strong> (${escapeHtml(client.email)}).</p>
      <p style="color:#B91C1C; font-weight:600;">WARNING: this cascades and deletes every tenant table row for this client — contacts, chats, messages, everything. This cannot be undone.</p>
    `,
    confirmLabel: 'Delete Permanently',
    danger: true,
    onConfirm: async () => {
      try {
        await apiFetch(`/api/clients/${client.id}`, { method: 'DELETE' });
        showToast(`${client.name} was deleted.`, 'success');
        state.currentClientId = null;
        switchView('clients');
      } catch (err) {
        if (err.status === 401) return;
        showToast('Failed to delete client: ' + err.message, 'error');
      }
    },
  });
}

// Generates a fresh temporary password server-side and immediately
// invalidates the client's current one (routes/clients.js POST
// /:id/reset-password) — for a client that's locked out with no working
// forgot-password email flow available. Same "shown once, never stored or
// logged" contract as the create-client temporary password above.
function confirmResetClientPassword(client) {
  showConfirm({
    title: "Reset this client's password?",
    body: `
      <p style="margin-bottom:0.75rem;">This immediately invalidates <strong>${escapeHtml(client.name)}</strong>'s (${escapeHtml(client.email)}) current password and generates a new one.</p>
      <p>You'll need to send them the new password yourself — there's no notification email for this.</p>
    `,
    confirmLabel: 'Reset Password',
    danger: true,
    onConfirm: () => resetClientPassword(client),
  });
}

async function resetClientPassword(client) {
  const resultEl = document.getElementById('reset-client-password-result');
  try {
    const data = await apiFetch(`/api/clients/${client.id}/reset-password`, { method: 'POST' });
    resultEl.innerHTML = `
      <div class="inline-success" style="margin-top:0.75rem;">Password reset — shown once, copy it now.</div>
      <div class="detail-row"><span class="detail-row-label">Login URL</span><span class="detail-row-value">${escapeHtml(data.loginUrl)}</span></div>
      <div class="detail-row"><span class="detail-row-label">Email</span><span class="detail-row-value">${escapeHtml(data.email)}</span></div>
      <div class="detail-row"><span class="detail-row-label">New Password</span><span class="detail-row-value" style="font-family:monospace; user-select:all;">${escapeHtml(data.temporaryPassword)}</span></div>
    `;
    showToast('Password reset.', 'success');
  } catch (err) {
    if (err.status === 401) return;
    resultEl.innerHTML = `<div class="inline-error" style="margin-top:0.75rem;">${escapeHtml(err.message)}</div>`;
    showToast('Failed to reset password: ' + err.message, 'error');
  }
}

/* ---------------------------------------------------------------
   Onboarding Queue
   --------------------------------------------------------------- */
async function loadOnboarding() {
  setInlineError('onboarding-error', null);
  const tbody = document.getElementById('onboarding-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="7">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/onboarding-queue');
    state.onboardingRows = rows;
    renderOnboardingTable(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('onboarding-error', err.message);
  }
}

function renderOnboardingTable(rows) {
  const tbody = document.getElementById('onboarding-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="7">Nothing in the onboarding queue — every client is active.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td>${statusBadge(r.client_status)}</td>
      <td>${escapeHtml(r.plan || '—')}</td>
      <td>${stuckAtBadge(r.stuck_at)}</td>
      <td>${formatDate(r.created_at)}</td>
      <td><button class="btn-secondary btn-sm" data-jump-client="${escapeHtml(r.id)}">View</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-jump-client]').forEach((btn) => {
    btn.addEventListener('click', () => openClientDetail(btn.getAttribute('data-jump-client')));
  });
}

/* ---------------------------------------------------------------
   WABA Health
   --------------------------------------------------------------- */
async function loadWabas() {
  setInlineError('wabas-error', null);
  const tbody = document.getElementById('wabas-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="7">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/wabas');
    state.wabaRows = rows;
    renderWabasTable(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('wabas-error', err.message);
  }
}

function renderWabasTable(rows) {
  const tbody = document.getElementById('wabas-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="7">No WhatsApp Business Accounts connected yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr class="clickable-row" data-client-id="${escapeHtml(r.client_id)}">
      <td>${escapeHtml(r.client_name)}</td>
      <td>${escapeHtml(r.tenant_slug)}</td>
      <td>${escapeHtml(r.waba_id || '—')}</td>
      <td>${escapeHtml(r.phone_number_id || '—')}</td>
      <td>${escapeHtml(r.quality_rating || '—')}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${formatDate(r.verified_at)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-client-id]').forEach((row) => {
    row.addEventListener('click', () => openClientDetail(row.getAttribute('data-client-id')));
  });
}

/* ---------------------------------------------------------------
   Platform Overview
   --------------------------------------------------------------- */
async function loadPlatformOverview() {
  setInlineError('platform-overview-error', null);
  const tbody = document.getElementById('platform-overview-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="8">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/clients-overview');
    renderPlatformOverview(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('platform-overview-error', err.message);
  }
}

function renderPlatformOverview(rows) {
  const tbody = document.getElementById('platform-overview-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="8">No clients yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr class="clickable-row" data-client-id="${escapeHtml(r.id)}">
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.tenant_slug)}</td>
      <td>${statusBadge(r.client_status)}</td>
      <td>${r.waba_status ? statusBadge(r.waba_status) : '—'}</td>
      <td>${escapeHtml(r.quality_rating || '—')}</td>
      <td>${escapeHtml(r.plan || '—')}</td>
      <td>${r.subscription_status ? statusBadge(r.subscription_status) : '—'}</td>
      <td>${formatDate(r.connected_date)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-client-id]').forEach((row) => {
    row.addEventListener('click', () => openClientDetail(row.getAttribute('data-client-id')));
  });
}

/* ---------------------------------------------------------------
   Health Monitor
   --------------------------------------------------------------- */
async function loadHealthMonitor() {
  setInlineError('health-monitor-error', null);
  const tbody = document.getElementById('health-monitor-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="8">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/health');
    renderHealthMonitor(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('health-monitor-error', err.message);
  }
}

function renderHealthMonitor(rows) {
  const tbody = document.getElementById('health-monitor-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="8">No WhatsApp Business Accounts connected yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr class="clickable-row" data-client-id="${escapeHtml(r.client_id)}">
      <td>${escapeHtml(r.client_name)}</td>
      <td>${escapeHtml(r.tenant_slug)}</td>
      <td>${escapeHtml(r.waba_id || '—')}</td>
      <td>${statusBadge(r.waba_status)}</td>
      <td>${escapeHtml(r.quality_rating || '—')}</td>
      <td>${escapeHtml(r.restriction_status || '—')}</td>
      <td>${formatDateTime(r.last_successful_webhook_at)}</td>
      <td>${r.forwarding_failure_count}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-client-id]').forEach((row) => {
    row.addEventListener('click', () => openClientDetail(row.getAttribute('data-client-id')));
  });
}

/* ---------------------------------------------------------------
   Usage & Volume
   --------------------------------------------------------------- */
async function loadVolume() {
  setInlineError('volume-error', null);
  const tbody = document.getElementById('volume-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="5">Loading…</td></tr>';

  const days = document.getElementById('volume-days-filter').value;
  try {
    const rows = await apiFetch(`/api/admin/volume?days=${encodeURIComponent(days)}`);
    renderVolume(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('volume-error', err.message);
  }
}

function renderVolume(rows) {
  const tbody = document.getElementById('volume-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="5">No usage recorded in this window.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.client_name)}</td>
      <td>${formatDate(r.date)}</td>
      <td>${r.messages_sent}</td>
      <td>${r.messages_received}</td>
      <td>${r.conversations_billed}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Failures
   --------------------------------------------------------------- */
async function loadFailures() {
  setInlineError('failures-error', null);
  const sendsBody = document.getElementById('failures-sends-table-body');
  const webhooksBody = document.getElementById('failures-webhooks-table-body');
  const flowsBody = document.getElementById('failures-flows-table-body');
  sendsBody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';
  webhooksBody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';
  flowsBody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';

  try {
    const [sends, webhooks, flows] = await Promise.all([
      apiFetch('/api/admin/failures/sends'),
      apiFetch('/api/admin/failures/webhook-deliveries'),
      apiFetch('/api/admin/failures/stalled-flows'),
    ]);
    renderFailedSends(sends);
    renderFailedWebhooks(webhooks);
    renderStalledFlows(flows);
  } catch (err) {
    if (err.status === 401) return;
    sendsBody.innerHTML = '';
    webhooksBody.innerHTML = '';
    flowsBody.innerHTML = '';
    setInlineError('failures-error', err.message);
  }
}

function renderFailedSends(rows) {
  const tbody = document.getElementById('failures-sends-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No failed sends.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.client_name)}</td>
      <td style="font-family:monospace; font-size:0.78rem;">${escapeHtml(r.chat_id || '—')}</td>
      <td style="max-width:280px; white-space:normal;">${escapeHtml(r.body || '')}</td>
      <td>${escapeHtml(r.error_reason || '—')}</td>
      <td>${r.meta_error_code ?? '—'}</td>
      <td>${formatDateTime(r.sent_at)}</td>
    </tr>
  `).join('');
}

function renderFailedWebhooks(rows) {
  const tbody = document.getElementById('failures-webhooks-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No failed webhook deliveries.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.client_name)}</td>
      <td>${escapeHtml(r.event || '—')}</td>
      <td style="max-width:240px; white-space:normal; word-break:break-all;">${escapeHtml(r.target_url || '—')}</td>
      <td>${r.attempt_count}</td>
      <td style="max-width:280px; white-space:normal;">${escapeHtml(r.last_error || '—')}</td>
      <td>${formatDateTime(r.created_at)}</td>
    </tr>
  `).join('');
}

function renderStalledFlows(rows) {
  const tbody = document.getElementById('failures-flows-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No stalled flows.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.client_name)}</td>
      <td>${escapeHtml(r.contact_name || '—')} <span style="color:var(--text-muted); font-size:0.78rem;">${escapeHtml(r.contact_phone || '')}</span></td>
      <td>${escapeHtml(r.flow_name)}</td>
      <td>${escapeHtml(r.node_type || '—')}</td>
      <td style="max-width:280px; white-space:normal;">${escapeHtml((r.stall_detail && r.stall_detail.error) || '—')}</td>
      <td>${formatDateTime(r.updated_at)}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Billing
   --------------------------------------------------------------- */
async function loadBilling() {
  setInlineError('billing-error', null);
  const grid = document.getElementById('billing-stats');
  grid.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const overview = await apiFetch('/api/admin/billing/overview');
    state.billingRows = overview.subscriptions;
    renderBilling(overview);
  } catch (err) {
    if (err.status === 401) return;
    grid.innerHTML = '';
    setInlineError('billing-error', err.message);
  }
}

function renderBilling(overview) {
  const cards = [
    { icon: 'indian-rupee', label: 'Estimated MRR', val: `₹${overview.estimatedMrr.toLocaleString('en-IN')}` },
    { icon: 'check-circle', label: 'Active Subscriptions', val: overview.activeCount },
    { icon: 'alert-triangle', label: 'Failed / Pending', val: overview.failedOrPendingCount },
  ];
  document.getElementById('billing-stats').innerHTML = cards.map((c) => `
    <div class="stat-card">
      <div class="stat-icon"><i data-lucide="${c.icon}"></i></div>
      <div>
        <div class="stat-val">${c.val}</div>
        <div class="stat-label">${c.label}</div>
      </div>
    </div>
  `).join('');

  const tbody = document.getElementById('billing-table-body');
  if (!overview.subscriptions.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="5">No subscriptions yet.</td></tr>';
  } else {
    tbody.innerHTML = overview.subscriptions.map((s) => `
      <tr>
        <td>${escapeHtml(s.client_name)}</td>
        <td>${escapeHtml(s.plan)}</td>
        <td>${statusBadge(s.status)}</td>
        <td>${formatDate(s.renews_at)}</td>
        <td>${escapeHtml(s.payment_provider_ref || '—')}</td>
      </tr>
    `).join('');
  }

  if (window.lucide) lucide.createIcons();
}

/* ---------------------------------------------------------------
   Templates Review
   --------------------------------------------------------------- */
async function loadTemplatesReview() {
  setInlineError('templates-review-error', null);
  const tbody = document.getElementById('templates-review-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';

  const status = document.getElementById('templates-review-status-filter').value;
  try {
    const rows = await apiFetch(`/api/admin/templates${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.templatesReviewRows = rows;
    renderTemplatesReview(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('templates-review-error', err.message);
  }
}

function renderTemplatesReview(rows) {
  const tbody = document.getElementById('templates-review-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No templates match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((t) => `
    <tr>
      <td>${escapeHtml(t.client_name)}</td>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.category || '—')}</td>
      <td style="max-width:320px; white-space:normal;">${escapeHtml(t.body || '')}</td>
      <td>${statusBadge(t.status)}</td>
      <td style="white-space:nowrap;">
        ${t.status !== 'approved' ? `<button class="btn-secondary btn-sm" data-template-action="approved" data-template-id="${escapeHtml(t.id)}">Approve</button>` : ''}
        ${t.status !== 'rejected' ? `<button class="btn-secondary btn-sm" data-template-action="rejected" data-template-id="${escapeHtml(t.id)}" style="margin-left:6px;">Reject</button>` : ''}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-template-action]').forEach((btn) => {
    btn.addEventListener('click', () => setTemplateStatus(btn.getAttribute('data-template-id'), btn.getAttribute('data-template-action')));
  });
}

async function setTemplateStatus(templateId, status) {
  try {
    await apiFetch(`/api/admin/templates/${templateId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast(`Template ${status}.`, 'success');
    loadTemplatesReview();
  } catch (err) {
    if (err.status === 401) return;
    showToast('Failed to update template: ' + err.message, 'error');
  }
}

/* ---------------------------------------------------------------
   API Keys
   --------------------------------------------------------------- */
async function loadApiKeys() {
  setInlineError('api-keys-error', null);
  const tbody = document.getElementById('api-keys-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/api-keys');
    state.apiKeyRows = rows;
    renderApiKeys(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('api-keys-error', err.message);
  }
}

function renderApiKeys(rows) {
  const tbody = document.getElementById('api-keys-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No API keys issued yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((k) => `
    <tr>
      <td>${escapeHtml(k.client_name)}</td>
      <td>${escapeHtml(k.app_name)}</td>
      <td>${formatDateTime(k.last_used_at)}</td>
      <td>${formatDate(k.created_at)}</td>
      <td>${k.revoked_at ? statusBadge('revoked') : statusBadge('active')}</td>
      <td>
        <div class="row-actions-menu">
          <button type="button" class="row-actions-trigger" aria-haspopup="true" aria-expanded="false" data-row-menu-trigger title="Actions">
            <i data-lucide="more-vertical" style="width:16px;"></i>
          </button>
          <div class="row-actions-popover">
            ${!k.revoked_at ? `<button type="button" data-revoke-key="${escapeHtml(k.id)}" data-revoke-client="${escapeHtml(k.client_id)}"><i data-lucide="ban" style="width:14px;"></i> Revoke</button>` : ''}
            <button type="button" class="danger" data-delete-key="${escapeHtml(k.id)}" data-delete-client="${escapeHtml(k.client_id)}"><i data-lucide="trash-2" style="width:14px;"></i> Delete</button>
          </div>
        </div>
      </td>
    </tr>
  `).join('');
  if (window.lucide) lucide.createIcons();

  tbody.querySelectorAll('[data-row-menu-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = trigger.nextElementSibling;
      const wasOpen = popover.classList.contains('open');
      closeAllRowActionMenus();
      if (!wasOpen) {
        popover.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        positionRowActionsPopover(trigger, popover);
      }
    });
  });

  tbody.querySelectorAll('[data-revoke-key]').forEach((btn) => {
    btn.addEventListener('click', () => confirmRevokeApiKey(btn.getAttribute('data-revoke-key'), btn.getAttribute('data-revoke-client')));
  });
  tbody.querySelectorAll('[data-delete-key]').forEach((btn) => {
    btn.addEventListener('click', () => confirmDeleteApiKey(btn.getAttribute('data-delete-key'), btn.getAttribute('data-delete-client')));
  });
}

// The table these popovers live in has overflow-x:auto (and, per the CSS
// overflow spec, that forces overflow-y to compute as auto too), so a
// popover positioned via the default CSS (position:absolute; right:0;
// top:calc(100% + 4px)) risks being clipped by the table's own scroll
// container near its bottom/right edge. Reposition with position:fixed,
// anchored to the trigger button's live bounding rect, flipping above the
// trigger when there isn't room below.
function positionRowActionsPopover(trigger, popover) {
  const rect = trigger.getBoundingClientRect();
  const margin = 4;
  const popoverHeight = popover.offsetHeight;
  const popoverWidth = popover.offsetWidth;

  let top = rect.bottom + margin;
  if (top + popoverHeight > window.innerHeight) {
    top = rect.top - popoverHeight - margin;
  }
  if (top < margin) top = margin;

  let left = rect.right - popoverWidth;
  if (left < margin) left = margin;

  popover.style.position = 'fixed';
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  popover.style.right = 'auto';
}

function closeAllRowActionMenus() {
  document.querySelectorAll('.row-actions-popover.open').forEach((p) => {
    p.classList.remove('open');
    p.style.position = '';
    p.style.top = '';
    p.style.left = '';
    p.style.right = '';
  });
  document.querySelectorAll('[data-row-menu-trigger][aria-expanded="true"]').forEach((t) => t.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', closeAllRowActionMenus);

function confirmRevokeApiKey(keyId, clientId) {
  closeAllRowActionMenus();
  showConfirm({
    title: 'Revoke this API key?',
    body: '<p>The consuming app will immediately lose access. This cannot be undone.</p>',
    confirmLabel: 'Revoke Key',
    danger: true,
    onConfirm: async () => {
      try {
        await apiFetch(`/api/admin/api-keys/${keyId}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ client_id: clientId }),
        });
        showToast('API key revoked.', 'success');
        loadApiKeys();
      } catch (err) {
        if (err.status === 401) return;
        showToast('Failed to revoke key: ' + err.message, 'error');
      }
    },
  });
}

function confirmDeleteApiKey(keyId, clientId) {
  closeAllRowActionMenus();
  showConfirm({
    title: 'Delete this API key?',
    body: '<p>This permanently removes it from the API Keys list. If it was still active, the consuming app loses access immediately. This cannot be undone.</p>',
    confirmLabel: 'Delete Key',
    danger: true,
    onConfirm: async () => {
      try {
        await apiFetch(`/api/admin/api-keys/${keyId}`, {
          method: 'DELETE',
          body: JSON.stringify({ client_id: clientId }),
        });
        showToast('API key deleted.', 'success');
        loadApiKeys();
      } catch (err) {
        if (err.status === 401) return;
        showToast('Failed to delete key: ' + err.message, 'error');
      }
    },
  });
}

async function handleBackfillApiKeys() {
  const btn = document.getElementById('backfill-api-keys-btn');
  const resultEl = document.getElementById('backfill-api-keys-result');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="spin" style="width:14px;"></i> Issuing…';
  if (window.lucide) lucide.createIcons();

  try {
    const res = await apiFetch('/api/admin/api-keys/backfill', { method: 'POST' });
    resultEl.style.display = 'block';
    if (!res.issued.length) {
      resultEl.innerHTML = `<div class="inline-success" style="margin-bottom:0;">Every client already has an active key — nothing to issue (${res.alreadyHadKey} already covered).</div>`;
    } else {
      resultEl.innerHTML = `
        <div class="inline-success" style="margin-bottom:0.75rem;">
          Issued ${res.issued.length} new key(s) — ${res.alreadyHadKey} client(s) already had one and were skipped. Each key is shown once, copy them now.
        </div>
        <div class="table-card"><div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>Client</th><th>Key</th></tr></thead><tbody>
          ${res.issued.map((r) => `
            <tr>
              <td>${escapeHtml(r.client_name)}</td>
              <td style="font-family:monospace; font-size:0.78rem; word-break:break-all; user-select:all;">${escapeHtml(r.key)}</td>
            </tr>
          `).join('')}
        </tbody></table></div></div>
      `;
    }
    showToast(`Backfill complete — ${res.issued.length} key(s) issued.`, 'success');
    loadApiKeys();
  } catch (err) {
    if (err.status === 401) return;
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="inline-error" style="margin-bottom:0;">${escapeHtml(err.message)}</div>`;
    showToast('Failed to backfill API keys: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    if (window.lucide) lucide.createIcons();
  }
}

async function openCreateApiKeyModal() {
  document.getElementById('create-api-key-form').reset();
  document.getElementById('create-api-key-form').style.display = '';
  document.getElementById('create-api-key-result').style.display = 'none';
  document.getElementById('create-api-key-result').innerHTML = '';
  setInlineError('create-api-key-error', null);
  document.getElementById('create-api-key-modal').classList.add('open');

  const select = document.getElementById('create-api-key-client');
  select.innerHTML = '<option value="">Loading clients…</option>';
  try {
    const clients = state.clients.length ? state.clients : await apiFetch('/api/clients');
    state.clients = clients;
    select.innerHTML = clients.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  } catch (err) {
    select.innerHTML = '<option value="">Could not load clients</option>';
  }
}

function closeCreateApiKeyModal() {
  document.getElementById('create-api-key-modal').classList.remove('open');
}

async function handleCreateApiKeySubmit(e) {
  e.preventDefault();
  setInlineError('create-api-key-error', null);
  const client_id = document.getElementById('create-api-key-client').value;
  const app_name = document.getElementById('create-api-key-app-name').value.trim();
  const btn = document.getElementById('create-api-key-submit-btn');
  btn.disabled = true;

  try {
    const created = await apiFetch('/api/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ client_id, app_name }),
    });
    document.getElementById('create-api-key-form').style.display = 'none';
    const resultEl = document.getElementById('create-api-key-result');
    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div class="inline-success" style="margin-bottom:0.75rem;">Key created — this is shown once, copy it now.</div>
      <div class="form-input" style="font-family:monospace; font-size:0.8rem; word-break:break-all; user-select:all;">${escapeHtml(created.key)}</div>
    `;
    showToast('API key created.', 'success');
    loadApiKeys();
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('create-api-key-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------
   Support / Tickets
   --------------------------------------------------------------- */
const TICKET_STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'closed'];

async function loadTickets() {
  setInlineError('tickets-error', null);
  const tbody = document.getElementById('tickets-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';

  const status = document.getElementById('tickets-status-filter').value;
  try {
    const rows = await apiFetch(`/api/admin/tickets${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.ticketRows = rows;
    renderTickets(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('tickets-error', err.message);
  }
}

function renderTickets(rows) {
  const tbody = document.getElementById('tickets-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No tickets match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((t) => `
    <tr>
      <td>${escapeHtml(t.client_name)}</td>
      <td>${escapeHtml(t.subject)}</td>
      <td style="max-width:320px; white-space:normal;">${escapeHtml(t.message)}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${formatDateTime(t.created_at)}</td>
      <td>
        <select class="form-input" data-ticket-status-select="${escapeHtml(t.id)}" style="width:auto; padding:4px 8px;">
          ${TICKET_STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
        </select>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-ticket-status-select]').forEach((select) => {
    select.addEventListener('change', () => setTicketStatus(select.getAttribute('data-ticket-status-select'), select.value));
  });
}

async function setTicketStatus(ticketId, status) {
  try {
    await apiFetch(`/api/admin/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Ticket status updated.', 'success');
    const row = state.ticketRows.find((t) => t.id === ticketId);
    if (row) row.status = status;
    renderTickets(state.ticketRows);
  } catch (err) {
    if (err.status === 401) return;
    showToast('Failed to update ticket: ' + err.message, 'error');
    loadTickets();
  }
}

/* ---------------------------------------------------------------
   Team & Roles
   --------------------------------------------------------------- */
async function loadTeam() {
  setInlineError('team-error', null);
  const tbody = document.getElementById('team-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="4">Loading…</td></tr>';

  try {
    const rows = await apiFetch('/api/admin/admin-users');
    state.teamRows = rows;
    renderTeam(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('team-error', err.message);
  }
}

function renderTeam(rows) {
  const tbody = document.getElementById('team-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="4">No admin users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((a) => `
    <tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.email)}</td>
      <td>${escapeHtml((a.role || '').replace(/_/g, ' '))}</td>
      <td>${formatDate(a.created_at)}</td>
    </tr>
  `).join('');
}

function openInviteAdminModal() {
  document.getElementById('invite-admin-form').reset();
  setInlineError('invite-admin-error', null);
  document.getElementById('invite-admin-modal').classList.add('open');
}

function closeInviteAdminModal() {
  document.getElementById('invite-admin-modal').classList.remove('open');
}

async function handleInviteAdminSubmit(e) {
  e.preventDefault();
  setInlineError('invite-admin-error', null);
  const name = document.getElementById('invite-admin-name').value.trim();
  const email = document.getElementById('invite-admin-email').value.trim();
  const password = document.getElementById('invite-admin-password').value;
  const role = document.getElementById('invite-admin-role').value;
  const btn = document.getElementById('invite-admin-submit-btn');
  btn.disabled = true;

  try {
    await apiFetch('/api/admin/admin-users', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, role }),
    });
    showToast('Admin user created.', 'success');
    closeInviteAdminModal();
    loadTeam();
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('invite-admin-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------
   Settings (read-only platform config status)
   --------------------------------------------------------------- */
async function loadSettings() {
  setInlineError('settings-error', null);
  const content = document.getElementById('settings-content');
  content.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const settings = await apiFetch('/api/admin/settings');
    renderSettings(settings);
  } catch (err) {
    if (err.status === 401) return;
    content.innerHTML = '';
    setInlineError('settings-error', err.message);
  }
}

function configPill(ok, okLabel, missingLabel) {
  return ok
    ? `<span class="status-badge status-approved">${okLabel}</span>`
    : `<span class="status-badge status-rejected">${missingLabel}</span>`;
}

function renderSettings(settings) {
  document.getElementById('settings-content').innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-title">Meta / WhatsApp Embedded Signup</div>
        <div class="detail-row"><span class="detail-row-label">App configured</span><span class="detail-row-value">${configPill(settings.meta.configured, 'Configured', 'Not configured')}</span></div>
        <div class="detail-row"><span class="detail-row-label">Graph API version</span><span class="detail-row-value">${escapeHtml(settings.meta.graphApiVersion || '—')}</span></div>
        <div class="detail-row"><span class="detail-row-label">Webhook verify token</span><span class="detail-row-value">${configPill(settings.meta.webhookVerifyTokenSet, 'Set', 'Not set')}</span></div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">Razorpay Billing</div>
        <div class="detail-row"><span class="detail-row-label">API keys configured</span><span class="detail-row-value">${configPill(settings.razorpay.configured, 'Configured', 'Not configured')}</span></div>
        <div class="detail-row"><span class="detail-row-label">Webhook secret</span><span class="detail-row-value">${configPill(settings.razorpay.webhookSecretSet, 'Set', 'Not set')}</span></div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">Secret Hygiene</div>
        <div class="detail-row"><span class="detail-row-label">JWT_SECRET</span><span class="detail-row-value">${configPill(!settings.secrets.jwtSecretIsDefault, 'Rotated', 'Still default — rotate before real deploy')}</span></div>
        <div class="detail-row"><span class="detail-row-label">SERVER_SECRET</span><span class="detail-row-value">${configPill(!settings.secrets.serverSecretIsDefault, 'Rotated', 'Still default — rotate before real deploy')}</span></div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">Plan Pricing (INR/mo)</div>
        ${settings.plans.map((p) => `
          <div class="detail-row"><span class="detail-row-label">${escapeHtml(p.id)}</span><span class="detail-row-value">₹${p.price_inr}${p.conversation_limit ? ` · ${p.conversation_limit}/mo` : ' · unlimited'}</span></div>
        `).join('')}
      </div>
    </div>
    <div class="empty-state" style="margin-top:1rem; text-align:left;">
      Real secret values are never sent to this panel — this page only reports whether each is set. Edit actual values in <code>server/.env</code>.
    </div>
  `;
}

/* ---------------------------------------------------------------
   Audit Log
   --------------------------------------------------------------- */
async function loadAuditLog(clientId) {
  setInlineError('audit-error', null);
  const tbody = document.getElementById('audit-table-body');
  tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">Loading…</td></tr>';

  const path = clientId
    ? `/api/admin/audit-log?client_id=${encodeURIComponent(clientId)}`
    : '/api/admin/audit-log';

  try {
    const rows = await apiFetch(path);
    state.auditRows = rows;
    renderAuditTable(rows);
  } catch (err) {
    if (err.status === 401) return;
    tbody.innerHTML = '';
    setInlineError('audit-error', err.message);
  }
}

function renderAuditTable(rows) {
  const tbody = document.getElementById('audit-table-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="table-empty-row"><td colspan="6">No audit log entries found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((a) => `
    <tr>
      <td>${escapeHtml(a.actor_type)}</td>
      <td style="font-family:monospace; font-size:0.78rem;">${escapeHtml(a.actor_id || '—')}</td>
      <td>${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.target || '—')}</td>
      <td style="font-family:monospace; font-size:0.78rem;">${escapeHtml(a.actor_ip || '—')}</td>
      <td>${formatDateTime(a.created_at)}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Wiring / init
   --------------------------------------------------------------- */
function initEventListeners() {
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);

  document.getElementById('toggle-password-btn').addEventListener('click', () => {
    const input = document.getElementById('login-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    item.addEventListener('click', () => switchView(item.getAttribute('data-view')));
  });

  // Mobile sidebar drawer (below the 900px tablet breakpoint) — same
  // pattern as the root app's app.js; the actual show/hide rules live in
  // ../index.css since admin/index.html links that file directly.
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
    document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
      item.addEventListener('click', closeSidebar);
    });
  })();

  document.getElementById('back-to-clients-btn').addEventListener('click', () => switchView('clients'));

  document.getElementById('clients-search').addEventListener('input', filterClientsTable);
  document.getElementById('clients-status-filter').addEventListener('change', filterClientsTable);

  // Static (not re-rendered) copy targets, e.g. the API Guide's Claude Code
  // prompt block — too long/multiline to carry as a data-copy-value
  // attribute, so it copies from another element's textContent by id
  // instead of the existing data-copy-value pattern.
  document.querySelectorAll('[data-copy-value-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-copy-value-target');
      const text = document.getElementById(targetId)?.textContent || '';
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard.', 'success'));
    });
  });

  document.getElementById('statistics-range-select').addEventListener('change', loadStatistics);
  document.getElementById('statistics-webhook-failures-link').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('failures');
  });

  document.getElementById('open-create-client-btn').addEventListener('click', openCreateClientModal);
  document.querySelectorAll('[data-close-create-client]').forEach((btn) => btn.addEventListener('click', closeCreateClientModal));
  document.getElementById('create-client-modal').addEventListener('click', (e) => {
    if (e.target.id === 'create-client-modal') closeCreateClientModal();
  });
  document.getElementById('create-client-form').addEventListener('submit', handleCreateClientSubmit);
  document.getElementById('generate-client-password-btn').addEventListener('click', generateClientPassword);

  document.getElementById('refresh-dashboard-btn').addEventListener('click', loadDashboard);
  document.getElementById('refresh-onboarding-btn').addEventListener('click', loadOnboarding);
  document.getElementById('refresh-wabas-btn').addEventListener('click', loadWabas);
  document.getElementById('refresh-platform-overview-btn').addEventListener('click', loadPlatformOverview);
  document.getElementById('refresh-health-monitor-btn').addEventListener('click', loadHealthMonitor);
  document.getElementById('refresh-volume-btn').addEventListener('click', loadVolume);
  document.getElementById('volume-days-filter').addEventListener('change', loadVolume);
  document.getElementById('refresh-failures-btn').addEventListener('click', loadFailures);
  document.getElementById('refresh-audit-btn').addEventListener('click', () => {
    document.getElementById('audit-client-filter').value = '';
    loadAuditLog();
  });

  document.getElementById('refresh-billing-btn').addEventListener('click', loadBilling);

  document.getElementById('refresh-templates-review-btn').addEventListener('click', loadTemplatesReview);
  document.getElementById('templates-review-status-filter').addEventListener('change', loadTemplatesReview);

  document.getElementById('refresh-tickets-btn').addEventListener('click', loadTickets);
  document.getElementById('tickets-status-filter').addEventListener('change', loadTickets);

  document.getElementById('open-create-api-key-btn').addEventListener('click', openCreateApiKeyModal);
  document.getElementById('backfill-api-keys-btn').addEventListener('click', handleBackfillApiKeys);
  document.querySelectorAll('[data-close-create-api-key]').forEach((btn) => btn.addEventListener('click', closeCreateApiKeyModal));
  document.getElementById('create-api-key-modal').addEventListener('click', (e) => {
    if (e.target.id === 'create-api-key-modal') closeCreateApiKeyModal();
  });
  document.getElementById('create-api-key-form').addEventListener('submit', handleCreateApiKeySubmit);

  document.getElementById('open-invite-admin-btn').addEventListener('click', openInviteAdminModal);
  document.querySelectorAll('[data-close-invite-admin]').forEach((btn) => btn.addEventListener('click', closeInviteAdminModal));
  document.getElementById('invite-admin-modal').addEventListener('click', (e) => {
    if (e.target.id === 'invite-admin-modal') closeInviteAdminModal();
  });
  document.getElementById('invite-admin-form').addEventListener('submit', handleInviteAdminSubmit);

  document.getElementById('refresh-settings-btn').addEventListener('click', loadSettings);

  const auditFilterInput = document.getElementById('audit-client-filter');
  let auditFilterTimer = null;
  auditFilterInput.addEventListener('input', () => {
    clearTimeout(auditFilterTimer);
    auditFilterTimer = setTimeout(() => {
      const val = auditFilterInput.value.trim();
      loadAuditLog(val || undefined);
    }, 400);
  });
  document.getElementById('audit-clear-filter-btn').addEventListener('click', () => {
    auditFilterInput.value = '';
    loadAuditLog();
  });

  document.querySelectorAll('[data-close-confirm]').forEach((btn) => {
    btn.addEventListener('click', closeConfirm);
  });
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') closeConfirm();
  });
}

function restoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  const adminRaw = localStorage.getItem(ADMIN_KEY);
  if (!token) {
    showLoginView();
    return;
  }
  state.token = token;
  try {
    state.admin = adminRaw ? JSON.parse(adminRaw) : null;
  } catch (_e) {
    state.admin = null;
  }

  // Verify the token is still valid via /api/admin/auth/me before trusting it.
  apiFetch('/api/admin/auth/me')
    .then((admin) => {
      state.admin = admin;
      localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
      showAppShell();
    })
    .catch(() => {
      // apiFetch already routes 401 -> handleUnauthorized/showLoginView.
      // For non-401 failures (e.g. backend down), still show login with a message.
      if (state.token) {
        setInlineError('login-error', 'Could not reach the admin API to verify your session. Please sign in again.');
        showLoginView();
      }
    });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  if (window.lucide) lucide.createIcons();
  restoreSession();
});
