/* ============================================================
   Wasi Admin Panel — vanilla JS, no build step, no framework.
   Talks to the live backend at API_BASE using fetch + JWT bearer auth.

   UI redesign Stage 11: this file has its OWN helpers (typed toast,
   escapeHtml, showConfirm, modal a11y) — it does not share app.js's.
   Rules every render function here follows:
   - every dynamic value that reaches innerHTML goes through esc()/escapeHtml()
   - statuses render through badge()/statusBadge() (one component, no inline hex)
   - lists show a skeleton while loading, an empty state when there is no data,
     and an error state with a retry when the request fails
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
  currentClientDetail: null,
  clientDetailTab: 'overview',
  clientsStatusFilter: null,
  viewTab: { health: 'monitor', statistics: 'trends' },
  onboardingRows: [],
  wabaRows: [],
  auditRows: [],
  billingRows: [],
  templatesReviewRows: [],
  ticketRows: [],
  teamRows: [],
  apiKeyRows: [],
  failuresSends: [],
  failuresWebhooks: [],
  failuresFlows: [],
  volumeRows: [],
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
   Toast — typed (success / error / info), screen-reader announced.
   textContent only, so a message can never inject markup.
   --------------------------------------------------------------- */
function showToast(message, variant = 'default') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const type = variant === 'error' ? 'error' : variant === 'success' ? 'success' : 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.appendChild(msg);

  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  if (type === 'error') {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', dismiss);
    el.appendChild(close);
  }
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(dismiss, type === 'error' ? 7000 : 4000);
}

// Inline banner for a failed load. Pass retryFn to add a "Try again" button.
function setInlineError(elId, message, retryFn) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'flex';
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (retryFn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary btn-sm';
    btn.textContent = 'Try again';
    btn.addEventListener('click', () => retryFn());
    el.appendChild(btn);
  }
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
const esc = escapeHtml;

function titleCase(str) {
  return String(str || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------------------------------------------------------------
   Badges — ONE component (.badge .badge-<tone>). Status -> tone is an
   honest mapping: green only for a genuinely good/complete state, amber for
   waiting-on-someone, red for failed/blocked/revoked, blue for in-progress,
   grey for neutral/unknown.
   --------------------------------------------------------------- */
const BADGE_TONE = {
  active: 'success', approved: 'success', connected: 'success', resolved: 'success',
  paid: 'success', read: 'success', available: 'success', verified: 'success',
  pending: 'warning', pending_setup: 'warning', payment_confirmed: 'warning', connecting: 'warning',
  open: 'warning', unpaid: 'warning', incomplete_meta_linked: 'warning', needs_manual_resolution: 'warning',
  suspended: 'danger', failed: 'danger', revoked: 'danger', rejected: 'danger', blocked: 'danger',
  in_progress: 'info', delivered: 'info',
  closed: 'neutral', unknown: 'neutral', sent: 'neutral',
};

function badge(label, tone = 'neutral', title) {
  return `<span class="badge badge-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
}

function statusBadge(status) {
  const key = status ? String(status).toLowerCase() : 'unknown';
  return badge(status ? titleCase(status) : 'Unknown', BADGE_TONE[key] || 'neutral');
}

const STUCK_AT_LABELS = {
  awaiting_payment: 'Awaiting Payment',
  awaiting_whatsapp_connection: 'Awaiting WhatsApp Connection',
  whatsapp_connection_in_progress: 'WhatsApp Connection In Progress',
  signup: 'Stuck at Signup',
};

function stuckAtBadge(stuckAt) {
  return badge(STUCK_AT_LABELS[stuckAt] || (stuckAt || 'Unknown'), 'warning');
}

/* ---------------------------------------------------------------
   List-state helpers: skeleton / empty / error rows, pager, rows that are
   keyboard-focusable, tabs.
   --------------------------------------------------------------- */
function skeletonRows(cols, n = 4) {
  return [60, 45, 55, 40, 50].slice(0, n).map((w) =>
    `<tr class="table-state" aria-hidden="true"><td colspan="${cols}" class="state-cell skel-row"><span class="skeleton" style="height:16px;width:${w}%;"></span></td></tr>`
  ).join('');
}

function stateRow(cols, innerHtml) {
  return `<tr class="table-state"><td colspan="${cols}" class="state-cell">${innerHtml}</td></tr>`;
}

function emptyRow(cols, title, text, icon = 'inbox') {
  return stateRow(cols, `
    <div class="empty-state">
      <i data-lucide="${esc(icon)}" class="empty-icon"></i>
      <div class="empty-title">${esc(title)}</div>
      ${text ? `<div>${esc(text)}</div>` : ''}
    </div>`);
}

function showTableLoading(tbodyId, cols) {
  const tbody = document.getElementById(tbodyId);
  if (tbody) tbody.innerHTML = skeletonRows(cols);
}

function showTableError(tbodyId, cols, message, retryFn) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = stateRow(cols, `
    <div class="error-state" role="alert">
      <div>${esc(message)}</div>
      <button type="button" class="btn-secondary" data-table-retry>Try again</button>
    </div>`);
  const btn = tbody.querySelector('[data-table-retry]');
  if (btn && retryFn) btn.addEventListener('click', () => retryFn());
}

// Client-side pagination for tables that can grow long. `key` namespaces the
// current page; callers resetPage(key) whenever a filter/search changes.
const pageState = {};
function resetPage(key) { pageState[key] = 1; }

function pageSlice(key, rows, size, pagerId, redraw) {
  const pager = document.getElementById(pagerId);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(pageState[key] || 1, 1), pages);
  pageState[key] = page;
  if (pager) {
    if (rows.length <= size) {
      pager.hidden = true;
      pager.innerHTML = '';
    } else {
      pager.hidden = false;
      const from = (page - 1) * size + 1;
      const to = Math.min(rows.length, page * size);
      pager.innerHTML = `
        <span>Showing ${from}–${to} of ${rows.length}</span>
        <div class="pagination-btns">
          <button type="button" class="btn-secondary btn-sm" data-pg="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="btn-secondary btn-sm" data-pg="next" ${page >= pages ? 'disabled' : ''}>Next</button>
        </div>`;
      pager.querySelector('[data-pg="prev"]').addEventListener('click', () => { pageState[key] = page - 1; redraw(); });
      pager.querySelector('[data-pg="next"]').addEventListener('click', () => { pageState[key] = page + 1; redraw(); });
    }
  }
  return rows.slice((page - 1) * size, page * size);
}

// Rows that open something: focusable, Enter/Space opens, clicks on nested
// controls (buttons, links, selects) are left alone.
function bindClickableRows(tbody, attr, handler) {
  tbody.querySelectorAll(`[${attr}]`).forEach((row) => {
    row.setAttribute('tabindex', '0');
    row.classList.add('clickable-row');
    const open = () => handler(row.getAttribute(attr), row);
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a, select, input, label')) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

/* Tabs — a .tabs[role=tablist] of .tab[role=tab][data-tab] buttons controlling
   .tab-panel[role=tabpanel][data-panel] siblings inside `root`. */
function showTab(root, tabName) {
  root.querySelectorAll('[role="tab"]').forEach((t) => {
    const on = t.getAttribute('data-tab') === tabName;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.setAttribute('tabindex', on ? '0' : '-1');
  });
  root.querySelectorAll('[role="tabpanel"]').forEach((p) => {
    p.hidden = p.getAttribute('data-panel') !== tabName;
  });
}

function initTablist(tablist, onSelect) {
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => onSelect(t.getAttribute('data-tab')));
    t.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabs[next].focus();
      onSelect(tabs[next].getAttribute('data-tab'));
    });
  });
}

/* Clipboard — one delegated handler for every [data-copy-value] and
   [data-copy-value-target] button, including ones rendered later. */
async function copyText(text, okMessage = 'Copied to clipboard.') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage, 'success');
    return true;
  } catch (_e) {
    showToast('Could not copy automatically — select the text and copy it manually.', 'error');
    return false;
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-value], [data-copy-value-target]');
  if (!btn) return;
  const targetId = btn.getAttribute('data-copy-value-target');
  const text = targetId
    ? (document.getElementById(targetId)?.textContent || '')
    : (btn.getAttribute('data-copy-value') || '');
  copyText(text).then((ok) => {
    if (ok) btn.setAttribute('data-copied', 'true');
  });
});

/* ---------------------------------------------------------------
   Modal accessibility — applied to every .modal-overlay without touching any
   modal's own open/close code: dialog semantics, focus moved in on open and
   restored on close, a Tab focus trap, and Escape-to-close (via the modal's
   own close button, so any guard it wires there still runs).
   --------------------------------------------------------------- */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const modalReturnFocus = new WeakMap();
const isShown = (el) => el.offsetParent !== null || el.getClientRects().length > 0;

function setupModalAccessibility() {
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    const box = overlay.querySelector('.modal-box');
    if (box) {
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = box.querySelector('.modal-title');
      if (title) {
        if (!title.id) title.id = `${overlay.id || 'modal'}-title-auto`;
        box.setAttribute('aria-labelledby', title.id);
      }
    }
    new MutationObserver(() => {
      if (overlay.classList.contains('open')) {
        if (!modalReturnFocus.has(overlay)) modalReturnFocus.set(overlay, document.activeElement);
        setTimeout(() => {
          if (overlay.contains(document.activeElement)) return;
          const first = Array.from(overlay.querySelectorAll(FOCUSABLE)).find(isShown);
          (first || box)?.focus?.({ preventScroll: true });
        }, 30);
      } else if (modalReturnFocus.has(overlay)) {
        const prev = modalReturnFocus.get(overlay);
        modalReturnFocus.delete(overlay);
        if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    const open = Array.from(document.querySelectorAll('.modal-overlay.open'));
    const top = open[open.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      const closeBtn = top.querySelector('.close-modal-btn');
      if (closeBtn) closeBtn.click(); else top.classList.remove('open');
      e.preventDefault();
      return;
    }
    const items = Array.from(top.querySelectorAll(FOCUSABLE)).filter(isShown);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) {
      last.focus(); e.preventDefault();
    } else if (!e.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) {
      first.focus(); e.preventDefault();
    }
  });
}

/* ---------------------------------------------------------------
   Confirm modal (generic, reused for every destructive/outward action).

   Contract:
   - `body` is HTML: the CALLER must escape every interpolated value with esc().
   - `onConfirm` should THROW on failure. The dialog then stays open and shows
     the error inline (role=alert) so the admin can retry or cancel — it never
     closes/swallows a failure. (A 401 closes it, since login takes over.)
   - `requireText` makes the action button stay disabled until the admin types
     that exact text (e.g. the client's name for a permanent delete).
   --------------------------------------------------------------- */
function showConfirm({ title, body, confirmLabel = 'Confirm', danger = true, onConfirm, requireText = null }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-body').innerHTML = body;

  const errEl = document.getElementById('confirm-modal-error');
  errEl.hidden = true;
  errEl.textContent = '';

  const requireWrap = document.getElementById('confirm-modal-require');
  const requireInput = document.getElementById('confirm-modal-require-input');
  const requireLabel = document.getElementById('confirm-modal-require-label');
  requireInput.value = '';
  requireInput.oninput = null;
  requireInput.onkeydown = null;
  requireWrap.hidden = !requireText;

  // Re-cloned on every open so a previous call's click listener never stacks.
  const oldBtn = document.getElementById('confirm-modal-action-btn');
  const actionBtn = oldBtn.cloneNode(false);
  actionBtn.id = 'confirm-modal-action-btn';
  actionBtn.type = 'button';
  actionBtn.className = danger ? 'btn-danger' : 'btn-primary btn-auto';
  actionBtn.textContent = confirmLabel;
  oldBtn.parentNode.replaceChild(actionBtn, oldBtn);

  const typedOk = () => !requireText || requireInput.value.trim() === requireText;
  if (requireText) {
    requireLabel.textContent = `Type "${requireText}" to confirm`;
    actionBtn.disabled = true;
    requireInput.oninput = () => { actionBtn.disabled = !typedOk(); };
    requireInput.onkeydown = (e) => {
      if (e.key === 'Enter' && typedOk()) { e.preventDefault(); actionBtn.click(); }
    };
  }

  actionBtn.addEventListener('click', async () => {
    if (!typedOk()) return;
    actionBtn.disabled = true;
    errEl.hidden = true;
    try {
      await onConfirm();
      closeConfirm();
    } catch (err) {
      if (err && err.status === 401) { closeConfirm(); return; }
      errEl.textContent = (err && err.message) ? err.message : 'Something went wrong. Please try again.';
      errEl.hidden = false;
      actionBtn.disabled = !typedOk();
    }
  });

  modal.classList.add('open');
  const focusTarget = requireText ? requireInput : modal.querySelector('.modal-actions .btn-secondary');
  if (focusTarget) focusTarget.focus({ preventScroll: true });
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
  // A fresh login (possibly a different admin on a shared browser) must not
  // inherit the previous session's view.
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_e) { /* ignore */ }
  showLoginView();
}

function showLoginView() {
  stopPaymentRemindersPolling();
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-password').value = '';
  setInlineError('login-error', null);
}

function showAppShell() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app-shell').style.display = 'flex';
  renderAdminProfile();
  refreshIcons();
  // Restore from the URL hash (deep link / refresh on #client-detail/<id>,
  // #health/waba, ...) instead of always landing on the dashboard. Empty or
  // unknown hash -> dashboard.
  applyLocationHash('replace');
}

function renderAdminProfile() {
  if (!state.admin) return;
  document.getElementById('admin-name').textContent = state.admin.name;
  document.getElementById('admin-role').textContent = (state.admin.role || '').replace(/_/g, ' ');
  document.getElementById('admin-avatar').textContent = (state.admin.name || '?').trim().charAt(0).toUpperCase();
}

/* ---------------------------------------------------------------
   View router (CSS class toggling, matching the parent CRM's pattern).

   Hash routes:  #dashboard  #statistics[/volume]  #health[/waba|overview|failures]
                 #clients[?status=active]  #client-detail/<id>[?tab=billing]  ...
   Old routes (#health-monitor, #waba-health, #platform-overview, #failures,
   #volume) are aliases that resolve to the merged view + tab, so KPI cards,
   bookmarks and deep links keep working.
   --------------------------------------------------------------- */
const VIEW_TITLES = {
  dashboard: 'Dashboard',
  statistics: 'Statistics',
  health: 'Health',
  clients: 'Clients',
  'client-detail': 'Client Detail',
  onboarding: 'Onboarding',
  billing: 'Billing',
  'payment-reminders': 'Payment Reminders',
  'templates-review': 'Templates Review',
  'api-keys': 'API Keys',
  tickets: 'Tickets',
  team: 'Team',
  'audit-log': 'Audit Log',
  settings: 'Settings',
  'api-guide': 'API Guide',
};

const VIEW_ALIASES = {
  'health-monitor': { view: 'health', tab: 'monitor' },
  'waba-health': { view: 'health', tab: 'waba' },
  'platform-overview': { view: 'health', tab: 'overview' },
  failures: { view: 'health', tab: 'failures' },
  volume: { view: 'statistics', tab: 'volume' },
};

const TAB_VIEWS = {
  health: { def: 'monitor', tabs: ['monitor', 'waba', 'overview', 'failures'] },
  statistics: { def: 'trends', tabs: ['trends', 'volume'] },
};

// KPI-card navigation and the sidebar both call plain switchView(viewName)
// with no extra params — client-detail's id/tab and the clients status filter
// travel via `state` (set by their callers) rather than through switchView's
// signature, so every existing call site keeps working unchanged.
function hashForView(viewName) {
  if (viewName === 'client-detail' && state.currentClientId) {
    const q = state.clientDetailTab && state.clientDetailTab !== 'overview'
      ? `?tab=${encodeURIComponent(state.clientDetailTab)}` : '';
    return `#client-detail/${state.currentClientId}${q}`;
  }
  if (viewName === 'clients' && state.clientsStatusFilter) return `#clients?status=${encodeURIComponent(state.clientsStatusFilter)}`;
  const tv = TAB_VIEWS[viewName];
  if (tv) {
    const t = state.viewTab[viewName];
    return t && t !== tv.def ? `#${viewName}/${t}` : `#${viewName}`;
  }
  return `#${viewName}`;
}

// mode: 'push' (default, user navigation), 'replace' (initial restore, tab
// switches inside a view), 'none' (the URL already is what we're showing).
function writeHash(viewName, mode = 'push') {
  if (mode === 'none') return;
  const hash = hashForView(viewName);
  if (location.hash === hash) return;
  if (mode === 'replace') history.replaceState({ view: viewName }, '', hash);
  else history.pushState({ view: viewName }, '', hash);
}

function switchView(viewName, opts = {}) {
  let tab = opts.tab;
  const alias = VIEW_ALIASES[viewName];
  if (alias) { viewName = alias.view; tab = tab || alias.tab; }
  if (!document.getElementById(`view-${viewName}`)) viewName = 'dashboard';

  const tv = TAB_VIEWS[viewName];
  if (tv) state.viewTab[viewName] = tv.tabs.includes(tab) ? tab : (state.viewTab[viewName] || tv.def);

  document.querySelectorAll('.admin-view').forEach((el) => el.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');

  const navView = viewName === 'client-detail' ? 'clients' : viewName;
  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    const on = el.getAttribute('data-view') === navView;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });

  document.title = `${VIEW_TITLES[viewName] || 'Admin'} · Wasi Admin`;
  writeHash(viewName, opts.history || 'push');
  closeAllRowActionMenus();
  // A dialog opened on the previous page must not linger over the next one
  // (browser Back, KPI-card jumps).
  closeTemplateReviewModal();
  closeConfirm();

  // The payment-reminder audit page polls while open; stop when leaving it.
  if (viewName !== 'payment-reminders') stopPaymentRemindersPolling();

  if (viewName === 'dashboard') loadDashboard();
  else if (viewName === 'payment-reminders') { loadPaymentReminders(); startPaymentRemindersPolling(); }
  else if (viewName === 'statistics') { showTab(document.getElementById('view-statistics'), state.viewTab.statistics); loadStatisticsTab(state.viewTab.statistics); }
  else if (viewName === 'health') { showTab(document.getElementById('view-health'), state.viewTab.health); loadHealthTab(state.viewTab.health); }
  else if (viewName === 'clients') loadClients();
  else if (viewName === 'onboarding') loadOnboarding();
  else if (viewName === 'billing') loadBilling();
  else if (viewName === 'templates-review') loadTemplatesReview();
  else if (viewName === 'api-keys') loadApiKeys();
  else if (viewName === 'tickets') loadTickets();
  else if (viewName === 'team') loadTeam();
  else if (viewName === 'audit-log') loadAuditLog();
  else if (viewName === 'settings') { loadSettings(); loadMetaTemplateLibraryStatus(); }
}

function parseViewHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  if (!raw) return { viewName: 'dashboard' };
  const [pathPart, queryPart] = raw.split('?');
  const [viewName, id] = pathPart.split('/');
  const params = new URLSearchParams(queryPart || '');
  return { viewName, id, status: params.get('status'), tab: params.get('tab') };
}

// Resolves location.hash into a view (and loads it). Shared by the initial
// session restore (so a refresh/deep link on #client-detail/<id> survives) and
// back/forward navigation.
function applyLocationHash(historyMode) {
  const { viewName, id, status, tab } = parseViewHash(location.hash);
  if (viewName === 'client-detail') {
    if (id) {
      openClientDetail(id, { tab: tab || 'overview', history: historyMode });
      return;
    }
    switchView('clients', { history: historyMode });
    return;
  }
  if (viewName === 'clients') state.clientsStatusFilter = status || null;
  const tv = TAB_VIEWS[viewName];
  switchView(viewName || 'dashboard', { history: historyMode, tab: tv ? (id || tv.def) : undefined });
}

// Only meaningful once state.token exists (i.e. after showAppShell has run) —
// a back/forward navigation while still on the login screen has nothing to
// restore into. Also fires for in-page #hash links (API Guide <-> API Keys).
window.addEventListener('popstate', () => {
  if (!state.token) return;
  applyLocationHash('none');
});

// After a nav-driven view change, move keyboard focus to the new page's
// heading so screen-reader/keyboard users land on the content.
function focusViewHeading() {
  const h = document.querySelector('.admin-view.active h1');
  if (!h) return;
  h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------
   Dashboard
   --------------------------------------------------------------- */
async function loadDashboard() {
  setInlineError('dashboard-error', null);
  const grid = document.getElementById('dashboard-stats');
  grid.innerHTML = Array.from({ length: 5 }, () =>
    '<div class="kpi-tile" aria-hidden="true"><span class="skeleton" style="height:28px;width:50%;"></span><span class="skeleton" style="height:14px;width:70%;"></span></div>'
  ).join('');
  document.getElementById('clients-by-status-bars').innerHTML =
    '<span class="skeleton" style="height:14px;width:80%;display:block;margin-bottom:12px;"></span><span class="skeleton" style="height:14px;width:60%;display:block;"></span>';

  try {
    const overview = await apiFetch('/api/admin/overview');
    renderDashboard(overview);
  } catch (err) {
    if (err.status === 401) return;
    grid.innerHTML = '';
    document.getElementById('clients-by-status-bars').innerHTML = '';
    setInlineError('dashboard-error', err.message, loadDashboard);
  }
}

function kpiTileHtml({ icon, label, value, tone, index }) {
  const clickable = index !== undefined;
  return `
    <${clickable ? 'button type="button"' : 'div'} class="kpi-tile${clickable ? ' clickable' : ''}${tone ? ` tone-${esc(tone)}` : ''}"${clickable ? ` data-kpi-index="${index}"` : ''}>
      ${icon ? `<span class="kpi-icon" aria-hidden="true"><i data-lucide="${esc(icon)}"></i></span>` : ''}
      <span class="kpi-value">${esc(value)}</span>
      <span class="kpi-label">${esc(label)}</span>
    </${clickable ? 'button' : 'div'}>`;
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
    { icon: 'alert-triangle', label: 'Failed Onboardings (WABA)', val: failedOnboardings, tone: failedOnboardings > 0 ? 'warning' : undefined, onNavigate: () => switchView('onboarding') },
    { icon: 'send', label: 'Messages Sent Today', val: sent, onNavigate: () => switchView('volume') },
    { icon: 'inbox', label: 'Messages Received Today', val: received, onNavigate: () => switchView('volume') },
  ];

  const grid = document.getElementById('dashboard-stats');
  grid.innerHTML = cards.map((c, i) => kpiTileHtml({ icon: c.icon, label: c.label, value: c.val, tone: c.tone, index: i })).join('');
  grid.querySelectorAll('[data-kpi-index]').forEach((el) => {
    el.addEventListener('click', cards[Number(el.getAttribute('data-kpi-index'))].onNavigate);
  });

  const maxCount = Math.max(1, ...byStatus.map((s) => s.count));
  const barsHtml = byStatus.length
    ? byStatus.map((s) => `
        <div class="status-bar-row">
          <div class="status-bar-label">${statusBadge(s.status)}</div>
          <div class="status-bar-track" role="presentation"><div class="status-bar-fill" style="width:${(s.count / maxCount) * 100}%;"></div></div>
          <div class="status-bar-count">${esc(s.count)}</div>
        </div>
      `).join('')
    : '<div class="empty-state"><i data-lucide="users" class="empty-icon"></i><div class="empty-title">No client data yet</div><div>Clients appear here once they are created.</div></div>';
  document.getElementById('clients-by-status-bars').innerHTML = barsHtml;

  refreshIcons();
}

/* ---------------------------------------------------------------
   Statistics (Trends + Usage & Volume) — read-only trend charts over
   GET /api/admin/stats. Chart.js instances are tracked and destroyed before
   every re-render so repeated visits don't leak canvases/memory.
   --------------------------------------------------------------- */
const statisticsCharts = {};

function destroyStatChart(key) {
  if (statisticsCharts[key]) {
    statisticsCharts[key].destroy();
    delete statisticsCharts[key];
  }
}

function loadStatisticsTab(tab) {
  if (tab === 'volume') loadVolume(); else loadStatistics();
}

function selectStatisticsTab(tab) {
  state.viewTab.statistics = tab;
  showTab(document.getElementById('view-statistics'), tab);
  writeHash('statistics', 'replace');
  loadStatisticsTab(tab);
}

async function loadStatistics() {
  setInlineError('statistics-error', null);
  const loading = document.getElementById('statistics-loading');
  const content = document.getElementById('statistics-content');
  loading.style.display = 'flex';
  content.style.display = 'none';

  const days = document.getElementById('statistics-range-select').value || '30';

  try {
    const stats = await apiFetch(`/api/admin/stats?days=${encodeURIComponent(days)}`);
    content.style.display = '';
    renderStatistics(stats);
  } catch (err) {
    if (err.status === 401) return;
    setInlineError('statistics-error', err.message, loadStatistics);
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
  if (canvas.parentElement) canvas.parentElement.style.display = hasData ? '' : 'none';
  empty.style.display = hasData ? 'none' : 'block';
  if (hasData) statisticsCharts[key] = new Chart(canvas, config);
}

function renderStatistics(stats) {
  // Chart.js loads from a CDN (no bundler in this admin panel, same
  // approach as Lucide) — if that's blocked/offline, skip charts rather
  // than throw; the rest of the page (activity list, filters) still works.
  if (window.Chart) {
    Chart.defaults.font.family = "'Poppins', 'Inter', sans-serif";
    Chart.defaults.color = '#6B7280';
    renderStatisticsCharts(stats);
  }

  // Recently active API keys — each row links into that client's detail
  // page, per the "API usage stats connect to relevant client details"
  // requirement.
  const activity = (stats.apiKeys && stats.apiKeys.recentActivity) || [];
  const listEl = document.getElementById('statistics-api-activity-list');
  listEl.innerHTML = activity.length
    ? activity.map((a) => `
        <div class="detail-row clickable-row" data-client-id="${esc(a.client_id)}">
          <span class="detail-row-label">${esc(a.client_name)} <span class="cell-secondary">(${esc(a.app_name)})</span></span>
          <span class="detail-row-value">${formatDateTime(a.last_used_at)}</span>
        </div>
      `).join('')
    : '<div class="empty-state"><i data-lucide="key" class="empty-icon"></i><div class="empty-title">No API activity</div><div>No API key was used in this range.</div></div>';
  bindClickableRows(listEl, 'data-client-id', (id) => openClientDetail(id));
  refreshIcons();
}

function renderStatisticsCharts(stats) {
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
}

/* ---------------------------------------------------------------
   Usage & Volume (a tab of Statistics; shares its date range)
   --------------------------------------------------------------- */
async function loadVolume() {
  setInlineError('volume-error', null);
  showTableLoading('volume-table-body', 5);

  const days = document.getElementById('statistics-range-select').value || '30';
  try {
    const rows = await apiFetch(`/api/admin/volume?days=${encodeURIComponent(days)}`);
    state.volumeRows = rows;
    resetPage('volume');
    renderVolume();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('volume-table-body', 5, err.message, loadVolume);
  }
}

function renderVolume() {
  const tbody = document.getElementById('volume-table-body');
  const all = state.volumeRows;
  if (!all.length) {
    document.getElementById('volume-pager').hidden = true;
    tbody.innerHTML = emptyRow(5, 'No usage recorded', 'Nothing was sent or received in this date range.', 'bar-chart-3');
    refreshIcons();
    return;
  }
  const rows = pageSlice('volume', all, 25, 'volume-pager', renderVolume);
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Date">${formatDate(r.date)}</td>
      <td data-label="Messages Sent">${esc(r.messages_sent)}</td>
      <td data-label="Messages Received">${esc(r.messages_received)}</td>
      <td data-label="Conversations Billed">${esc(r.conversations_billed)}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Clients list
   --------------------------------------------------------------- */
async function loadClients() {
  setInlineError('clients-error', null);
  showTableLoading('clients-table-body', 6);

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
    showTableError('clients-table-body', 6, err.message, loadClients);
  }
}

// Payment reminder / auto-suspend feature — mirrors
// paymentReminderRunner.js's own WARNING_AFTER_DAYS/SUSPEND_AFTER_DAYS
// (3/5) so the countdown shown here matches what the runner will actually
// do; no endpoint exposes those constants, so this is a by-comment sync,
// not a shared import. Shown in BOTH the list (so a pending suspension is
// visible without opening each client — the explicit requirement this
// feature was built for) and the detail page's billing card below.
const PAYMENT_WARNING_AFTER_DAYS = 3;
const PAYMENT_SUSPEND_AFTER_DAYS = 5;

function billingBadgeHtml(client) {
  if (client.payment_status !== 'unpaid') {
    return badge('Paid', 'success');
  }
  if (!client.payment_marked_unpaid_at) {
    return badge('Unpaid', 'warning');
  }
  const daysUnpaid = (Date.now() - new Date(client.payment_marked_unpaid_at).getTime()) / 86400000;
  const daysLeft = Math.max(0, Math.ceil(PAYMENT_SUSPEND_AFTER_DAYS - daysUnpaid));
  if (client.status === 'suspended' && client.auto_suspended_for_nonpayment) {
    return badge('Auto-suspended', 'danger');
  }
  return badge(`Unpaid — ${daysLeft}d left`, 'danger', `Will auto-suspend in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless marked paid`);
}

function renderClientsTable() {
  const tbody = document.getElementById('clients-table-body');
  const clients = state.clientsFiltered || [];
  document.getElementById('clients-count-label').textContent = `${clients.length} client${clients.length === 1 ? '' : 's'}`;

  if (!clients.length) {
    document.getElementById('clients-pager').hidden = true;
    const filtering = !!(state.clients.length && (document.getElementById('clients-search').value.trim() || document.getElementById('clients-status-filter').value));
    tbody.innerHTML = filtering
      ? stateRow(6, `<div class="empty-state"><i data-lucide="search-x" class="empty-icon"></i><div class="empty-title">No clients match</div><div>Try a different search or clear the filters.</div><button type="button" class="btn-secondary" id="clients-clear-filters">Clear filters</button></div>`)
      : emptyRow(6, 'No clients yet', 'Add your first client to get started.', 'users');
    document.getElementById('clients-clear-filters')?.addEventListener('click', () => {
      document.getElementById('clients-search').value = '';
      document.getElementById('clients-status-filter').value = '';
      resetPage('clients');
      filterClientsTable();
    });
    refreshIcons();
    return;
  }

  const rows = pageSlice('clients', clients, 25, 'clients-pager', renderClientsTable);
  tbody.innerHTML = rows.map((c) => `
    <tr data-client-id="${esc(c.id)}">
      <td data-label="Name">${esc(c.name)}</td>
      <td data-label="Email">${esc(c.email)}</td>
      <td data-label="Status">${statusBadge(c.status)}</td>
      <td data-label="Billing">${billingBadgeHtml(c)}</td>
      <td data-label="Tenant Slug">${esc(c.tenant_slug)}</td>
      <td data-label="Created">${formatDate(c.created_at)}</td>
    </tr>
  `).join('');

  bindClickableRows(tbody, 'data-client-id', (id) => openClientDetail(id));
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
  state.clientsFiltered = filtered;
  renderClientsTable();
}

/* ---------------------------------------------------------------
   Copy-once secrets panel (new client credentials, new API key).
   The close button / Escape / backdrop all route through guardAllowsClose,
   so the admin can't dismiss credentials that are never shown again before
   confirming they copied them.
   --------------------------------------------------------------- */
const pendingSecrets = {};
let secretSeq = 0;

function guardAllowsClose(key) {
  if (!pendingSecrets[key]) return true;
  const ack = document.getElementById(`${key}-ack`);
  if (ack && ack.checked) return true;
  document.getElementById(`${key}-ack-row`)?.classList.add('attention');
  showToast("Copy these credentials first — they won't be shown again. Tick the box once you have.", 'error');
  ack?.focus();
  return false;
}

// Rows are [label, value]. Values are copied from the on-screen element
// (data-copy-value-target), never duplicated into a DOM attribute.
function secretRowsHtml(rows) {
  return `<div class="secret-list">${rows.map(([label, value]) => {
    const id = `secret-val-${++secretSeq}`;
    return `
      <div class="secret-row">
        <span class="secret-row-label">${esc(label)}</span>
        <span class="secret-row-value" id="${id}">${esc(value)}</span>
        <button type="button" class="btn-secondary btn-sm copy-btn-mini" data-copy-value-target="${id}" aria-label="Copy ${esc(label)}"><i data-lucide="copy" class="icon-14"></i> Copy</button>
      </div>`;
  }).join('')}</div>`;
}

function secretsAckHtml(key, doneLabel = 'Done') {
  return `
    <label class="ack-row" id="${key}-ack-row"><input type="checkbox" id="${key}-ack" /> I've copied these and stored them somewhere safe</label>
    <button type="button" class="btn-primary btn-auto" id="${key}-done-btn" disabled>${esc(doneLabel)}</button>`;
}

function bindSecretsAck(key, closeFn) {
  pendingSecrets[key] = true;
  const ack = document.getElementById(`${key}-ack`);
  const done = document.getElementById(`${key}-done-btn`);
  ack.addEventListener('change', () => {
    done.disabled = !ack.checked;
    if (ack.checked) document.getElementById(`${key}-ack-row`).classList.remove('attention');
  });
  done.addEventListener('click', () => closeFn());
}

/* ---------------------------------------------------------------
   Create Client
   --------------------------------------------------------------- */
function openCreateClientModal() {
  pendingSecrets['create-client'] = false;
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
  if (!guardAllowsClose('create-client')) return;
  pendingSecrets['create-client'] = false;
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
      <div class="inline-success">Client created — this password and API key are shown once. Copy each one now.</div>
      ${secretRowsHtml([
        ['Login URL', created.loginUrl],
        ['Email', created.email],
        ['Password', created.temporaryPassword],
        ['Hub API Key', created.apiKey],
      ])}
      <div class="next-steps">
        <strong>Next steps:</strong>
        <ol>
          <li>Send them the login URL, email, and password above.</li>
          <li>They log in and connect WhatsApp (Embedded Signup) themselves.</li>
          <li>Any existing approved templates on their WABA sync in automatically once connected.</li>
          <li>Hand the Hub API Key to their CRM/developer to call <code>POST /api/v1/messages</code> and <code>/api/v1/templates</code> (Authorization: Bearer). If lost, issue a new one from the API Keys page — this one still works until revoked.</li>
        </ol>
      </div>
      ${secretsAckHtml('create-client')}
    `;
    refreshIcons();
    bindSecretsAck('create-client', closeCreateClientModal);
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
   Client Detail — tabbed: Overview | Billing & Service | WhatsApp |
   Templates | Activity. The active tab lives in state.clientDetailTab (and the
   URL's ?tab=), so a refresh or a re-render after an action keeps your place.
   --------------------------------------------------------------- */
const CLIENT_DETAIL_TABS = ['overview', 'billing', 'whatsapp', 'templates', 'activity'];

function openClientDetail(clientId, opts = {}) {
  state.currentClientId = clientId;
  state.clientDetailTab = CLIENT_DETAIL_TABS.includes(opts.tab) ? opts.tab : 'overview';
  switchView('client-detail', { history: opts.history });
  loadClientDetail(clientId);
}

// quiet = re-fetch after an action: keep the current content on screen (no
// skeleton flash, no scroll jump) and swap it in when the data arrives.
async function loadClientDetail(clientId, { quiet = false } = {}) {
  const errEl = document.getElementById('client-detail-error');
  const content = document.getElementById('client-detail-content');
  const loading = document.getElementById('client-detail-loading');
  errEl.style.display = 'none';
  errEl.innerHTML = '';
  if (!quiet) {
    content.innerHTML = '';
    loading.style.display = 'flex';
  }

  try {
    const detail = await apiFetch(`/api/admin/clients/${clientId}`);
    if (state.currentClientId !== clientId) return; // navigated away mid-request
    state.currentClientDetail = detail;
    renderClientDetail(detail);
  } catch (err) {
    if (err.status === 401) return;
    if (quiet) {
      showToast('Could not refresh this client: ' + err.message, 'error');
      return;
    }
    errEl.style.display = 'block';
    errEl.innerHTML = `
      <div>${esc(err.message)}</div>
      <div class="row-actions-inline" style="justify-content:center; margin-top:0.75rem;">
        <button type="button" class="btn-secondary" id="client-detail-retry-btn">Try again</button>
        <button type="button" class="btn-ghost" id="client-detail-back-btn">Back to clients</button>
      </div>`;
    document.getElementById('client-detail-retry-btn').addEventListener('click', () => loadClientDetail(clientId));
    document.getElementById('client-detail-back-btn').addEventListener('click', () => switchView('clients'));
  } finally {
    loading.style.display = 'none';
  }
}

function selectClientDetailTab(tab) {
  state.clientDetailTab = CLIENT_DETAIL_TABS.includes(tab) ? tab : 'overview';
  showTab(document.getElementById('client-detail-content'), state.clientDetailTab);
  writeHash('client-detail', 'replace');
}

const CLIENT_STATUS_OPTIONS = ['pending_setup', 'payment_confirmed', 'active', 'suspended'];

// Mirrors server/src/utils/webhookEvents.js's WEBHOOK_EVENT_TYPES — no
// endpoint exposes this list, so it's kept in sync by hand; the server's
// zod schema is the actual source of truth and will reject anything else.
const HUB_FORWARD_EVENTS = ['message.received', 'message.status', 'message_template_status_update', 'account_update'];

// PLAN.md item 25, Part A — renders the needs_manual_resolution state with
// a REAL picker, not just a status badge. Two sub-states share this one
// function since they're the same underlying problem (Meta returned more
// than one of something, discovery can't guess which) at two different
// points in the chain: connect_diagnostics.reason distinguishes them.
function renderWabaResolutionHtml(waba) {
  const diag = waba.connect_diagnostics || {};
  if (diag.reason === 'multiple_wabas') {
    const options = (diag.wabaTargetIds || [])
      .map((id) => `<option value="${esc(id)}">${esc(id)}</option>`)
      .join('');
    return `
      <div class="alert alert-warning">
        <span><strong>This Meta Business account has more than one WhatsApp Business Account.</strong> Server-side discovery couldn't tell which one the client meant to connect — pick one below.</span>
      </div>
      <label class="sr-only" for="resolve-waba-select">WhatsApp Business Account</label>
      <select id="resolve-waba-select" class="form-input">
        <option value="">Select a WhatsApp Business Account…</option>
        ${options}
      </select>
      <div id="resolve-waba-result"></div>
      <button class="btn-primary btn-block-center" id="resolve-waba-btn" disabled>
        <i data-lucide="check" class="icon-14"></i> Look Up Phone Numbers
      </button>
    `;
  }
  if (diag.reason === 'multiple_phone_numbers') {
    const options = (diag.candidatePhoneNumbers || [])
      .map((p) => `<option value="${esc(p.id)}">${esc(p.display_phone_number || p.id)}</option>`)
      .join('');
    return `
      <div class="alert alert-warning">
        <span><strong>WhatsApp Business Account ${esc(diag.wabaId || waba.waba_id || 'unknown')} has more than one phone number.</strong> Pick which one the client meant to connect.</span>
      </div>
      <label class="sr-only" for="resolve-phone-select">Phone number</label>
      <select id="resolve-phone-select" class="form-input">
        <option value="">Select a phone number…</option>
        ${options}
      </select>
      <div id="resolve-waba-result"></div>
      <button class="btn-primary btn-block-center" id="resolve-waba-btn" data-waba-id="${esc(diag.wabaId || waba.waba_id || '')}" disabled>
        <i data-lucide="check" class="icon-14"></i> Connect This Number
      </button>
    `;
  }
  // Fallback — should never happen (these two reasons are the only ones
  // this app produces), but don't render a broken/blank panel if it does.
  return `<div class="empty-state">This WhatsApp connection needs manual resolution, but the specific reason wasn't recorded. Check connect_diagnostics directly: <code>${esc(JSON.stringify(diag))}</code></div>`;
}

function detailRow(label, valueHtml, labelIsHtml = false) {
  return `<div class="detail-row"><span class="detail-row-label">${labelIsHtml ? label : esc(label)}</span><span class="detail-row-value">${valueHtml}</span></div>`;
}

function clientDetailAttention(client, waba) {
  const billing = (client.payment_status === 'unpaid')
    || (client.status === 'suspended' && client.auto_suspended_for_nonpayment);
  const whatsapp = !!waba && (waba.status === 'needs_manual_resolution' || waba.status === 'incomplete_meta_linked' || waba.sendable === false);
  return { billing, whatsapp };
}

function renderClientDetail(detail, { revealedForwardSecret = null } = {}) {
  const { client, subscription, waba, templates, auditTrail } = detail;
  const flags = clientDetailAttention(client, waba);

  const statusOptionsHtml = CLIENT_STATUS_OPTIONS.map((s) =>
    `<option value="${esc(s)}" ${s === client.status ? 'selected' : ''}>${esc(s.replace(/_/g, ' '))}</option>`
  ).join('');

  // Payment reminder / auto-suspend feature. "Service" maps directly onto
  // status active<->suspended — there's no separate boolean for it, this is
  // just a clearer binary control for the one common transition, alongside
  // (not replacing) the full status dropdown for the onboarding-only
  // states. Disabled while the client hasn't reached 'active' yet at all,
  // since "off" would be meaningless (there's no service running yet to
  // turn off) — the status dropdown is still how a pending_setup/
  // payment_confirmed client gets activated the first time.
  const serviceTogglable = client.status === 'active' || client.status === 'suspended';
  const serviceOn = client.status === 'active';

  const daysUnpaid = client.payment_marked_unpaid_at
    ? (Date.now() - new Date(client.payment_marked_unpaid_at).getTime()) / 86400000
    : 0;
  const daysLeft = Math.max(0, Math.ceil(PAYMENT_SUSPEND_AFTER_DAYS - daysUnpaid));
  const suspendByDate = client.payment_marked_unpaid_at
    ? formatDate(new Date(new Date(client.payment_marked_unpaid_at).getTime() + PAYMENT_SUSPEND_AFTER_DAYS * 86400000).toISOString())
    : null;

  const pendingSuspensionBannerHtml = (client.payment_status === 'unpaid' && client.payment_marked_unpaid_at && client.status !== 'suspended')
    ? `
      <div class="alert alert-danger">
        <span><strong>Unpaid since ${formatDate(client.payment_marked_unpaid_at)}.</strong>
        ${client.payment_warning_sent_at ? `Suspension warning sent ${formatDate(client.payment_warning_sent_at)}.` : `Warning not sent yet (fires ${PAYMENT_WARNING_AFTER_DAYS} days after marked unpaid).`}
        Will auto-suspend Service on <strong>${suspendByDate}</strong> (${daysLeft} day${daysLeft === 1 ? '' : 's'} left) unless marked paid.</span>
      </div>
    `
    : (client.status === 'suspended' && client.auto_suspended_for_nonpayment)
    ? `
      <div class="alert alert-danger">
        <span><strong>Auto-suspended for nonpayment</strong> — mark this client Paid to restore Service automatically.</span>
      </div>
    `
    : '';

  const serviceBillingCardHtml = `
    <div class="detail-card">
      <h2 class="detail-card-title">Service &amp; Payment</h2>
      ${pendingSuspensionBannerHtml}
      <div class="detail-row">
        <span class="detail-row-label">Service</span>
        <span class="detail-row-value">
          <label class="wasi-toggle wasi-toggle-danger" title="${serviceTogglable ? '' : 'Activate this client via the status editor first'}">
            <input type="checkbox" id="service-toggle" aria-label="Service on or off" ${serviceOn ? 'checked' : ''} ${serviceTogglable ? '' : 'disabled'}>
            <span class="wasi-toggle-label">${serviceOn ? 'On' : 'Off'}</span>
          </label>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-row-label">Payment</span>
        <span class="detail-row-value">
          <label class="wasi-toggle">
            <input type="checkbox" id="payment-toggle" aria-label="Payment paid or unpaid" ${client.payment_status === 'paid' ? 'checked' : ''}>
            <span class="wasi-toggle-label">${client.payment_status === 'paid' ? 'Paid' : 'Unpaid'}</span>
          </label>
        </span>
      </div>
      <div id="service-billing-result"></div>
      ${detailRow('Activated', client.activated_at ? formatDate(client.activated_at) : '—')}
      ${detailRow('Last Reminder Sent', client.last_reminder_sent_on ? formatDate(client.last_reminder_sent_on) : 'Never')}
    </div>
  `;

  const subscriptionHtml = subscription
    ? `
      ${detailRow('Plan', esc(subscription.plan || '—'))}
      ${detailRow('Status', statusBadge(subscription.status))}
      ${detailRow('Renews At', formatDate(subscription.renews_at))}
    `
    : `<div class="empty-state"><i data-lucide="credit-card" class="empty-icon"></i><div class="empty-title">No subscription</div><div>No subscription on record for this client.</div></div>`;

  // PLAN.md item 25 — two states distinct from both "connected" and "no
  // WABA at all," each needing its own visible treatment, not lumped into
  // the generic empty-state. A recorded ambiguity nobody in the admin UI
  // can see is the same invisible-failure pattern already hit 4 times.
  const notCheckedYet = '<span class="cell-secondary">Not checked yet</span>';
  const retryBlock = `
    <div id="retry-provisioning-result"></div>
    <button class="btn-secondary btn-sm btn-block-center" id="retry-provisioning-btn">
      <i data-lucide="refresh-cw" class="icon-14"></i> Retry Provisioning
    </button>`;

  let wabaCardsHtml;
  if (waba?.status === 'incomplete_meta_linked') {
    wabaCardsHtml = `
      <div class="detail-card">
        <h2 class="detail-card-title">WhatsApp Business Account</h2>
        <div class="alert alert-warning">
          <span><strong>Meta linked this account, but the authorization code never reached us.</strong><br>
          WABA ID on file: <code>${esc(waba.waba_id || 'unknown')}</code>. There is nothing to retry from admin — the client needs to reconnect via Settings &gt; WhatsApp in the CRM. If it keeps happening for the same client, that's worth escalating.</span>
        </div>
      </div>`;
  } else if (waba?.status === 'needs_manual_resolution') {
    wabaCardsHtml = `
      <div class="detail-card">
        <h2 class="detail-card-title">WhatsApp Business Account</h2>
        ${renderWabaResolutionHtml(waba)}
      </div>`;
  } else if (waba) {
    const sendableHtml = waba.sendable === true
      ? badge('Yes', 'success')
      : waba.sendable === false
        ? badge('No', 'danger', waba.sendable_reason || '')
        : waba.sendable_checked_at
          ? badge('Unknown', 'warning', waba.sendable_reason || '')
          : notCheckedYet;
    const probeHtml = waba.probe_sendable === true
      ? badge('Yes', 'success')
      : waba.probe_sendable === false
        ? badge(`No${waba.probe_error_code ? ` (#${waba.probe_error_code})` : ''}`, 'danger', waba.probe_reason || '')
        : waba.probe_checked_at
          ? badge(`Unknown${waba.probe_error_code ? ` (#${waba.probe_error_code})` : ''}`, 'warning', waba.probe_reason || '')
          : notCheckedYet;

    wabaCardsHtml = `
      <div class="detail-card">
        <h2 class="detail-card-title">WhatsApp Business Account</h2>
        ${detailRow('WABA ID', esc(waba.waba_id || '—'))}
        ${detailRow('Phone Number ID', esc(waba.phone_number_id || '—'))}
        ${detailRow('Display Name', esc(waba.display_name || '—'))}
        ${detailRow('Quality Rating', esc(waba.quality_rating || '—'))}
        ${detailRow('Status', statusBadge(waba.status))}
        ${detailRow('Messaging Tier', waba.messaging_tier ? badge(titleCase(String(waba.messaging_tier).toLowerCase()), 'neutral') : notCheckedYet)}
        ${waba.messaging_tier_checked_at ? detailRow('Tier Checked', formatDate(waba.messaging_tier_checked_at)) : ''}
        ${detailRow('Verified At', formatDate(waba.verified_at))}
        ${retryBlock}
        <div id="refresh-messaging-tier-result"></div>
        <button class="btn-secondary btn-sm btn-block-center" id="refresh-messaging-tier-btn">
          <i data-lucide="gauge" class="icon-14"></i> Refresh Messaging Tier
        </button>
      </div>

      <div class="detail-card">
        <h2 class="detail-card-title">Sendability Monitoring</h2>
        ${clientSendabilityBannerHtml(waba)}
        ${detailRow('Sendable', sendableHtml)}
        ${waba.sendable !== true && waba.sendable_reason ? `<div class="inline-warning">${esc(waba.sendable_reason)}</div>` : ''}
        ${waba.sendable_checked_at ? detailRow('Sendable Checked', formatDate(waba.sendable_checked_at)) : ''}
        ${detailRow('Probe (permission only)', probeHtml)}
        <div class="detail-sub-note">Probe tests Meta permission only — a payment/billing block (health_status BLOCKED) can still stop sending even when the probe passes. "Sendable" above is the combined, trustworthy answer.</div>
        ${detailRow('Registration', registrationBadgeHtml(waba))}
        ${waba.registration_checked_at ? `
          ${detailRow('On Business App', waba.registration_is_on_biz_app === null ? '—' : (waba.registration_is_on_biz_app ? 'Yes' : 'No'))}
          ${detailRow('Code Verification', esc(waba.registration_code_verification_status || '—'))}
          ${detailRow('Platform Type', esc(waba.registration_platform_type || '—'))}
          ${detailRow('Registration Checked', formatDate(waba.registration_checked_at))}
        ` : ''}
        ${detailRow('Health Status', healthStatusSummaryHtml(waba))}
        <div id="check-sendability-result"></div>
        <button class="btn-secondary btn-sm btn-block-center" id="check-sendability-btn">
          <i data-lucide="heart-pulse" class="icon-14"></i> Check Sendability Now
        </button>
      </div>

      <div class="detail-card">
        <h2 class="detail-card-title">CRM Inbound Forwarding</h2>
        <div class="detail-sub-note">
          Pushes inbound WhatsApp replies and template/account status changes to the client's own CRM webhook. Ask the client for their CRM's webhook URL before filling this in.
        </div>
        ${waba.has_forward_secret ? `
        <div class="detail-row detail-row-secret">
          <span class="detail-row-label">Webhook Secret</span>
          <span class="detail-row-value detail-row-inline">
            <span class="cell-mono">•••••••• ${esc((revealedForwardSecret || waba.forward_secret_last4 || '????').slice(-4))}</span>
            ${revealedForwardSecret ? `<button type="button" class="btn-secondary btn-sm copy-btn-mini" id="copy-forward-secret-btn" title="Copy secret" aria-label="Copy webhook secret"><i data-lucide="copy" class="icon-14"></i></button>` : ''}
            <button type="button" class="btn-secondary btn-sm copy-btn-mini" id="regenerate-forward-secret-btn" title="Regenerate secret" aria-label="Regenerate webhook secret"><i data-lucide="refresh-cw" class="icon-14"></i></button>
          </span>
        </div>
        ${revealedForwardSecret ? `<div class="inline-success">New secret generated — copy it now, it won't be shown again.</div>` : `<div class="detail-sub-note">Only the last 4 characters are ever shown again after generation. Regenerate to get a fresh copyable secret.</div>`}
        ` : ''}
        <label class="sr-only" for="hub-forward-url">Webhook URL</label>
        <input type="url" id="hub-forward-url" class="form-input" placeholder="https://client-crm.example.com/webhooks/wasi" value="${esc(waba.forward_to_url || '')}">
        <fieldset class="hub-event-list" style="border:none; padding:0;">
          <legend class="sr-only">Events to forward</legend>
          ${HUB_FORWARD_EVENTS.map((ev) => `
            <label class="hub-event-label">
              <input type="checkbox" data-hub-event value="${esc(ev)}" ${(waba.forward_events || []).includes(ev) ? 'checked' : ''}>
              <span>${esc(ev)}</span>
            </label>
          `).join('')}
        </fieldset>
        <div id="hub-forward-result"></div>
        <button class="btn-secondary btn-sm btn-block-center" id="hub-forward-save-btn">Save Forwarding Config</button>
      </div>
    `;
  } else {
    wabaCardsHtml = `
      <div class="detail-card">
        <h2 class="detail-card-title">WhatsApp Business Account</h2>
        <div class="empty-state"><i data-lucide="message-circle" class="empty-icon"></i><div class="empty-title">Not connected</div><div>No WhatsApp Business Account connected yet.</div></div>
        ${retryBlock}
      </div>`;
  }

  const templatesHtml = (templates && templates.length)
    ? templates.map((t) => `
        <div class="template-mini-card">
          <div class="template-mini-header">
            <span class="template-mini-name">${esc(t.name)}</span>
            ${statusBadge(t.status)}
          </div>
          <div class="template-mini-category">${esc(t.category || '—')}</div>
          <div class="template-mini-body">${esc(t.body || '')}</div>
        </div>
      `).join('')
    : `<div class="empty-state"><i data-lucide="file-text" class="empty-icon"></i><div class="empty-title">No templates</div><div>No templates submitted yet.</div></div>`;

  const auditHtml = (auditTrail && auditTrail.length)
    ? auditTrail.map((a) => `
        <div class="audit-item">
          <div class="audit-actor-icon"><i data-lucide="${a.actor_type === 'admin' ? 'shield' : 'user'}" class="icon-14"></i></div>
          <div class="audit-item-body">
            <div class="audit-item-action">${esc(a.action)} <span class="cell-secondary">by ${esc(a.actor_type)}</span></div>
            <div class="audit-item-target">${esc(a.target || '')}</div>
            <div class="audit-item-time">${formatDateTime(a.created_at)}</div>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state"><i data-lucide="scroll-text" class="empty-icon"></i><div class="empty-title">No activity yet</div><div>No audit trail entries for this client yet.</div></div>`;

  const tabDefs = [
    ['overview', 'Overview', ''],
    ['billing', 'Billing & Service', flags.billing ? ' <span class="tab-flag" title="Needs attention" aria-label="Needs attention">!</span>' : ''],
    ['whatsapp', 'WhatsApp', flags.whatsapp ? ' <span class="tab-flag" title="Needs attention" aria-label="Needs attention">!</span>' : ''],
    ['templates', `Templates (${(templates || []).length})`, ''],
    ['activity', 'Activity', ''],
  ];
  const activeTab = CLIENT_DETAIL_TABS.includes(state.clientDetailTab) ? state.clientDetailTab : 'overview';

  const prevFocusId = document.activeElement && document.activeElement.id;
  const root = document.getElementById('client-detail-content');
  root.innerHTML = `
    <div class="client-header">
      <div class="page-header-text">
        <h1 class="page-title">${esc(client.name)} <span class="client-header-badges">${statusBadge(client.status)} ${billingBadgeHtml(client)}</span></h1>
        <p class="page-subtitle">${esc(client.email)}</p>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="Client sections" data-tabs="client">
      ${tabDefs.map(([id, label, flag]) => `<button class="tab" role="tab" type="button" id="tab-client-${id}" aria-controls="panel-client-${id}" aria-selected="${id === activeTab}" tabindex="${id === activeTab ? 0 : -1}" data-tab="${id}">${label.replace(/&/g, '&amp;')}${flag}</button>`).join('')}
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-client-overview" aria-labelledby="tab-client-overview" data-panel="overview">
      <div class="detail-grid">
        <div class="detail-card">
          <h2 class="detail-card-title">Client Profile</h2>
          ${detailRow('Name', esc(client.name))}
          <div class="detail-row">
            <span class="detail-row-label">Client ID</span>
            <span class="detail-row-value detail-row-inline">
              <span class="cell-mono cell-break" id="client-id-value">${esc(client.id)}</span>
              <button type="button" class="btn-secondary btn-sm copy-btn-mini" data-copy-value-target="client-id-value" aria-label="Copy client ID"><i data-lucide="copy" class="icon-14"></i></button>
            </span>
          </div>
          ${detailRow('Email', esc(client.email))}
          ${detailRow('Tenant Slug', esc(client.tenant_slug))}
          ${detailRow('Created', formatDate(client.created_at))}
          ${detailRow('Current Status', statusBadge(client.status))}
          <div class="status-editor-row">
            <label class="sr-only" for="status-editor-select">Change status</label>
            <select id="status-editor-select">${statusOptionsHtml}</select>
            <button class="btn-primary btn-sm btn-auto" id="status-editor-save-btn">Save</button>
          </div>
          <div id="status-editor-result"></div>
          <div class="detail-sub">
            <button class="btn-secondary btn-sm btn-block-center" id="reset-client-password-btn" style="margin-top:0;">
              <i data-lucide="key-round" class="icon-14"></i> Reset Password
            </button>
            <div id="reset-client-password-result"></div>
          </div>
        </div>
        <div class="detail-card detail-card-full danger-zone">
          <div class="danger-zone-title">Danger zone</div>
          <p>Permanently deleting <strong>${esc(client.name)}</strong> removes every tenant row for this client — contacts, chats, messages, everything. This cannot be undone. You will be asked to type the client's name to confirm.</p>
          <button class="btn-danger" id="delete-client-btn"><i data-lucide="trash-2" class="icon-14"></i> Delete client…</button>
        </div>
      </div>
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-client-billing" aria-labelledby="tab-client-billing" data-panel="billing" hidden>
      <div class="detail-grid">
        ${serviceBillingCardHtml}
        <div class="detail-card">
          <h2 class="detail-card-title">Subscription</h2>
          ${subscriptionHtml}
        </div>
      </div>
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-client-whatsapp" aria-labelledby="tab-client-whatsapp" data-panel="whatsapp" hidden>
      <div class="detail-grid">
        ${wabaCardsHtml}
      </div>
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-client-templates" aria-labelledby="tab-client-templates" data-panel="templates" hidden>
      <div class="detail-card">
        <h2 class="detail-card-title">Message Templates <span class="detail-card-aside">(${(templates || []).length})</span></h2>
        ${templatesHtml}
      </div>
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-client-activity" aria-labelledby="tab-client-activity" data-panel="activity" hidden>
      <div class="detail-card">
        <h2 class="detail-card-title">Audit Trail</h2>
        ${auditHtml}
      </div>
    </div>
  `;

  refreshIcons();
  initTablist(root.querySelector('[role="tablist"]'), selectClientDetailTab);
  showTab(root, activeTab);
  if (prevFocusId) document.getElementById(prevFocusId)?.focus({ preventScroll: true });

  document.getElementById('status-editor-save-btn').addEventListener('click', () => saveClientStatus(client.id));
  document.getElementById('service-toggle')?.addEventListener('change', (e) => toggleClientService(client, e.target));
  document.getElementById('payment-toggle')?.addEventListener('change', (e) => toggleClientPayment(client, e.target));
  // Not rendered for the two needs_manual_resolution/incomplete_meta_linked
  // states (see renderWabaResolutionHtml/wabaCardsHtml above) — optional-chained
  // rather than assumed present, unlike the other buttons on this page.
  document.getElementById('retry-provisioning-btn')?.addEventListener('click', () => retryProvisioning(client.id));
  document.getElementById('refresh-messaging-tier-btn')?.addEventListener('click', () => refreshMessagingTier(client.id));
  document.getElementById('check-sendability-btn')?.addEventListener('click', () => checkSendability(client.id));
  document.getElementById('delete-client-btn').addEventListener('click', () => confirmDeleteClient(client));
  document.getElementById('reset-client-password-btn').addEventListener('click', () => confirmResetClientPassword(client));
  const hubForwardBtn = document.getElementById('hub-forward-save-btn');
  if (hubForwardBtn) hubForwardBtn.addEventListener('click', () => saveHubForward(client.id));

  // PLAN.md item 25, Part A — the resolve-waba picker. Whichever select is
  // present (WABA or phone number, never both at once — see
  // renderWabaResolutionHtml) enables the button once something is chosen;
  // the button starts disabled so a resolve can't fire against an empty
  // selection.
  const resolveWabaBtn = document.getElementById('resolve-waba-btn');
  if (resolveWabaBtn) {
    const resolveSelect = document.getElementById('resolve-waba-select') || document.getElementById('resolve-phone-select');
    resolveSelect?.addEventListener('change', () => {
      resolveWabaBtn.disabled = !resolveSelect.value;
    });
    resolveWabaBtn.addEventListener('click', () => resolveWaba(client.id));
  }

  const copyForwardSecretBtn = document.getElementById('copy-forward-secret-btn');
  if (copyForwardSecretBtn && revealedForwardSecret) {
    // Copied from the closure, never from a DOM attribute (see the
    // revealedForwardSecret note on renderClientDetail's callers).
    copyForwardSecretBtn.addEventListener('click', () => copyText(revealedForwardSecret));
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
      const updated = await apiFetch(`/api/admin/clients/${clientId}/hub-forward/regenerate-secret`, { method: 'POST' });
      state.currentClientDetail = { ...state.currentClientDetail, waba: updated };
      showToast('Webhook secret regenerated.', 'success');
      // revealedForwardSecret is only ever held in this closure for the one
      // render immediately after a generate/regenerate response — never
      // written into a DOM attribute, and gone on the next plain GET.
      renderClientDetail(state.currentClientDetail, { revealedForwardSecret: updated.forward_secret });
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
    resultEl.innerHTML = `<div class="inline-error" role="alert">A webhook URL and at least one event are required.</div>`;
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
    resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(err.message)}</div>`;
    showToast('Failed to save forwarding config: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Turning Service OFF suspends a live account — the whole reason this
// feature added a visible warning+countdown for the AUTOMATIC path is that
// a silent suspension is unacceptable; the same applies to a mis-click on
// this manual toggle, so turning it off gets a real confirm step. Turning
// it back on is purely restorative and doesn't need one.
function toggleClientService(client, checkboxEl) {
  const turningOn = checkboxEl.checked;
  const resultEl = document.getElementById('service-billing-result');

  const apply = async () => {
    resultEl.innerHTML = '';
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: turningOn ? 'active' : 'suspended' }),
    });
    showToast(`Service turned ${turningOn ? 'on' : 'off'} for ${client.name}.`, 'success');
    loadClientDetail(client.id, { quiet: true });
  };

  if (turningOn) {
    apply().catch((err) => {
      if (err.status === 401) return;
      checkboxEl.checked = !turningOn; // revert the toggle's visual state on failure
      resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(err.message)}</div>`;
      showToast('Failed to update Service: ' + err.message, 'error');
    });
    return;
  }
  checkboxEl.checked = true; // hold the visual state until confirmed
  showConfirm({
    title: 'Turn Service off?',
    body: `<p>This suspends <strong>${esc(client.name)}</strong>'s account. They will not be able to use Wasi until Service is turned back on.</p>`,
    confirmLabel: 'Turn Off',
    danger: true,
    onConfirm: async () => {
      await apply(); // throws on failure -> dialog stays open with the error
      checkboxEl.checked = false;
    },
  });
}

function toggleClientPayment(client, checkboxEl) {
  const paid = checkboxEl.checked;
  const resultEl = document.getElementById('service-billing-result');
  resultEl.innerHTML = '';

  apiFetch(`/api/clients/${client.id}/payment-status`, {
    method: 'POST',
    body: JSON.stringify({ paid }),
  }).then(() => {
    showToast(`${client.name} marked ${paid ? 'Paid' : 'Unpaid'}.`, 'success');
    loadClientDetail(client.id, { quiet: true });
  }).catch((err) => {
    if (err.status === 401) return;
    checkboxEl.checked = !paid;
    resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(err.message)}</div>`;
    showToast('Failed to update payment status: ' + err.message, 'error');
  });
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
    // Refresh the whole detail view so subscription/waba/audit reflect the change.
    loadClientDetail(clientId, { quiet: true });
  } catch (err) {
    if (err.status === 401) return;
    resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(err.message)}</div>`;
    showToast('Failed to update status: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

// PLAN.md item 25, Part A — completes a needs_manual_resolution WABA using
// admin's picked candidate(s). A 409 with the "still ambiguous" shape (the
// multiple_wabas -> multiple_phone_numbers second round-trip) means the
// backend already persisted the next step's diagnostics — reload picks up
// renderWabaResolutionHtml's phone-number picker automatically, no manual
// DOM patching needed.
async function resolveWaba(clientId) {
  const btn = document.getElementById('resolve-waba-btn');
  const resultEl = document.getElementById('resolve-waba-result');
  const wabaSelect = document.getElementById('resolve-waba-select');
  const phoneSelect = document.getElementById('resolve-phone-select');
  // multiple_wabas state: wabaId comes from the picker itself. Already past
  // that (multiple_phone_numbers state, only a phone picker is rendered):
  // wabaId was already resolved server-side and threaded onto the button's
  // own data attribute by renderWabaResolutionHtml, not re-picked here.
  const wabaId = wabaSelect ? wabaSelect.value : btn.getAttribute('data-waba-id');
  const phoneNumberId = phoneSelect ? phoneSelect.value : undefined;
  if (!wabaId) return;

  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="icon-14 spin"></i> Resolving…';
  refreshIcons();

  try {
    const body = phoneNumberId ? { wabaId, phoneNumberId } : { wabaId };
    await apiFetch(`/api/admin/clients/${clientId}/resolve-waba`, { method: 'POST', body: JSON.stringify(body) });
    showToast('WhatsApp connection resolved.', 'success');
    loadClientDetail(clientId, { quiet: true });
  } catch (err) {
    if (err.status === 401) return;
    if (err.status === 409) {
      // Still ambiguous, one level deeper (WABA picked, phone numbers under
      // it are ambiguous too) — the backend already saved that state.
      loadClientDetail(clientId, { quiet: true });
      return;
    }
    // Fixed 2026-09-08 — a real resolve failure (WABA 998094716164113,
    // TNPSC Mentors) was invisible without opening DevTools' Network tab:
    // apiFetch's ApiError.message is only ever the generic top-level
    // `error` string ("Could not look up phone numbers..."), never the
    // specific `detail` field the backend also sends (e.g. Meta's actual
    // rejection reason). retryProvisioning below already does this
    // preference correctly — matching that precedent here.
    const explanation = (err.data && err.data.detail) ? `${err.message}: ${err.data.detail}` : err.message;
    resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(explanation)}</div>`;
    showToast('Failed to resolve: ' + explanation, 'error');
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    refreshIcons();
  }
}

async function refreshMessagingTier(clientId) {
  const btn = document.getElementById('refresh-messaging-tier-btn');
  const resultEl = document.getElementById('refresh-messaging-tier-result');
  resultEl.innerHTML = '';
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="icon-14 spin"></i> Checking…';
  refreshIcons();

  try {
    const res = await apiFetch(`/api/admin/clients/${clientId}/refresh-messaging-tier`, { method: 'POST' });
    resultEl.innerHTML = `<div class="inline-success">
      Messaging tier is now "${esc(res.waba.messaging_tier || 'unknown')}".
    </div>`;
    showToast('Messaging tier refreshed.', 'success');
    loadClientDetail(clientId, { quiet: true });
  } catch (err) {
    if (err.status === 401) return;
    // 400 = no WABA to check, 502 = the call to Meta failed (expected in a
    // dev environment since no real Meta app is configured). Both are normal
    // UI states, not bugs — same treatment as retryProvisioning below.
    let explanation = err.message;
    if (err.status === 502) {
      explanation = `Tier check failed when calling Meta: ${err.data && err.data.detail ? err.data.detail : err.message}. This is expected on a local/dev setup where no real Meta app is configured.`;
    }
    resultEl.innerHTML = `<div class="inline-warning" role="alert">${esc(explanation)}</div>`;
    showToast('Messaging tier check did not succeed — see details below.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    refreshIcons();
  }
}

// Sendability monitoring, all three layers — runs registration/health AND
// the send probe together (see sendabilityMonitorRunner.js's refreshOne).
// The probe is the one that actually sets `sendable`.
async function checkSendability(clientId) {
  const btn = document.getElementById('check-sendability-btn');
  const resultEl = document.getElementById('check-sendability-result');
  resultEl.innerHTML = '';
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="icon-14 spin"></i> Checking…';
  refreshIcons();

  try {
    const res = await apiFetch(`/api/admin/clients/${clientId}/check-sendability`, { method: 'POST' });
    const w = res.waba;
    const sendableText = w.sendable === true ? 'Yes' : w.sendable === false ? 'No' : 'Unknown';
    resultEl.innerHTML = `<div class="inline-success">
      Sendable: ${esc(sendableText)}${w.sendable_reason ? ` (${esc(w.sendable_reason)})` : ''}. Probe (permission only): ${w.probe_sendable === true ? 'Yes' : w.probe_sendable === false ? 'No' : 'Unknown'}. On Business App: ${w.registration_is_on_biz_app === null ? '—' : (w.registration_is_on_biz_app ? 'Yes' : 'No')}.
    </div>`;
    showToast('Sendability checked.', 'success');
    loadClientDetail(clientId, { quiet: true });
  } catch (err) {
    if (err.status === 401) return;
    let explanation = err.message;
    if (err.status === 502) {
      explanation = `Check failed when calling Meta: ${err.data && err.data.detail ? err.data.detail : err.message}. This is expected on a local/dev setup where no real Meta app is configured.`;
    }
    resultEl.innerHTML = `<div class="inline-warning" role="alert">${esc(explanation)}</div>`;
    showToast('Sendability check did not succeed — see details below.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    refreshIcons();
  }
}

async function retryProvisioning(clientId) {
  const btn = document.getElementById('retry-provisioning-btn');
  const resultEl = document.getElementById('retry-provisioning-result');
  resultEl.innerHTML = '';
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="icon-14 spin"></i> Retrying…';
  refreshIcons();

  try {
    const res = await apiFetch(`/api/admin/clients/${clientId}/retry-provisioning`, { method: 'POST' });
    resultEl.innerHTML = `<div class="inline-success">
      Retry succeeded — WABA status is now "${esc(res.waba.status)}".
    </div>`;
    showToast('Provisioning retry succeeded.', 'success');
    loadClientDetail(clientId, { quiet: true });
  } catch (err) {
    if (err.status === 401) return;
    // 400 = no WABA to retry, 502 = the call to Meta failed (expected in a dev
    // environment since no real Meta app is configured). Both are normal UI
    // states, not bugs — surface them clearly instead of hiding them.
    let explanation = err.message;
    if (err.status === 502) {
      explanation = `Retry failed when calling Meta: ${err.data && err.data.detail ? err.data.detail : err.message}. This is expected on a local/dev setup where no real Meta app is configured.`;
    }
    resultEl.innerHTML = `<div class="inline-warning" role="alert">${esc(explanation)}</div>`;
    showToast('Retry provisioning did not succeed — see details below.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    refreshIcons();
  }
}

// Permanent, cascading delete — the strongest confirm in the console: the
// admin must type the client's exact name before the button enables.
function confirmDeleteClient(client) {
  showConfirm({
    title: 'Delete this client permanently?',
    body: `
      <p>You are about to permanently delete <strong>${esc(client.name)}</strong> (${esc(client.email)}).</p>
      <p class="confirm-warning">This cascades and deletes every tenant table row for this client — contacts, chats, messages, everything. This cannot be undone.</p>
    `,
    confirmLabel: 'Delete Permanently',
    danger: true,
    requireText: String(client.name || '').trim(),
    onConfirm: async () => {
      await apiFetch(`/api/clients/${client.id}`, { method: 'DELETE' });
      showToast(`${client.name} was deleted.`, 'success');
      state.currentClientId = null;
      switchView('clients');
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
      <p>This immediately invalidates <strong>${esc(client.name)}</strong>'s (${esc(client.email)}) current password and generates a new one.</p>
      <p>You'll need to send them the new password yourself — there's no notification email for this.</p>
    `,
    confirmLabel: 'Reset Password',
    danger: true,
    onConfirm: () => resetClientPassword(client),
  });
}

async function resetClientPassword(client) {
  const resultEl = document.getElementById('reset-client-password-result');
  const data = await apiFetch(`/api/clients/${client.id}/reset-password`, { method: 'POST' }); // throws -> dialog shows the error
  resultEl.innerHTML = `
    <div class="inline-success" style="margin-top:0.75rem;">Password reset — shown once, copy it now.</div>
    ${secretRowsHtml([
      ['Login URL', data.loginUrl],
      ['Email', data.email],
      ['New Password', data.temporaryPassword],
    ])}
  `;
  refreshIcons();
  showToast('Password reset.', 'success');
}

/* ---------------------------------------------------------------
   Onboarding Queue
   --------------------------------------------------------------- */
async function loadOnboarding() {
  setInlineError('onboarding-error', null);
  showTableLoading('onboarding-table-body', 7);

  try {
    const rows = await apiFetch('/api/admin/onboarding-queue');
    state.onboardingRows = rows;
    renderOnboardingTable(rows);
  } catch (err) {
    if (err.status === 401) return;
    showTableError('onboarding-table-body', 7, err.message, loadOnboarding);
  }
}

function renderOnboardingTable(rows) {
  const tbody = document.getElementById('onboarding-table-body');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(7, 'Onboarding queue is empty', 'Every client is active.', 'check-circle');
    refreshIcons();
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-client-id="${esc(r.id)}">
      <td data-label="Name">${esc(r.name)}</td>
      <td data-label="Email">${esc(r.email)}</td>
      <td data-label="Client Status">${statusBadge(r.client_status)}</td>
      <td data-label="Plan">${esc(r.plan || '—')}</td>
      <td data-label="Stuck At">${stuckAtBadge(r.stuck_at)}</td>
      <td data-label="Created">${formatDate(r.created_at)}</td>
      <td data-label="Actions"><button class="btn-secondary btn-sm" data-jump-client="${esc(r.id)}" aria-label="View ${esc(r.name)}">View</button></td>
    </tr>
  `).join('');

  bindClickableRows(tbody, 'data-client-id', (id) => openClientDetail(id));
  tbody.querySelectorAll('[data-jump-client]').forEach((btn) => {
    btn.addEventListener('click', () => openClientDetail(btn.getAttribute('data-jump-client')));
  });
}

/* ---------------------------------------------------------------
   Health — tabs: Monitor | WABA Health | Platform Overview | Failures.
   Each tab loads its own data lazily when selected.
   --------------------------------------------------------------- */
function loadHealthTab(tab) {
  if (tab === 'waba') loadWabas();
  else if (tab === 'overview') loadPlatformOverview();
  else if (tab === 'failures') loadFailures();
  else loadHealthMonitor();
}

function selectHealthTab(tab) {
  state.viewTab.health = tab;
  showTab(document.getElementById('view-health'), tab);
  writeHash('health', 'replace');
  loadHealthTab(tab);
}

/* WABA Health */
async function loadWabas() {
  setInlineError('wabas-error', null);
  showTableLoading('wabas-table-body', 8);

  try {
    const rows = await apiFetch('/api/admin/wabas');
    state.wabaRows = rows;
    renderWabasTable(rows);
  } catch (err) {
    if (err.status === 401) return;
    showTableError('wabas-table-body', 8, err.message, loadWabas);
  }
}

// Sendability monitoring, Layer 1 (registration) — a compact summary for the
// WABA Health table and the client-detail panel. Deliberately NOT a
// pass/fail verdict: is_on_biz_app === false && code_verification_status
// !== 'VERIFIED' is an unconfirmed hypothesis (see migration
// 074_wabas_sendability.js's header comment — TNPSC registered successfully
// and code_verification_status stayed EXPIRED regardless of whether it could
// actually send), so this renders as an informational flag with an explicit
// "unconfirmed" note, never as a red "cannot send" badge — only the send
// probe (Layer 3) gets to make that claim.
// "What the client sees" — the exact same plain-English banner
// (server/src/utils/sendabilityMessages.js) the root CRM app shows above
// its own app shell, rendered inline here instead of as a sticky top bar
// (admin manages many clients, not just this one, so a persistent
// full-width admin banner doesn't make sense the way it does client-side).
// Renders nothing when the client wouldn't see a banner either — this is
// meant to answer "what does this client see," not duplicate every raw
// field already shown below it.
function clientSendabilityBannerHtml(waba) {
  const info = window.sendabilityMessages ? window.sendabilityMessages.describeSendability(waba) : null;
  if (!info) return '';
  return `
    <div class="sendability-banner visible sendability-inline severity-${esc(info.severity)}">
      <span class="sendability-banner-headline">${esc(info.headline)}</span>
      ${info.code != null ? `<span class="sendability-banner-code">#${esc(String(info.code))}</span>` : ''}
      <span class="sendability-banner-action">${esc(info.action)}</span>
    </div>
  `;
}

function registrationBadgeHtml(waba) {
  if (!waba.registration_checked_at) {
    return '<span class="cell-secondary">Not checked yet</span>';
  }
  if (waba.registration_is_on_biz_app === true) {
    return badge('On Business App', 'success', 'Coexistence — linked via the WhatsApp Business app');
  }
  if (waba.registration_code_verification_status && waba.registration_code_verification_status !== 'VERIFIED') {
    return badge(`⚠ ${waba.registration_code_verification_status}`, 'warning', `Not on the WhatsApp Business app, and code_verification_status is ${waba.registration_code_verification_status} — unconfirmed whether this blocks sending, see sendable status for the real answer`);
  }
  return badge('Registered', 'success');
}

// Sendability monitoring, Layer 2 (health_status) — verified NOT to catch
// the billing-shaped failure that caused the 2026-09-18 outage (returned
// AVAILABLE for every entity on the known-bad account while sends failed),
// so this is purely informational, same as the registration badge above —
// never treated as the sendability signal.
function healthStatusSummaryHtml(waba) {
  if (!waba.health_status_checked_at) {
    return '<span class="cell-secondary">Not checked yet</span>';
  }
  const entities = waba.health_status?.entities || [];
  const notAvailable = entities.filter((e) => e.can_send_message && e.can_send_message !== 'AVAILABLE');
  if (notAvailable.length === 0) {
    return badge('All Available', 'success');
  }
  const first = notAvailable[0];
  const reason = first.errors?.[0]?.error_description || first.can_send_message;
  return badge(
    `${first.entity_type || '?'}: ${reason || 'not available'}${notAvailable.length > 1 ? ` (+${notAvailable.length - 1} more)` : ''}`,
    'danger',
    JSON.stringify(notAvailable)
  );
}

function renderWabasTable(rows) {
  const tbody = document.getElementById('wabas-table-body');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(8, 'No WhatsApp accounts connected', 'Connected WhatsApp Business Accounts appear here.', 'message-circle');
    refreshIcons();
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-client-id="${esc(r.client_id)}">
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Tenant Slug">${esc(r.tenant_slug)}</td>
      <td data-label="WABA ID" class="cell-mono">${esc(r.waba_id || '—')}</td>
      <td data-label="Phone Number ID" class="cell-mono">${esc(r.phone_number_id || '—')}</td>
      <td data-label="Quality Rating">${esc(r.quality_rating || '—')}</td>
      <td data-label="Status">${statusBadge(r.status)}</td>
      <td data-label="Registration">${registrationBadgeHtml(r)}</td>
      <td data-label="Verified At">${formatDate(r.verified_at)}</td>
    </tr>
  `).join('');

  bindClickableRows(tbody, 'data-client-id', (id) => openClientDetail(id));
}

/* Platform Overview */
async function loadPlatformOverview() {
  setInlineError('platform-overview-error', null);
  showTableLoading('platform-overview-table-body', 10);

  try {
    const rows = await apiFetch('/api/admin/clients-overview');
    renderPlatformOverview(rows);
  } catch (err) {
    if (err.status === 401) return;
    showTableError('platform-overview-table-body', 10, err.message, loadPlatformOverview);
  }
}

// Task B — dormant-client visibility. Resend isn't configured (see the Health
// Monitor's own "Alerts aren't set up" banner), so an alert that only ever
// exists as an unsent email is the exact failure mode this closes:
// dormant_no_outbound_7d/never_logged_in_stale (server/src/routes/admin.js's
// clients-overview query — the same two conditions alertRunner.js's
// checkDormantNoOutbound/checkNeverLoggedIn raise as real alerts) are always
// visible here regardless of whether any notification channel works.
function attentionBadgesHtml(r) {
  const badges = [];
  if (r.dormant_no_outbound_7d) {
    badges.push(badge('Not responding', 'danger', 'Receiving inbound WhatsApp messages but nobody has sent an outbound reply in 7 days'));
  }
  if (r.never_logged_in_stale) {
    badges.push(badge('Never logged in', 'warning', 'WhatsApp has been connected for more than 3 days and nobody has ever logged into the CRM'));
  }
  return badges.length ? badges.join(' ') : '—';
}

function renderPlatformOverview(rows) {
  const tbody = document.getElementById('platform-overview-table-body');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(10, 'No clients yet', 'Clients appear here once they are created.', 'users');
    refreshIcons();
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-client-id="${esc(r.id)}">
      <td data-label="Client">${esc(r.name)}</td>
      <td data-label="Tenant Slug">${esc(r.tenant_slug)}</td>
      <td data-label="Client Status">${statusBadge(r.client_status)}</td>
      <td data-label="WABA Status">${r.waba_status ? statusBadge(r.waba_status) : '—'}</td>
      <td data-label="Quality Rating">${esc(r.quality_rating || '—')}</td>
      <td data-label="Plan">${esc(r.plan || '—')}</td>
      <td data-label="Subscription Status">${r.subscription_status ? statusBadge(r.subscription_status) : '—'}</td>
      <td data-label="Connected">${formatDate(r.connected_date)}</td>
      <td data-label="Last Login">${r.last_login_at ? formatDate(r.last_login_at) : '<span class="cell-secondary">Never</span>'}</td>
      <td data-label="Attention">${attentionBadgesHtml(r)}</td>
    </tr>
  `).join('');

  bindClickableRows(tbody, 'data-client-id', (id) => openClientDetail(id));
}

/* ---------------------------------------------------------------
   Payment Reminders (audit of every billing message sent to a client)
   --------------------------------------------------------------- */
const PR_KIND_LABELS = {
  payment_reminder: 'Payment reminder',
  suspension_warning: 'Suspension warning',
  service_suspended: 'Service suspended',
};
const PR_TRIGGER_LABELS = { scheduled: 'Monthly schedule', nonpayment_timeline: 'Nonpayment timeline', manual_bulk: 'Sent by admin', admin_schedule: 'Admin schedule' };
// Honest mapping: sent = accepted by Meta only (neutral), delivered = reached
// the phone (info), read = opened (success), failed = never delivered (danger).
const PR_STATUS_TONE = { sent: 'neutral', delivered: 'info', read: 'success', failed: 'danger' };
const PR_STATUS_LABEL = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

let paymentRemindersData = { rows: [], summary: null, senderConfigured: true };
let paymentRemindersTimer = null;

function startPaymentRemindersPolling() {
  stopPaymentRemindersPolling();
  paymentRemindersTimer = setInterval(() => loadPaymentReminders({ quiet: true }), 15000);
}
function stopPaymentRemindersPolling() {
  if (paymentRemindersTimer) clearInterval(paymentRemindersTimer);
  paymentRemindersTimer = null;
}

async function loadPaymentReminders({ quiet = false } = {}) {
  if (!quiet) {
    setInlineError('pr-error', null);
    showTableLoading('pr-table-body', 9);
  }
  if (!quiet) loadPaymentSchedules();
  try {
    const status = document.getElementById('pr-filter-status').value;
    const kind = document.getElementById('pr-filter-kind').value;
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (kind) qs.set('kind', kind);
    paymentRemindersData = await apiFetch(`/api/admin/payment-notifications?${qs}`);
    if (!quiet) resetPage('pr');
    renderPaymentReminders();
  } catch (err) {
    if (err.status === 401) return;
    if (!quiet) showTableError('pr-table-body', 9, err.message, () => loadPaymentReminders());
  }
}

function ordinal(n) {
  const v = n % 100;
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th');
}

function populateScheduleSelects() {
  const day = document.getElementById('pr-sched-day');
  if (day.options.length) return;
  for (let d = 1; d <= 31; d++) day.add(new Option(ordinal(d), d));
  const hour = document.getElementById('pr-sched-hour');
  for (let h = 0; h < 24; h++) {
    const label = `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
    hour.add(new Option(label, h));
  }
  hour.value = '10';
}

async function loadPaymentSchedules() {
  populateScheduleSelects();
  const box = document.getElementById('pr-sched-list');
  try {
    const schedules = await apiFetch('/api/admin/payment-notifications/schedules');
    if (!schedules.length) {
      box.innerHTML = '<div class="muted-text">No schedules yet. Add one above to send reminders automatically each month.</div>';
      return;
    }
    box.innerHTML = schedules.map((sc) => `
      <div class="schedule-row">
        <div class="schedule-when"><strong>${ordinal(sc.day_of_month)} of every month</strong> at ${((sc.send_hour + 11) % 12) + 1}:00 ${sc.send_hour < 12 ? 'AM' : 'PM'} IST</div>
        <div class="schedule-last">${sc.last_run_on ? `Last run ${esc(String(sc.last_run_on).slice(0, 10))} · ${esc(sc.last_run_summary || '')}` : 'Has not run yet'}</div>
        <label class="hub-event-label"><input type="checkbox" data-sched-toggle="${esc(sc.id)}" ${sc.enabled ? 'checked' : ''}> <span style="font-family:inherit;">Enabled</span></label>
        <button class="btn-secondary btn-sm" data-sched-delete="${esc(sc.id)}">Delete</button>
      </div>`).join('');
    box.querySelectorAll('[data-sched-toggle]').forEach((el) => el.addEventListener('change', async () => {
      try {
        await apiFetch(`/api/admin/payment-notifications/schedules/${el.getAttribute('data-sched-toggle')}`, { method: 'PATCH', body: JSON.stringify({ enabled: el.checked }) });
      } catch (err) { showToast(err.message, 'error'); loadPaymentSchedules(); }
    }));
    box.querySelectorAll('[data-sched-delete]').forEach((el) => el.addEventListener('click', () => {
      showConfirm({
        title: 'Delete this schedule?', body: '<p>It will stop sending. Past messages stay in the log below.</p>', confirmLabel: 'Delete',
        onConfirm: async () => {
          await apiFetch(`/api/admin/payment-notifications/schedules/${el.getAttribute('data-sched-delete')}`, { method: 'DELETE' });
          loadPaymentSchedules();
        },
      });
    }));
  } catch (err) {
    if (err.status !== 401) {
      box.innerHTML = `<div class="inline-error" role="alert"><span>${esc(err.message)}</span><button type="button" class="btn-secondary btn-sm" id="pr-sched-retry">Try again</button></div>`;
      document.getElementById('pr-sched-retry').addEventListener('click', loadPaymentSchedules);
    }
  }
}

async function addPaymentSchedule() {
  const day = Number(document.getElementById('pr-sched-day').value);
  const hour = Number(document.getElementById('pr-sched-hour').value);
  try {
    await apiFetch('/api/admin/payment-notifications/schedules', { method: 'POST', body: JSON.stringify({ day_of_month: day, send_hour: hour }) });
    showToast('Schedule added.', 'success');
    loadPaymentSchedules();
  } catch (err) { showToast(err.message, 'error'); }
}

function paymentRemindersVisibleRows() {
  const q = document.getElementById('pr-filter-search').value.trim().toLowerCase();
  if (!q) return paymentRemindersData.rows;
  return paymentRemindersData.rows.filter((r) =>
    (r.client_name || '').toLowerCase().includes(q) || (r.recipient_phone || '').toLowerCase().includes(q));
}

function renderPaymentReminders() {
  const { summary, senderConfigured } = paymentRemindersData;
  const banner = document.getElementById('pr-sender-banner');
  if (!senderConfigured) {
    banner.style.display = 'flex';
    banner.innerHTML = `
      <i data-lucide="alert-triangle" class="icon-16"></i>
      <span class="alert-body"><strong>Payment messages can't be sent yet.</strong> Wasi's own WhatsApp sender isn't set up on the server, so every send attempt below is recorded as Failed. The three payment message templates must also be approved by Meta before anything is delivered.
      <span class="tech-detail">Technical detail: PAYMENT_REMINDER_WABA_ID is not set; templates needed: wasi_payment_reminder, wasi_suspension_warning, wasi_service_suspended.</span></span>`;
  } else {
    banner.style.display = 'none';
  }

  if (summary) {
    const delivered = summary.delivered_only + summary.read;
    const tiles = [
      { label: 'Total sent', value: summary.total },
      { label: 'Delivered', value: delivered },
      { label: 'Read', value: summary.read },
      { label: 'Not yet delivered', value: summary.sent_only },
      { label: 'Failed', value: summary.failed, tone: summary.failed > 0 ? 'danger' : undefined },
      { label: 'Clients reminded', value: summary.clients_reminded },
    ];
    document.getElementById('pr-summary').innerHTML = tiles.map((t) => kpiTileHtml(t)).join('');
  }

  const all = paymentRemindersVisibleRows();
  document.getElementById('pr-count').textContent = `${all.length} message${all.length === 1 ? '' : 's'}`;
  const tbody = document.getElementById('pr-table-body');
  if (!all.length) {
    document.getElementById('pr-pager').hidden = true;
    tbody.innerHTML = emptyRow(9, 'No payment messages recorded', 'Reminders, warnings and suspension notices will be listed here once sent.', 'bell-ring');
    refreshIcons();
    return;
  }
  const rows = pageSlice('pr', all, 25, 'pr-pager', renderPaymentReminders);
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Phone">${esc(r.recipient_phone || '—')}</td>
      <td data-label="Message">${esc(PR_KIND_LABELS[r.kind] || r.kind)}</td>
      <td data-label="Trigger">${esc(PR_TRIGGER_LABELS[r.trigger] || r.trigger)}</td>
      <td data-label="Status">${badge(PR_STATUS_LABEL[r.status] || r.status, PR_STATUS_TONE[r.status] || 'neutral')}</td>
      <td data-label="Sent">${formatDateTime(r.sent_at || r.created_at)}</td>
      <td data-label="Delivered">${formatDateTime(r.delivered_at)}</td>
      <td data-label="Read">${formatDateTime(r.read_at)}</td>
      <td data-label="Error" class="cell-wrap">${esc(r.error_message || '')}</td>
    </tr>`).join('');
}

function exportPaymentRemindersCsv() {
  const rows = paymentRemindersVisibleRows();
  const header = ['Client', 'Phone', 'Message', 'Trigger', 'Status', 'Sent', 'Delivered', 'Read', 'Failed', 'Error'];
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.map(cell).join(',')].concat(rows.map((r) => [
    r.client_name, r.recipient_phone, PR_KIND_LABELS[r.kind] || r.kind, PR_TRIGGER_LABELS[r.trigger] || r.trigger,
    r.status, r.sent_at, r.delivered_at, r.read_at, r.failed_at, r.error_message,
  ].map(cell).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `payment-reminders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Outward-facing and irreversible (a real WhatsApp message to every active
// client), so the confirm shows exactly WHO will get it. The recipient list is
// the current GET /api/clients result filtered to status 'active' — the same
// rule the server applies (clientsRepo.listActive) — fetched fresh here so it
// isn't a stale cache.
async function confirmSendRemindersToAllActive() {
  let active;
  try {
    const clients = await apiFetch('/api/clients');
    state.clients = clients;
    active = clients.filter((c) => c.status === 'active');
  } catch (err) {
    if (err.status === 401) return;
    showToast('Could not load the recipient list: ' + err.message, 'error');
    return;
  }

  const listHtml = active.length
    ? `<ul class="recipient-list" aria-label="Recipients">${active.map((c) => `<li><span>${esc(c.name)}</span><span class="cell-secondary">${esc(c.email)}</span></li>`).join('')}</ul>`
    : '';
  showConfirm({
    title: `Send payment reminder to ${active.length} active client${active.length === 1 ? '' : 's'}?`,
    body: active.length
      ? `<p>This sends the <strong>wasi_payment_reminder</strong> WhatsApp message, right now, to these <strong>${active.length}</strong> client${active.length === 1 ? '' : 's'} (status: active). It cannot be recalled once sent.</p>
         ${listHtml}
         <p class="muted-text" style="margin-top:0.6rem;">Every attempt, delivery and read receipt is recorded on this page.</p>`
      : '<p>There are no active clients right now, so nothing would be sent.</p>',
    confirmLabel: active.length ? `Send to ${active.length} client${active.length === 1 ? '' : 's'}` : 'Send',
    danger: false,
    onConfirm: async () => {
      if (!active.length) throw new Error('No active clients to send to.');
      const r = await apiFetch('/api/admin/payment-notifications/send-reminders', {
        method: 'POST', body: JSON.stringify({ confirm: true }),
      });
      showToast(`Reminders: ${r.sent} sent, ${r.failed} failed (of ${r.total} active clients).`, r.failed ? 'error' : 'success');
      loadPaymentReminders();
    },
  });
}

/* ---------------------------------------------------------------
   Health Monitor (tab)
   --------------------------------------------------------------- */
async function loadHealthMonitor() {
  setInlineError('health-monitor-error', null);
  showTableLoading('health-monitor-table-body', 9);

  loadAlertingStatusBanner();

  try {
    const rows = await apiFetch('/api/admin/health');
    renderHealthMonitor(rows);
  } catch (err) {
    if (err.status === 401) return;
    showTableError('health-monitor-table-body', 9, err.message, loadHealthMonitor);
  }
}

// Confirmed real 2026-09-22: production has RESEND_API_KEY/ALERT_EMAIL_TO/
// ALERT_WHATSAPP_TO/ALERT_WABA_ID all unset, and this was invisible
// anywhere in the admin panel. Fetched separately from the health rows
// above (its own endpoint, its own failure mode) so a health-fetch error
// never hides this banner or vice versa. Wording is plain for the operator;
// the env var names are a small secondary "technical detail" line.
async function loadAlertingStatusBanner() {
  const banner = document.getElementById('alerting-status-banner');
  if (!banner) return;
  try {
    const status = await apiFetch('/api/admin/alerting-status');
    const gaps = [];
    const envs = [];
    if (!status.resendConfigured) { gaps.push('the email delivery service'); envs.push('RESEND_API_KEY'); }
    if (!status.emailConfigured) { gaps.push('an alert recipient email address'); envs.push('ALERT_EMAIL_TO'); }
    if (!status.whatsappConfigured) { gaps.push('a WhatsApp alert number'); envs.push('ALERT_WHATSAPP_TO', 'ALERT_WABA_ID'); }
    if (gaps.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';
    banner.innerHTML = `
      <i data-lucide="alert-triangle" class="icon-16"></i>
      <span class="alert-body"><strong>Ops alerts aren't fully set up.</strong> Missing: ${esc(gaps.join(', '))}. Until this is fixed, alerts are only written to the server log — nobody is actually notified.
      <span class="tech-detail">Technical detail: set ${esc(envs.join(', '))} on the server (see .env.example).</span></span>`;
    refreshIcons();
  } catch (err) {
    if (err.status === 401) return;
    // A failure to even CHECK the status is itself worth surfacing, not
    // silently hidden — but distinguishable from "confirmed not configured".
    banner.style.display = 'flex';
    banner.textContent = `Could not check alerting configuration: ${err.message}`;
  }
}

// "Send test alert" — POST /api/admin/alerts/test, then renders the real
// per-channel result (attempted/sent/error, including Resend's or Meta's
// exact error text) rather than a bare success/failure toast. Never writes
// a real alert_events row (see that route's own comment).
async function sendTestAlert() {
  const btn = document.getElementById('send-test-alert-btn');
  const resultEl = document.getElementById('test-alert-result');
  btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.textContent = 'Sending test alert…';
  try {
    const result = await apiFetch('/api/admin/alerts/test', { method: 'POST' });
    const lines = [];
    for (const [channel, r] of [['Email', result.email], ['WhatsApp', result.whatsapp]]) {
      if (!r.attempted) {
        lines.push(`${channel}: not attempted — ${r.reason || r.error || 'not configured'}`);
      } else if (r.sent) {
        lines.push(`${channel}: sent successfully.`);
      } else {
        const metaDetail = r.metaError ? ` (Meta: ${JSON.stringify(r.metaError)})` : '';
        lines.push(`${channel}: FAILED — ${r.error}${metaDetail}`);
      }
    }
    resultEl.textContent = lines.join('\n');
  } catch (err) {
    resultEl.textContent = `Could not send test alert: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderHealthMonitor(rows) {
  const tbody = document.getElementById('health-monitor-table-body');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(9, 'No WhatsApp accounts connected', 'Connected WhatsApp Business Accounts appear here.', 'heart-pulse');
    refreshIcons();
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-client-id="${esc(r.client_id)}">
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Tenant Slug">${esc(r.tenant_slug)}</td>
      <td data-label="WABA ID" class="cell-mono">${esc(r.waba_id || '—')}</td>
      <td data-label="WABA Status">${statusBadge(r.waba_status)}</td>
      <td data-label="Quality Rating">${esc(r.quality_rating || '—')}</td>
      <td data-label="Restriction Status">${esc(r.restriction_status || '—')}</td>
      <td data-label="Health Status">${healthStatusSummaryHtml(r)}</td>
      <td data-label="Last Successful Webhook">${formatDateTime(r.last_successful_webhook_at)}</td>
      <td data-label="Forwarding Failures">${esc(r.forwarding_failure_count)}</td>
    </tr>
  `).join('');

  bindClickableRows(tbody, 'data-client-id', (id) => openClientDetail(id));
}

/* ---------------------------------------------------------------
   Failures (tab)
   --------------------------------------------------------------- */
async function loadFailures() {
  setInlineError('failures-error', null);
  showTableLoading('failures-sends-table-body', 6);
  showTableLoading('failures-webhooks-table-body', 6);
  showTableLoading('failures-flows-table-body', 6);

  try {
    const [sends, webhooks, flows] = await Promise.all([
      apiFetch('/api/admin/failures/sends'),
      apiFetch('/api/admin/failures/webhook-deliveries'),
      apiFetch('/api/admin/failures/stalled-flows'),
    ]);
    state.failuresSends = sends;
    state.failuresWebhooks = webhooks;
    state.failuresFlows = flows;
    ['failures-sends', 'failures-webhooks', 'failures-flows'].forEach(resetPage);
    renderFailedSends();
    renderFailedWebhooks();
    renderStalledFlows();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('failures-sends-table-body', 6, err.message, loadFailures);
    document.getElementById('failures-webhooks-table-body').innerHTML = '';
    document.getElementById('failures-flows-table-body').innerHTML = '';
  }
}

function renderFailedSends() {
  const tbody = document.getElementById('failures-sends-table-body');
  const all = state.failuresSends;
  if (!all.length) {
    document.getElementById('failures-sends-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No failed sends', 'Every recent message was accepted for delivery.', 'check-circle');
    refreshIcons();
    return;
  }
  const rows = pageSlice('failures-sends', all, 15, 'failures-sends-pager', renderFailedSends);
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Chat" class="cell-mono">${esc(r.chat_id || '—')}</td>
      <td data-label="Body" class="cell-wrap">${esc(r.body || '')}</td>
      <td data-label="Error Reason" class="cell-wrap">${esc(r.error_reason || '—')}</td>
      <td data-label="Meta Error Code">${esc(r.meta_error_code ?? '—')}</td>
      <td data-label="Sent At">${formatDateTime(r.sent_at)}</td>
    </tr>
  `).join('');
}

function renderFailedWebhooks() {
  const tbody = document.getElementById('failures-webhooks-table-body');
  const all = state.failuresWebhooks;
  if (!all.length) {
    document.getElementById('failures-webhooks-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No failed webhook deliveries', 'Every forwarded event was delivered.', 'check-circle');
    refreshIcons();
    return;
  }
  const rows = pageSlice('failures-webhooks', all, 15, 'failures-webhooks-pager', renderFailedWebhooks);
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Event">${esc(r.event || '—')}</td>
      <td data-label="Target URL" class="cell-wrap cell-break">${esc(r.target_url || '—')}</td>
      <td data-label="Attempts">${esc(r.attempt_count)}</td>
      <td data-label="Last Error" class="cell-wrap">${esc(r.last_error || '—')}</td>
      <td data-label="Created">${formatDateTime(r.created_at)}</td>
    </tr>
  `).join('');
}

function renderStalledFlows() {
  const tbody = document.getElementById('failures-flows-table-body');
  const all = state.failuresFlows;
  if (!all.length) {
    document.getElementById('failures-flows-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No stalled flows', 'No automation flow is stuck.', 'check-circle');
    refreshIcons();
    return;
  }
  const rows = pageSlice('failures-flows', all, 15, 'failures-flows-pager', renderStalledFlows);
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Client">${esc(r.client_name)}</td>
      <td data-label="Contact">${esc(r.contact_name || '—')} <span class="cell-secondary">${esc(r.contact_phone || '')}</span></td>
      <td data-label="Flow">${esc(r.flow_name)}</td>
      <td data-label="Stuck At Node">${esc(r.node_type || '—')}</td>
      <td data-label="Error" class="cell-wrap">${esc((r.stall_detail && r.stall_detail.error) || '—')}</td>
      <td data-label="Stalled At">${formatDateTime(r.updated_at)}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Billing
   --------------------------------------------------------------- */
async function loadBilling() {
  setInlineError('billing-error', null);
  const grid = document.getElementById('billing-stats');
  grid.innerHTML = Array.from({ length: 3 }, () =>
    '<div class="kpi-tile" aria-hidden="true"><span class="skeleton" style="height:28px;width:50%;"></span><span class="skeleton" style="height:14px;width:70%;"></span></div>'
  ).join('');
  showTableLoading('billing-table-body', 5);

  try {
    const overview = await apiFetch('/api/admin/billing/overview');
    state.billingRows = overview.subscriptions;
    resetPage('billing');
    renderBilling(overview);
  } catch (err) {
    if (err.status === 401) return;
    grid.innerHTML = '';
    showTableError('billing-table-body', 5, err.message, loadBilling);
  }
}

function renderBilling(overview) {
  const cards = [
    { icon: 'indian-rupee', label: 'Estimated MRR', value: `₹${overview.estimatedMrr.toLocaleString('en-IN')}` },
    { icon: 'check-circle', label: 'Active Subscriptions', value: overview.activeCount },
    { icon: 'alert-triangle', label: 'Failed / Pending', value: overview.failedOrPendingCount, tone: overview.failedOrPendingCount > 0 ? 'warning' : undefined },
  ];
  document.getElementById('billing-stats').innerHTML = cards.map((c) => kpiTileHtml(c)).join('');
  drawBillingTable();
  refreshIcons();
}

function drawBillingTable() {
  const tbody = document.getElementById('billing-table-body');
  const all = state.billingRows;
  if (!all.length) {
    document.getElementById('billing-pager').hidden = true;
    tbody.innerHTML = emptyRow(5, 'No subscriptions yet', 'Subscriptions appear here once a client picks a plan.', 'credit-card');
    refreshIcons();
    return;
  }
  const rows = pageSlice('billing', all, 25, 'billing-pager', drawBillingTable);
  tbody.innerHTML = rows.map((s) => `
    <tr>
      <td data-label="Client">${esc(s.client_name)}</td>
      <td data-label="Plan">${esc(s.plan)}</td>
      <td data-label="Status">${statusBadge(s.status)}</td>
      <td data-label="Renews At">${formatDate(s.renews_at)}</td>
      <td data-label="Payment Ref" class="cell-mono">${esc(s.payment_provider_ref || '—')}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Templates Review — Approve/Reject always go through a confirm that shows
   the full template body. NOTE: PATCH /api/admin/templates/:id accepts ONLY
   { status } (templateStatusUpdateSchema) — there is no rejection-reason
   field in the API, so none is collected here.
   --------------------------------------------------------------- */
async function loadTemplatesReview() {
  setInlineError('templates-review-error', null);
  showTableLoading('templates-review-table-body', 6);

  const status = document.getElementById('templates-review-status-filter').value;
  try {
    const rows = await apiFetch(`/api/admin/templates${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.templatesReviewRows = rows;
    resetPage('templates');
    renderTemplatesReview();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('templates-review-table-body', 6, err.message, loadTemplatesReview);
  }
}

function templatesReviewFiltered() {
  const q = (document.getElementById('templates-review-search')?.value || '').trim().toLowerCase();
  if (!q) return state.templatesReviewRows;
  return state.templatesReviewRows.filter((t) =>
    (t.client_name || '').toLowerCase().includes(q) ||
    (t.name || '').toLowerCase().includes(q) ||
    (t.body || '').toLowerCase().includes(q));
}

function renderTemplatesReview() {
  const tbody = document.getElementById('templates-review-table-body');
  const all = templatesReviewFiltered();
  document.getElementById('templates-review-count').textContent = `${all.length} template${all.length === 1 ? '' : 's'}`;
  if (!all.length) {
    document.getElementById('templates-review-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No templates match', 'Try a different status filter or search.', 'file-check');
    refreshIcons();
    return;
  }
  const rows = pageSlice('templates', all, 20, 'templates-review-pager', renderTemplatesReview);
  tbody.innerHTML = rows.map((t) => `
    <tr data-template-id="${esc(t.id)}">
      <td data-label="Client">${esc(t.client_name)}</td>
      <td data-label="Name" class="cell-mono cell-break">${esc(t.name)}</td>
      <td data-label="Category">${esc(t.category || '—')}</td>
      <td data-label="Body"><div class="cell-clamp" title="${esc(t.body || '')}">${esc(t.body || '')}</div></td>
      <td data-label="Status">${statusBadge(t.status)}</td>
      <td data-label="Actions">
        <div class="row-actions-inline">
          <button class="btn-secondary btn-sm" data-template-view="${esc(t.id)}">View</button>
          ${t.status !== 'approved' ? `<button class="btn-secondary btn-sm" data-template-action="approved" data-template-id="${esc(t.id)}" aria-label="Approve ${esc(t.name)}">Approve</button>` : ''}
          ${t.status !== 'rejected' ? `<button class="btn-secondary btn-sm" data-template-action="rejected" data-template-id="${esc(t.id)}" aria-label="Reject ${esc(t.name)}">Reject</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  const find = (id) => state.templatesReviewRows.find((t) => t.id === id);
  bindClickableRows(tbody, 'data-template-id', (id) => { const t = find(id); if (t) openTemplateReviewModal(t); });
  tbody.querySelectorAll('[data-template-view]').forEach((btn) => {
    btn.addEventListener('click', () => { const t = find(btn.getAttribute('data-template-view')); if (t) openTemplateReviewModal(t); });
  });
  tbody.querySelectorAll('[data-template-action]').forEach((btn) => {
    btn.addEventListener('click', () => { const t = find(btn.getAttribute('data-template-id')); if (t) confirmTemplateDecision(t, btn.getAttribute('data-template-action')); });
  });
}

let templateReviewCurrent = null;

function openTemplateReviewModal(t) {
  templateReviewCurrent = t;
  document.getElementById('template-review-title').textContent = t.name || 'Template';
  document.getElementById('template-review-body').innerHTML = `
    <dl class="meta-grid">
      <div><dt>Client</dt><dd>${esc(t.client_name)}</dd></div>
      <div><dt>Category</dt><dd>${esc(t.category || '—')}</dd></div>
      <div><dt>Status</dt><dd>${statusBadge(t.status)}</dd></div>
    </dl>
    <div class="form-label">Body</div>
    <div class="template-preview">${esc(t.body || '(empty)')}</div>
  `;
  document.getElementById('template-review-actions').innerHTML = `
    <button class="btn-secondary" data-close-template-review>Close</button>
    ${t.status !== 'rejected' ? '<button class="btn-secondary" id="template-review-reject-btn">Reject…</button>' : ''}
    ${t.status !== 'approved' ? '<button class="btn-primary btn-auto" id="template-review-approve-btn">Approve…</button>' : ''}
  `;
  document.querySelectorAll('#template-review-actions [data-close-template-review]').forEach((b) => b.addEventListener('click', closeTemplateReviewModal));
  document.getElementById('template-review-approve-btn')?.addEventListener('click', () => confirmTemplateDecision(t, 'approved'));
  document.getElementById('template-review-reject-btn')?.addEventListener('click', () => confirmTemplateDecision(t, 'rejected'));
  document.getElementById('template-review-modal').classList.add('open');
}

function closeTemplateReviewModal() {
  templateReviewCurrent = null;
  document.getElementById('template-review-modal').classList.remove('open');
}

function confirmTemplateDecision(t, status) {
  const approving = status === 'approved';
  const verb = approving ? 'Approve' : 'Reject';
  showConfirm({
    title: `${verb} this template?`,
    body: `
      <p>${verb} <strong>${esc(t.name)}</strong> from <strong>${esc(t.client_name)}</strong>${t.category ? ` (${esc(t.category)})` : ''}?</p>
      <div class="template-preview">${esc(t.body || '(empty)')}</div>
      <p class="muted-text">This changes the template's status in Wasi only — it does not submit anything to Meta, and no rejection reason can be recorded.</p>
    `,
    confirmLabel: verb,
    danger: !approving,
    onConfirm: async () => {
      await apiFetch(`/api/admin/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      showToast(`Template ${status}.`, 'success');
      closeTemplateReviewModal();
      loadTemplatesReview();
    },
  });
}

/* ---------------------------------------------------------------
   API Keys
   --------------------------------------------------------------- */
async function loadApiKeys() {
  setInlineError('api-keys-error', null);
  showTableLoading('api-keys-table-body', 6);

  try {
    const rows = await apiFetch('/api/admin/api-keys');
    state.apiKeyRows = rows;
    resetPage('apikeys');
    renderApiKeys();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('api-keys-table-body', 6, err.message, loadApiKeys);
  }
}

function apiKeysFiltered() {
  const q = (document.getElementById('api-keys-search')?.value || '').trim().toLowerCase();
  if (!q) return state.apiKeyRows;
  return state.apiKeyRows.filter((k) =>
    (k.client_name || '').toLowerCase().includes(q) || (k.app_name || '').toLowerCase().includes(q));
}

function renderApiKeys() {
  const tbody = document.getElementById('api-keys-table-body');
  const all = apiKeysFiltered();
  document.getElementById('api-keys-count').textContent = `${all.length} key${all.length === 1 ? '' : 's'}`;
  if (!all.length) {
    document.getElementById('api-keys-pager').hidden = true;
    tbody.innerHTML = state.apiKeyRows.length
      ? emptyRow(6, 'No keys match', 'Try a different search.', 'search-x')
      : emptyRow(6, 'No API keys issued yet', 'Create one with "New Key" or issue missing keys for every client.', 'key');
    refreshIcons();
    return;
  }
  const rows = pageSlice('apikeys', all, 25, 'api-keys-pager', renderApiKeys);
  tbody.innerHTML = rows.map((k) => `
    <tr>
      <td data-label="Client">${esc(k.client_name)}</td>
      <td data-label="App">${esc(k.app_name)}</td>
      <td data-label="Last Used">${formatDateTime(k.last_used_at)}</td>
      <td data-label="Created">${formatDate(k.created_at)}</td>
      <td data-label="Status">${k.revoked_at ? statusBadge('revoked') : statusBadge('active')}</td>
      <td data-label="Actions">
        <div class="row-actions-menu">
          <button type="button" class="row-actions-trigger" aria-haspopup="true" aria-expanded="false" data-row-menu-trigger aria-label="Actions for ${esc(k.app_name)}" title="Actions">
            <i data-lucide="more-vertical" class="icon-16"></i>
          </button>
          <div class="row-actions-popover" role="menu">
            ${!k.revoked_at ? `<button type="button" role="menuitem" data-revoke-key="${esc(k.id)}" data-revoke-client="${esc(k.client_id)}"><i data-lucide="ban" class="icon-14"></i> Revoke</button>` : ''}
            <button type="button" role="menuitem" class="danger" data-delete-key="${esc(k.id)}" data-delete-client="${esc(k.client_id)}"><i data-lucide="trash-2" class="icon-14"></i> Delete</button>
          </div>
        </div>
      </td>
    </tr>
  `).join('');
  refreshIcons();

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
        popover.querySelector('button')?.focus();
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

// The table these popovers live in is a scroll container (overflow:auto), so a
// popover positioned via the default CSS (position:absolute; right:0;
// top:calc(100% + 4px)) risks being clipped by it near its bottom/right edge.
// Reposition with position:fixed, anchored to the trigger button's live
// bounding rect, flipping above the trigger when there isn't room below.
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
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openPopover = document.querySelector('.row-actions-popover.open');
  if (!openPopover) return;
  const trigger = openPopover.previousElementSibling;
  closeAllRowActionMenus();
  trigger?.focus();
});

function confirmRevokeApiKey(keyId, clientId) {
  closeAllRowActionMenus();
  showConfirm({
    title: 'Revoke this API key?',
    body: '<p>The consuming app will immediately lose access. This cannot be undone.</p>',
    confirmLabel: 'Revoke Key',
    danger: true,
    onConfirm: async () => {
      await apiFetch(`/api/admin/api-keys/${keyId}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId }),
      });
      showToast('API key revoked.', 'success');
      loadApiKeys();
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
      await apiFetch(`/api/admin/api-keys/${keyId}`, {
        method: 'DELETE',
        body: JSON.stringify({ client_id: clientId }),
      });
      showToast('API key deleted.', 'success');
      loadApiKeys();
    },
  });
}

async function handleBackfillApiKeys() {
  const btn = document.getElementById('backfill-api-keys-btn');
  const resultEl = document.getElementById('backfill-api-keys-result');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="loader" class="icon-14 spin"></i> Issuing…';
  refreshIcons();

  try {
    const res = await apiFetch('/api/admin/api-keys/backfill', { method: 'POST' });
    resultEl.style.display = 'block';
    if (!res.issued.length) {
      resultEl.innerHTML = `<div class="inline-success">Every client already has an active key — nothing to issue (${esc(res.alreadyHadKey)} already covered).</div>`;
    } else {
      resultEl.innerHTML = `
        <div class="inline-success">
          Issued ${esc(res.issued.length)} new key(s) — ${esc(res.alreadyHadKey)} client(s) already had one and were skipped. Each key is shown once, copy them now.
        </div>
        <div class="table-card"><div class="table-scroll"><table class="data-table stack-mobile"><thead><tr><th>Client</th><th>Key</th><th><span class="sr-only">Copy</span></th></tr></thead><tbody>
          ${res.issued.map((r) => {
            const id = `secret-val-${++secretSeq}`;
            return `
            <tr>
              <td data-label="Client">${esc(r.client_name)}</td>
              <td data-label="Key" class="cell-mono cell-break" id="${id}">${esc(r.key)}</td>
              <td data-label="Copy"><button type="button" class="btn-secondary btn-sm" data-copy-value-target="${id}" aria-label="Copy key for ${esc(r.client_name)}"><i data-lucide="copy" class="icon-14"></i> Copy</button></td>
            </tr>`;
          }).join('')}
        </tbody></table></div></div>
      `;
    }
    showToast(`Backfill complete — ${res.issued.length} key(s) issued.`, 'success');
    loadApiKeys();
  } catch (err) {
    if (err.status === 401) return;
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="inline-error" role="alert">${esc(err.message)}</div>`;
    showToast('Failed to backfill API keys: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    refreshIcons();
  }
}

async function openCreateApiKeyModal() {
  pendingSecrets['create-api-key'] = false;
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
    select.innerHTML = clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  } catch (err) {
    select.innerHTML = '<option value="">Could not load clients</option>';
  }
}

function closeCreateApiKeyModal() {
  if (!guardAllowsClose('create-api-key')) return;
  pendingSecrets['create-api-key'] = false;
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
      <div class="inline-success">Key created — this is shown once. Copy it now.</div>
      ${secretRowsHtml([['API Key', created.key]])}
      ${secretsAckHtml('create-api-key')}
    `;
    refreshIcons();
    bindSecretsAck('create-api-key', closeCreateApiKeyModal);
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
  showTableLoading('tickets-table-body', 6);

  const status = document.getElementById('tickets-status-filter').value;
  try {
    const rows = await apiFetch(`/api/admin/tickets${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.ticketRows = rows;
    resetPage('tickets');
    renderTickets();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('tickets-table-body', 6, err.message, loadTickets);
  }
}

function ticketsFiltered() {
  const q = (document.getElementById('tickets-search')?.value || '').trim().toLowerCase();
  if (!q) return state.ticketRows;
  return state.ticketRows.filter((t) =>
    (t.client_name || '').toLowerCase().includes(q) ||
    (t.subject || '').toLowerCase().includes(q) ||
    (t.message || '').toLowerCase().includes(q));
}

function renderTickets() {
  const tbody = document.getElementById('tickets-table-body');
  const all = ticketsFiltered();
  document.getElementById('tickets-count').textContent = `${all.length} ticket${all.length === 1 ? '' : 's'}`;
  if (!all.length) {
    document.getElementById('tickets-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No tickets match', 'Client-reported issues appear here.', 'life-buoy');
    refreshIcons();
    return;
  }
  const rows = pageSlice('tickets', all, 20, 'tickets-pager', renderTickets);
  tbody.innerHTML = rows.map((t) => `
    <tr>
      <td data-label="Client">${esc(t.client_name)}</td>
      <td data-label="Subject">${esc(t.subject)}</td>
      <td data-label="Message"><div class="cell-clamp" title="${esc(t.message)}">${esc(t.message)}</div></td>
      <td data-label="Status">${statusBadge(t.status)}</td>
      <td data-label="Created">${formatDateTime(t.created_at)}</td>
      <td data-label="Update status">
        <select class="form-input" data-ticket-status-select="${esc(t.id)}" aria-label="Status for ticket ${esc(t.subject)}">
          ${TICKET_STATUS_OPTIONS.map((s) => `<option value="${esc(s)}" ${s === t.status ? 'selected' : ''}>${esc(s.replace('_', ' '))}</option>`).join('')}
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
    renderTickets();
  } catch (err) {
    if (err.status === 401) return;
    showToast('Failed to update ticket: ' + err.message, 'error');
    loadTickets();
  }
}

/* ---------------------------------------------------------------
   Team
   --------------------------------------------------------------- */
async function loadTeam() {
  setInlineError('team-error', null);
  showTableLoading('team-table-body', 4);

  try {
    const rows = await apiFetch('/api/admin/admin-users');
    state.teamRows = rows;
    renderTeam(rows);
  } catch (err) {
    if (err.status === 401) return;
    showTableError('team-table-body', 4, err.message, loadTeam);
  }
}

function renderTeam(rows) {
  const tbody = document.getElementById('team-table-body');
  if (!rows.length) {
    tbody.innerHTML = emptyRow(4, 'No admin users yet', 'Invite a teammate to share access.', 'users-round');
    refreshIcons();
    return;
  }
  tbody.innerHTML = rows.map((a) => `
    <tr>
      <td data-label="Name">${esc(a.name)}</td>
      <td data-label="Email">${esc(a.email)}</td>
      <td data-label="Role">${badge(titleCase(a.role || ''), a.role === 'super_admin' ? 'info' : 'neutral')}</td>
      <td data-label="Created">${formatDate(a.created_at)}</td>
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
  content.innerHTML = '<div class="detail-grid"><div class="detail-card"><span class="skeleton skel-line"></span></div><div class="detail-card"><span class="skeleton skel-line"></span></div></div>';

  try {
    const settings = await apiFetch('/api/admin/settings');
    renderSettings(settings);
  } catch (err) {
    if (err.status === 401) return;
    content.innerHTML = '';
    setInlineError('settings-error', err.message, loadSettings);
  }
}

// Meta Official Template Library (wasi-master-plan.md §2b) — server-wide
// cache status, not per-client settings, so it's a separate card/call from
// loadSettings above rather than folded into GET /api/admin/settings' shape.
async function loadMetaTemplateLibraryStatus() {
  setInlineError('meta-template-library-error', null);
  const el = document.getElementById('meta-template-library-status');
  try {
    const status = await apiFetch('/api/admin/template-library/meta/status');
    const lastRefreshed = status.last_refreshed_at
      ? new Date(status.last_refreshed_at).toLocaleString()
      : 'Never';
    el.innerHTML = `
      Last refreshed: <strong>${esc(lastRefreshed)}</strong>
      &middot; ${esc(status.cached_zero_variable_count)} usable (variable-free) of ${esc(status.cached_total_count)} cached Utility entries
      ${status.last_refresh_error ? `<div class="inline-error" role="alert" style="margin-top:0.6rem; margin-bottom:0;">Last refresh error: ${esc(status.last_refresh_error)}</div>` : ''}
    `;
  } catch (err) {
    if (err.status === 401) return;
    el.textContent = '';
    setInlineError('meta-template-library-error', err.message, loadMetaTemplateLibraryStatus);
  }
}

function configPill(ok, okLabel, missingLabel) {
  return ok ? badge(okLabel, 'success') : badge(missingLabel, 'danger');
}

function renderSettings(settings) {
  document.getElementById('settings-content').innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <h2 class="detail-card-title">Meta / WhatsApp Embedded Signup</h2>
        ${detailRow('App configured', configPill(settings.meta.configured, 'Configured', 'Not configured'))}
        ${detailRow('Graph API version', esc(settings.meta.graphApiVersion || '—'))}
        ${detailRow('Webhook verify token', configPill(settings.meta.webhookVerifyTokenSet, 'Set', 'Not set'))}
      </div>
      <div class="detail-card">
        <h2 class="detail-card-title">Razorpay Billing</h2>
        ${detailRow('API keys configured', configPill(settings.razorpay.configured, 'Configured', 'Not configured'))}
        ${detailRow('Webhook secret', configPill(settings.razorpay.webhookSecretSet, 'Set', 'Not set'))}
      </div>
      <div class="detail-card">
        <h2 class="detail-card-title">Secret Hygiene</h2>
        ${detailRow('Login token secret <span class="cell-secondary">(JWT_SECRET)</span>', configPill(!settings.secrets.jwtSecretIsDefault, 'Rotated', 'Still default — rotate before real deploy'), true)}
        ${detailRow('Encryption secret <span class="cell-secondary">(SERVER_SECRET)</span>', configPill(!settings.secrets.serverSecretIsDefault, 'Rotated', 'Still default — rotate before real deploy'), true)}
      </div>
      <div class="detail-card">
        <h2 class="detail-card-title">Plan Pricing (INR/mo)</h2>
        ${settings.plans.map((p) => detailRow(esc(p.id), `₹${esc(p.price_inr)}${p.conversation_limit ? ` · ${esc(p.conversation_limit)}/mo` : ' · unlimited'}`)).join('')}
      </div>
    </div>
    <div class="alert alert-info">
      <span>Real secret values are never sent to this panel — this page only reports whether each is set. Change them in the server's environment configuration (<code>server/.env</code>).</span>
    </div>
  `;
}

/* ---------------------------------------------------------------
   Audit Log
   --------------------------------------------------------------- */
async function loadAuditLog(clientId) {
  setInlineError('audit-error', null);
  showTableLoading('audit-table-body', 6);

  const path = clientId
    ? `/api/admin/audit-log?client_id=${encodeURIComponent(clientId)}`
    : '/api/admin/audit-log';

  try {
    const rows = await apiFetch(path);
    state.auditRows = rows;
    resetPage('audit');
    renderAuditTable();
  } catch (err) {
    if (err.status === 401) return;
    showTableError('audit-table-body', 6, err.message, () => loadAuditLog(clientId));
  }
}

function renderAuditTable() {
  const tbody = document.getElementById('audit-table-body');
  const all = state.auditRows;
  document.getElementById('audit-count').textContent = `${all.length} entr${all.length === 1 ? 'y' : 'ies'}`;
  if (!all.length) {
    document.getElementById('audit-pager').hidden = true;
    tbody.innerHTML = emptyRow(6, 'No audit log entries', 'Nothing matches this filter.', 'scroll-text');
    refreshIcons();
    return;
  }
  const rows = pageSlice('audit', all, 25, 'audit-pager', renderAuditTable);
  tbody.innerHTML = rows.map((a) => `
    <tr>
      <td data-label="Actor Type">${esc(a.actor_type)}</td>
      <td data-label="Actor ID" class="cell-mono cell-break">${esc(a.actor_id || '—')}</td>
      <td data-label="Action">${esc(a.action)}</td>
      <td data-label="Target" class="cell-wrap cell-break">${esc(a.target || '—')}</td>
      <td data-label="IP" class="cell-mono">${esc(a.actor_ip || '—')}</td>
      <td data-label="Timestamp">${formatDateTime(a.created_at)}</td>
    </tr>
  `).join('');
}

/* ---------------------------------------------------------------
   Wiring / init
   --------------------------------------------------------------- */
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function initEventListeners() {
  setupModalAccessibility();

  on('login-form', 'submit', handleLoginSubmit);

  on('toggle-password-btn', 'click', () => {
    const input = document.getElementById('login-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  on('logout-btn', 'click', handleLogout);
  on('logout-btn', 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }
  });

  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    const go = () => {
      switchView(item.getAttribute('data-view'));
      focusViewHeading();
    };
    item.addEventListener('click', go);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
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
      toggleBtn.setAttribute('aria-expanded', 'false');
    };
    const openSidebar = () => {
      sidebar.classList.add('mobile-open');
      backdrop.classList.add('visible');
      toggleBtn.setAttribute('aria-expanded', 'true');
    };

    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.addEventListener('click', () => {
      if (sidebar.classList.contains('mobile-open')) closeSidebar();
      else openSidebar();
    });
    backdrop.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('mobile-open')) { closeSidebar(); toggleBtn.focus(); }
    });
    document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
      item.addEventListener('click', closeSidebar);
    });
  })();

  on('back-to-clients-btn', 'click', () => switchView('clients'));

  on('clients-search', 'input', () => { resetPage('clients'); filterClientsTable(); });
  on('clients-status-filter', 'change', () => {
    resetPage('clients');
    filterClientsTable();
    writeHash('clients', 'replace');
  });

  // Tabs (Statistics, Health). Client detail's tablist is created per render.
  const statsTabs = document.querySelector('#view-statistics [role="tablist"]');
  if (statsTabs) initTablist(statsTabs, selectStatisticsTab);
  const healthTabs = document.querySelector('#view-health [role="tablist"]');
  if (healthTabs) initTablist(healthTabs, selectHealthTab);

  on('statistics-range-select', 'change', () => loadStatisticsTab(state.viewTab.statistics));
  on('refresh-statistics-btn', 'click', () => loadStatisticsTab(state.viewTab.statistics));
  on('statistics-webhook-failures-link', 'click', (e) => {
    e.preventDefault();
    switchView('failures');
  });

  on('open-create-client-btn', 'click', openCreateClientModal);
  document.querySelectorAll('[data-close-create-client]').forEach((btn) => btn.addEventListener('click', closeCreateClientModal));
  on('create-client-modal', 'click', (e) => {
    if (e.target.id === 'create-client-modal') closeCreateClientModal();
  });
  on('create-client-form', 'submit', handleCreateClientSubmit);
  on('generate-client-password-btn', 'click', generateClientPassword);

  on('refresh-dashboard-btn', 'click', loadDashboard);
  on('refresh-onboarding-btn', 'click', loadOnboarding);
  on('refresh-wabas-btn', 'click', loadWabas);
  on('refresh-platform-overview-btn', 'click', loadPlatformOverview);
  on('refresh-health-monitor-btn', 'click', loadHealthMonitor);
  on('pr-refresh-btn', 'click', () => loadPaymentReminders());
  on('pr-export-btn', 'click', exportPaymentRemindersCsv);
  on('pr-sched-add-btn', 'click', addPaymentSchedule);
  on('pr-send-all-btn', 'click', confirmSendRemindersToAllActive);
  on('pr-filter-status', 'change', () => loadPaymentReminders());
  on('pr-filter-kind', 'change', () => loadPaymentReminders());
  on('pr-filter-search', 'input', () => { resetPage('pr'); renderPaymentReminders(); });
  on('send-test-alert-btn', 'click', sendTestAlert);
  on('refresh-volume-btn', 'click', loadVolume);
  on('refresh-failures-btn', 'click', loadFailures);
  on('refresh-audit-btn', 'click', () => {
    document.getElementById('audit-client-filter').value = '';
    loadAuditLog();
  });

  on('refresh-billing-btn', 'click', loadBilling);

  on('refresh-templates-review-btn', 'click', loadTemplatesReview);
  on('templates-review-status-filter', 'change', loadTemplatesReview);
  on('templates-review-search', 'input', () => { resetPage('templates'); renderTemplatesReview(); });
  document.querySelectorAll('[data-close-template-review]').forEach((btn) => btn.addEventListener('click', closeTemplateReviewModal));
  on('template-review-modal', 'click', (e) => {
    if (e.target.id === 'template-review-modal') closeTemplateReviewModal();
  });

  on('refresh-tickets-btn', 'click', loadTickets);
  on('tickets-status-filter', 'change', loadTickets);
  on('tickets-search', 'input', () => { resetPage('tickets'); renderTickets(); });

  on('open-create-api-key-btn', 'click', openCreateApiKeyModal);
  on('backfill-api-keys-btn', 'click', handleBackfillApiKeys);
  on('api-keys-search', 'input', () => { resetPage('apikeys'); renderApiKeys(); });
  document.querySelectorAll('[data-close-create-api-key]').forEach((btn) => btn.addEventListener('click', closeCreateApiKeyModal));
  on('create-api-key-modal', 'click', (e) => {
    if (e.target.id === 'create-api-key-modal') closeCreateApiKeyModal();
  });
  on('create-api-key-form', 'submit', handleCreateApiKeySubmit);

  on('open-invite-admin-btn', 'click', openInviteAdminModal);
  document.querySelectorAll('[data-close-invite-admin]').forEach((btn) => btn.addEventListener('click', closeInviteAdminModal));
  on('invite-admin-modal', 'click', (e) => {
    if (e.target.id === 'invite-admin-modal') closeInviteAdminModal();
  });
  on('invite-admin-form', 'submit', handleInviteAdminSubmit);

  on('refresh-settings-btn', 'click', loadSettings);
  on('refresh-meta-template-library-btn', 'click', async () => {
    setInlineError('meta-template-library-error', null);
    const btn = document.getElementById('refresh-meta-template-library-btn');
    btn.disabled = true;
    try {
      await apiFetch('/api/admin/template-library/meta/refresh', { method: 'POST' });
      await loadMetaTemplateLibraryStatus();
    } catch (err) {
      if (err.status === 401) return;
      setInlineError('meta-template-library-error', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const auditFilterInput = document.getElementById('audit-client-filter');
  let auditFilterTimer = null;
  auditFilterInput.addEventListener('input', () => {
    clearTimeout(auditFilterTimer);
    auditFilterTimer = setTimeout(() => {
      const val = auditFilterInput.value.trim();
      loadAuditLog(val || undefined);
    }, 400);
  });
  on('audit-clear-filter-btn', 'click', () => {
    auditFilterInput.value = '';
    loadAuditLog();
  });

  document.querySelectorAll('[data-close-confirm]').forEach((btn) => {
    btn.addEventListener('click', closeConfirm);
  });
  on('confirm-modal', 'click', (e) => {
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
        showLoginView();
        setInlineError('login-error', 'Could not reach the admin API to verify your session. Please sign in again.');
      }
    });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  refreshIcons();
  restoreSession();
});
