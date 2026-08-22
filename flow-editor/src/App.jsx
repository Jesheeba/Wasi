import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';

// Stage 1 spike only — proves the chosen stack (React + React Flow, built
// via the new flow-editor-build Dockerfile stage) can do the three things
// the staged plan named as the gate: create a node, connect two, save
// positions, against the REAL existing REST API (server/src/routes/
// automationFlows.js), not a mock. Deliberately not the real palette,
// node-type config forms, validator-on-nodes, or six-edge fan-out design —
// those are Stages 2-4, on top of whatever this proves out.
//
// Served same-origin as the main app (server/src/app.js's /flow-editor
// static mount) — client_token in localStorage is already there once
// logged into the main CRM in the same browser, no separate auth needed.

function apiFetch(path, options = {}) {
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
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.status === 204 ? null : res.json();
  });
}

// Same fallback used by the read-only canvas (app.js's computeFlowLayout)
// isn't imported here on purpose — this spike doesn't need a real layout
// algorithm, just SOMETHING so nodes with no stored position aren't all
// stacked at (0,0). A flat grid is enough to prove drag+save works.
function fallbackPosition(index) {
  return { x: 80 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 140 };
}

function graphToNodes(graph) {
  return graph.nodes.map((n, i) => ({
    id: n.id,
    position: n.position || fallbackPosition(i),
    data: { label: `${n.type}${n.config?.body ? `\n${String(n.config.body).slice(0, 40)}` : ''}` },
    style: { whiteSpace: 'pre-line', fontSize: 12, padding: 8, border: '1px solid #333', borderRadius: 8 },
  }));
}

function graphToEdges(graph) {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from_node_id,
    target: e.to_node_id,
    label: e.condition_type,
  }));
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const flowId = params.get('flow');

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [flowName, setFlowName] = useState('');

  const load = useCallback(() => {
    if (!flowId) {
      setStatus('error');
      setError('No ?flow=<id> in the URL.');
      return;
    }
    setStatus('loading');
    apiFetch(`/automation-flows/${flowId}`)
      .then((graph) => {
        setFlowName(graph.name);
        setNodes(graphToNodes(graph));
        setEdges(graphToEdges(graph));
        setStatus('ready');
      })
      .catch((err) => {
        setError(err.message);
        setStatus('error');
      });
  }, [flowId, setNodes, setEdges]);

  useEffect(() => { load(); }, [load]);

  // Create: reuses the existing POST .../nodes endpoint exactly like the
  // step-list editor's "Add Node" does (app.js) — a plain send_text node,
  // minimal config, since node-type/config authoring is Stage 4, not this
  // spike. Refetches afterward rather than optimistically patching local
  // state, same "one action, one round trip" shape every mutation in this
  // codebase already uses.
  const addNode = useCallback(async () => {
    try {
      await apiFetch(`/automation-flows/${flowId}/nodes`, {
        method: 'POST',
        body: JSON.stringify({ type: 'send_text', config: { body: 'New node (spike)' } }),
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  }, [flowId, load]);

  // Connect: React Flow's onConnect fires with {source, target}. Posts a
  // real edge via the existing POST .../edges endpoint — condition_type
  // 'always' is the only legal type for a send_text source node
  // (flowEngine.js's LEGAL_EDGE_TYPES_BY_NODE_TYPE); picking any other type
  // here is Stage 3's problem (condition-type selection UI), not this
  // spike's.
  const onConnect = useCallback(
    async (connection) => {
      try {
        await apiFetch(`/automation-flows/${flowId}/edges`, {
          method: 'POST',
          body: JSON.stringify({
            from_node_id: connection.source,
            to_node_id: connection.target,
            condition_type: 'always',
          }),
        });
        load();
      } catch (err) {
        setError(err.message);
      }
    },
    [flowId, load]
  );

  // Save position: commit on drag-END only, one PATCH per node, never
  // mid-drag — matches the migration/coexistence investigation's explicit
  // recommendation (position is cosmetic, flowEngine.js never reads it,
  // but last-write-wins is fine and streaming it would just be noise).
  const onNodeDragStop = useCallback(
    async (_event, node) => {
      try {
        await apiFetch(`/automation-flows/${flowId}/nodes/${node.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ position: { x: node.position.x, y: node.position.y } }),
        });
      } catch (err) {
        setError(err.message);
      }
    },
    [flowId]
  );

  if (status === 'loading') {
    return <div style={{ padding: 20, fontFamily: 'sans-serif' }}>Loading…</div>;
  }
  if (status === 'error') {
    return (
      <div style={{ padding: 20, fontFamily: 'sans-serif', color: '#a4402f' }}>
        <b>Error:</b> {error}
        {!flowId && (
          <div style={{ marginTop: 8, color: '#333' }}>
            Open this page as <code>/flow-editor/?flow=&lt;a real automation_flows.id&gt;</code> while logged
            into the main app in the same browser (this page reads its auth token from localStorage).
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #ddd', display: 'flex', alignItems: 'center', gap: 12 }}>
        <b>Flow editor spike — {flowName}</b>
        {error && <span style={{ color: '#a4402f', fontSize: 13 }}>{error}</span>}
        <button onClick={addNode} style={{ marginLeft: 'auto' }}>+ Add node</button>
      </div>
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
}
