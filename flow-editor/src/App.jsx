import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import { api } from './api.js';
import { PALETTE_ITEMS } from './constants.js';
import FlowNodeCard from './FlowNodeCard.jsx';
import ConditionEdge from './ConditionEdge.jsx';
import AddNodeMenu from './AddNodeMenu.jsx';

const nodeTypes = { flowCard: FlowNodeCard };
const edgeTypes = { condition: ConditionEdge };

function fallbackPosition(index) {
  return { x: 80 + (index % 4) * 280, y: 80 + Math.floor(index / 4) * 260 };
}

function IssuesBanner({ issues }) {
  if (!issues.length) return null;
  return (
    <div className="wf-issues-banner">
      <b>{issues.length} issue{issues.length === 1 ? '' : 's'} found</b> — these would fail or misbehave at
      runtime and block activating this flow.
    </div>
  );
}

function FlowEditor() {
  const params = new URLSearchParams(window.location.search);
  const flowId = params.get('flow');
  const { screenToFlowPosition } = useReactFlow();

  const [graph, setGraph] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [tags, setTags] = useState([]);
  const [rule, setRule] = useState(null);
  const [triggerInput, setTriggerInput] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [pendingConnection, setPendingConnection] = useState(null); // {fromNodeId, fromHandle, screenX, screenY}
  const connectingRef = useRef(null);

  const load = useCallback(() => {
    if (!flowId) { setStatus('error'); setError('No ?flow=<id> in the URL.'); return; }
    setStatus('loading');
    Promise.all([api.getFlow(flowId), api.listTemplates(), api.listTags(), api.listRulesForFlow(flowId)])
      .then(([g, t, tg, rules]) => {
        setGraph(g);
        setTemplates(t);
        setTags(tg);
        const linkedRule = rules[0] || null;
        setRule(linkedRule);
        setTriggerInput(linkedRule?.trigger || '');
        setStatus('ready');
      })
      .catch((err) => { setError(err.message); setStatus('error'); });
  }, [flowId]);

  useEffect(() => { load(); }, [load]);

  // --- Mutations — every one reloads the whole graph afterward, same
  // "one action, one round trip" shape the step-list editor already uses,
  // so canvas and list never drift (both read the same REST endpoints). ---

  const handleConfigChange = useCallback(async (nodeId, config) => {
    try { await api.patchNode(flowId, nodeId, { config }); load(); }
    catch (err) { setError(err.message); }
  }, [flowId, load]);

  const handleDeleteNode = useCallback(async (nodeId) => {
    try { await api.deleteNode(flowId, nodeId); load(); }
    catch (err) {
      // The server's real FK guard (contact_flow_state.current_node_id) —
      // surfaced plainly rather than the raw "Invalid reference" text, per
      // the crash-fix work: a contact is genuinely standing on this node.
      setError(err.status === 400 ? 'Cannot delete — a contact is currently on this node.' : err.message);
    }
  }, [flowId, load]);

  const handleSetEntry = useCallback(async (nodeId) => {
    try { await api.setEntry(flowId, nodeId); load(); }
    catch (err) { setError(err.message); }
  }, [flowId, load]);

  const handleDeleteEdge = useCallback(async (edgeId) => {
    try { await api.deleteEdge(flowId, edgeId); load(); }
    catch (err) { setError(err.message); }
  }, [flowId, load]);

  const handleAddBranch = useCallback(async (fromNodeId, conditionType, toNodeId, conditionValue) => {
    try {
      await api.createEdge(flowId, { from_node_id: fromNodeId, to_node_id: toNodeId, condition_type: conditionType, ...(conditionValue ? { condition_value: conditionValue } : {}) });
      load();
    } catch (err) { setError(err.message); }
  }, [flowId, load]);

  const handleSaveTrigger = useCallback(async () => {
    const value = triggerInput.trim();
    if (!value) return;
    try {
      const saved = rule
        ? await api.updateRule(rule.id, { trigger: value })
        : await api.createRule({ title: graph.name, trigger: value, flow_id: flowId });
      setRule(saved);
      setError(null);
    } catch (err) { setError(err.message); }
  }, [rule, graph, flowId, triggerInput]);

  const toggleActive = useCallback(async () => {
    if (!graph) return;
    try {
      await api.patchFlow(flowId, { status: graph.status === 'active' ? 'archived' : 'active' });
      load();
    } catch (err) {
      // 409 here is the validator's own block (routes/automationFlows.js)
      // — its message is already specific per-issue text, safe to show raw.
      setError(err.body?.error || err.message);
    }
  }, [flowId, graph, load]);

  // --- Derive React Flow nodes/edges from the loaded graph. ---
  useEffect(() => {
    if (!graph) return;
    const issuesByNode = {};
    (graph.issues || []).forEach((iss) => { if (iss.nodeId) (issuesByNode[iss.nodeId] = issuesByNode[iss.nodeId] || []).push(iss); });
    const edgesByFrom = {};
    graph.edges.forEach((e) => { (edgesByFrom[e.from_node_id] = edgesByFrom[e.from_node_id] || []).push(e); });

    setNodes(graph.nodes.map((n, i) => ({
      id: n.id,
      type: 'flowCard',
      position: n.position || fallbackPosition(i),
      data: {
        node: n,
        isEntry: n.id === graph.entry_node_id,
        issues: issuesByNode[n.id] || [],
        outgoingEdges: edgesByFrom[n.id] || [],
        otherNodes: graph.nodes.filter((x) => x.id !== n.id),
        templates,
        tags,
        onConfigChange: (config) => handleConfigChange(n.id, config),
        onDelete: () => handleDeleteNode(n.id),
        onSetEntry: () => handleSetEntry(n.id),
        onAddBranch: (conditionType, toNodeId, conditionValue) => handleAddBranch(n.id, conditionType, toNodeId, conditionValue),
        onDeleteEdge: handleDeleteEdge,
      },
    })));

    setEdges(graph.edges.map((e) => ({
      id: e.id,
      source: e.from_node_id,
      target: e.to_node_id,
      sourceHandle: e.condition_type === 'button_id' ? `button-${e.condition_value}` : 'always',
      targetHandle: 'target',
      type: 'condition',
      data: { conditionType: e.condition_type, conditionValue: e.condition_value, onDelete: handleDeleteEdge },
    })));
  }, [graph, templates, tags, setNodes, setEdges, handleConfigChange, handleDeleteNode, handleSetEntry, handleAddBranch, handleDeleteEdge]);

  // --- Connect: drag from a handle to another node's target. ---
  const onConnect = useCallback(async (connection) => {
    const fromNode = graph.nodes.find((n) => n.id === connection.source);
    const isButtonHandle = (connection.sourceHandle || '').startsWith('button-');
    const conditionType = isButtonHandle ? 'button_id' : 'always';
    const conditionValue = isButtonHandle ? connection.sourceHandle.replace('button-', '') : undefined;

    if (conditionType === 'always') {
      const existing = graph.edges.find((e) => e.from_node_id === fromNode.id && e.condition_type === 'always');
      if (existing) { setError('This node already has an outgoing branch — delete it before adding a new one.'); return; }
    }
    try {
      await api.createEdge(flowId, { from_node_id: connection.source, to_node_id: connection.target, condition_type: conditionType, ...(conditionValue ? { condition_value: conditionValue } : {}) });
      load();
    } catch (err) { setError(err.message); }
  }, [flowId, graph, load]);

  // --- Drag a connection to empty canvas -> prompt for a new node type
  // (n8n/AiSensy's "stretch a thread" pattern, confirmed in this session's
  // own research). onConnectStart records where the drag began; onConnectEnd
  // checks whether it ended on a real target (a .react-flow__handle under
  // the pointer) — if not, opens the type picker at that screen position. ---
  const onConnectStart = useCallback((_event, params) => { connectingRef.current = params; }, []);
  const onConnectEnd = useCallback((event) => {
    const target = event.target;
    const droppedOnPane = target?.classList?.contains('react-flow__pane');
    if (droppedOnPane && connectingRef.current?.nodeId) {
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      setPendingConnection({ fromNodeId: connectingRef.current.nodeId, fromHandle: connectingRef.current.handleId, screenX: point.clientX, screenY: point.clientY });
    }
    connectingRef.current = null;
  }, []);

  const pickNodeForConnection = useCallback(async (paletteItem) => {
    if (!pendingConnection) return;
    const flowPos = screenToFlowPosition({ x: pendingConnection.screenX, y: pendingConnection.screenY });
    try {
      const newNode = await api.createNode(flowId, { type: paletteItem.type, config: paletteItem.defaultConfig, position: flowPos });
      const isButtonHandle = (pendingConnection.fromHandle || '').startsWith('button-');
      await api.createEdge(flowId, {
        from_node_id: pendingConnection.fromNodeId,
        to_node_id: newNode.id,
        condition_type: isButtonHandle ? 'button_id' : 'always',
        ...(isButtonHandle ? { condition_value: pendingConnection.fromHandle.replace('button-', '') } : {}),
      });
      setPendingConnection(null);
      load();
    } catch (err) { setError(err.message); setPendingConnection(null); }
  }, [pendingConnection, flowId, screenToFlowPosition, load]);

  // --- Palette drag-and-drop onto the canvas. ---
  const onDragOver = useCallback((event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }, []);
  const onDrop = useCallback(async (event) => {
    event.preventDefault();
    const paletteId = event.dataTransfer.getData('application/wasi-node-type');
    const item = PALETTE_ITEMS.find((p) => p.paletteId === paletteId);
    if (!item) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    try { await api.createNode(flowId, { type: item.type, config: item.defaultConfig, position }); load(); }
    catch (err) { setError(err.message); }
  }, [flowId, screenToFlowPosition, load]);

  const onNodeDragStop = useCallback(async (_event, node) => {
    try { await api.patchNode(flowId, node.id, { position: { x: node.position.x, y: node.position.y } }); }
    catch (err) { setError(err.message); }
  }, [flowId]);

  const onEdgesDelete = useCallback((deleted) => {
    deleted.forEach((e) => handleDeleteEdge(e.id));
  }, [handleDeleteEdge]);

  if (status === 'loading') return <div className="wf-loading">Loading…</div>;
  if (status === 'error') {
    return (
      <div className="wf-loading wf-error">
        <b>Error:</b> {error}
        {!flowId && <div style={{ marginTop: 8 }}>Open as <code>/flow-editor/?flow=&lt;id&gt;</code> while logged into the main app.</div>}
      </div>
    );
  }

  const blocksActivation = graph.status !== 'active' && (graph.issues || []).length > 0;

  return (
    <div className="wf-shell">
      <div className="wf-topbar">
        <b>{graph.name}</b>
        <span className={`wf-status-badge ${graph.status === 'active' ? 'active' : ''}`}>{graph.status}</span>
        <button type="button" className="wf-btn-primary" disabled={blocksActivation} onClick={toggleActive} title={blocksActivation ? 'Fix all issues before activating' : ''}>
          {graph.status === 'active' ? 'Archive Flow' : 'Activate Flow'}
        </button>
        {error && <span className="wf-error-toast">{error} <button onClick={() => setError(null)}>&times;</button></span>}
      </div>
      <div className="wf-trigger-bar">
        <label htmlFor="wf-trigger-input">Trigger keyword</label>
        <input
          id="wf-trigger-input"
          type="text"
          value={triggerInput}
          onChange={(e) => setTriggerInput(e.target.value)}
          placeholder="e.g. hours"
        />
        <button
          type="button"
          className="wf-btn-secondary"
          disabled={!triggerInput.trim() || triggerInput.trim() === (rule?.trigger || '')}
          onClick={handleSaveTrigger}
        >
          {rule ? 'Update Trigger' : 'Set Trigger'}
        </button>
        {rule && <span className="wf-trigger-hint">Starts this flow when a message contains "{rule.trigger}"</span>}
      </div>
      <IssuesBanner issues={graph.issues || []} />
      <div className="wf-body">
        <aside className="wf-palette">
          <div className="wf-palette-title">Add a node</div>
          {PALETTE_ITEMS.map((item) => (
            <div
              key={item.paletteId}
              className="wf-palette-item"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/wasi-node-type', item.paletteId)}
            >
              {item.label}
            </div>
          ))}
        </aside>
        <div className="wf-canvas" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeDragStop={onNodeDragStop}
            onEdgesDelete={onEdgesDelete}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
          {pendingConnection && (
            <AddNodeMenu
              x={pendingConnection.screenX}
              y={pendingConnection.screenY}
              onPick={pickNodeForConnection}
              onClose={() => setPendingConnection(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <FlowEditor />
    </ReactFlowProvider>
  );
}
