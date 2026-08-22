// Thin fetch wrapper — same shape as app.js's authFetch (Bearer token from
// localStorage, JSON in/out) since this page is served same-origin and
// shares the same client_token key. No API_BASE branching (unlike app.js)
// — that only exists there for the main app's local split-origin dev
// setup; this page is only ever tested served through Express itself
// (createApp(), matching every other local verification this session),
// where relative /api/... paths are always correct.
function request(path, options = {}) {
  const token = localStorage.getItem('client_token');
  return fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  });
}

export const api = {
  getFlow: (flowId) => request(`/automation-flows/${flowId}`),
  patchFlow: (flowId, data) => request(`/automation-flows/${flowId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  createNode: (flowId, data) => request(`/automation-flows/${flowId}/nodes`, { method: 'POST', body: JSON.stringify(data) }),
  patchNode: (flowId, nodeId, data) => request(`/automation-flows/${flowId}/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNode: (flowId, nodeId) => request(`/automation-flows/${flowId}/nodes/${nodeId}`, { method: 'DELETE' }),
  setEntry: (flowId, nodeId) => request(`/automation-flows/${flowId}`, { method: 'PATCH', body: JSON.stringify({ entry_node_id: nodeId }) }),
  createEdge: (flowId, data) => request(`/automation-flows/${flowId}/edges`, { method: 'POST', body: JSON.stringify(data) }),
  deleteEdge: (flowId, edgeId) => request(`/automation-flows/${flowId}/edges/${edgeId}`, { method: 'DELETE' }),
  listTemplates: () => request('/templates'),
  listTags: () => request('/tags'),
};
