import { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { CONDITION_COLORS, FLOW_EDGE_TYPE_LABELS, NODE_TYPE_LABELS } from './constants.js';

// Debounces text-field edits before PATCHing — AiSensy's cards save as you
// type (visible via the live char counts), but firing one PATCH per
// keystroke against a real API is wasteful; 500ms after the last keystroke
// matches how a human perceives "I stopped typing" without feeling laggy.
function useDebouncedCommit(value, onCommit, delay = 500) {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  useEffect(() => { setLocal(value); }, [value]);
  const onChange = (next) => {
    setLocal(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(next), delay);
  };
  return [local, onChange];
}

function CharCount({ value, max }) {
  return <span className="wf-charcount">{(value || '').length}/{max}</span>;
}

function BranchRow({ edge, targetLabel, onDelete }) {
  return (
    <div className="wf-branch-row">
      <span className="wf-branch-dot" style={{ background: CONDITION_COLORS[edge.condition_type] }} />
      <span className="wf-branch-label">
        {FLOW_EDGE_TYPE_LABELS[edge.condition_type]}{edge.condition_value ? ` "${edge.condition_value}"` : ''} &rarr; {targetLabel}
      </span>
      <button type="button" className="wf-branch-delete" onClick={onDelete} title="Remove branch">&times;</button>
    </div>
  );
}

// AddBranchControl — the non-drag path for keyword/default/timeout edges
// off a send_interactive_buttons node (button_id edges are drawn by
// dragging from each button's own handle instead; see the node body
// below). A fixed number of draggable handles doesn't make sense for
// these three types since there's no natural 1:1 anchor the way a button
// has — a small inline target picker is simpler and just as correct.
function AddBranchControl({ conditionType, otherNodes, onAdd }) {
  const [targetId, setTargetId] = useState('');
  const [keyword, setKeyword] = useState('');
  if (!otherNodes.length) return null;
  return (
    <div className="wf-add-branch nodrag">
      <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="wf-select-sm">
        <option value="">{FLOW_EDGE_TYPE_LABELS[conditionType]} goes to…</option>
        {otherNodes.map((n) => <option key={n.id} value={n.id}>{NODE_TYPE_LABELS[n.type]} — {n.id.slice(0, 8)}</option>)}
      </select>
      {conditionType === 'keyword' && (
        <input className="wf-input-sm" placeholder="keyword" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      )}
      <button
        type="button"
        className="wf-btn-sm"
        disabled={!targetId || (conditionType === 'keyword' && !keyword.trim())}
        onClick={() => { onAdd(targetId, conditionType === 'keyword' ? keyword.trim() : undefined); setTargetId(''); setKeyword(''); }}
      >
        +
      </button>
    </div>
  );
}

// The card itself — one component handles every node type, branching on
// data.node.type for which fields to show. AiSensy-style: fields are
// edited directly on the card (Header/Body/Footer-shaped inputs with live
// char counts), not in a separate modal — this is Stage 4's whole point.
export default function FlowNodeCard({ id, data, selected }) {
  const { node, isEntry, issues, outgoingEdges, otherNodes, templates, tags, onConfigChange, onDelete, onSetEntry, onAddBranch, onDeleteEdge } = data;
  const cfg = node.config || {};

  const [body, setBody] = useDebouncedCommit(cfg.body || '', (v) => onConfigChange({ ...cfg, body: v }));

  const hasIssue = issues && issues.length > 0;
  const alwaysEdge = outgoingEdges.find((e) => e.condition_type === 'always');
  const showAlwaysHandle = ['send_text', 'send_template', 'delay', 'action'].includes(node.type) && !alwaysEdge;

  const nodeLabel = (n) => (n ? `${NODE_TYPE_LABELS[n.type]} — ${n.id.slice(0, 8)}` : '—');
  const findNode = (nid) => otherNodes.find((n) => n.id === nid) || (n => (n && n.id === node.id ? node : null))(node);

  return (
    <div className={`wf-card ${hasIssue ? 'wf-card-issue' : ''} ${isEntry ? 'wf-card-entry' : ''} ${selected ? 'wf-card-selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="target" style={{ background: '#666' }} />

      <div className="wf-card-header">
        {isEntry && <span className="wf-entry-badge">ENTRY</span>}
        <span className="wf-card-type">{NODE_TYPE_LABELS[node.type]}</span>
        <span className="wf-card-actions nodrag">
          {!isEntry && <button type="button" onClick={onSetEntry} title="Set as entry node">&#9733;</button>}
          <button type="button" onClick={onDelete} title="Delete node">&#128465;</button>
        </span>
      </div>

      {hasIssue && (
        <div className="wf-issue-box">
          {issues.map((iss, i) => <div key={i}>{iss.message}</div>)}
        </div>
      )}

      {(node.type === 'send_text' || node.type === 'send_interactive_buttons') && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">Body <CharCount value={body} max={1024} /></div>
          <textarea className="wf-textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{customer_name}}, …" />
        </div>
      )}

      {node.type === 'send_interactive_buttons' && (
        <ButtonsField
          buttons={cfg.buttons || []}
          onChange={(buttons) => onConfigChange({ ...cfg, buttons })}
          outgoingEdges={outgoingEdges}
          otherNodes={otherNodes}
          onAddBranch={onAddBranch}
          onDeleteEdge={onDeleteEdge}
        />
      )}

      {node.type === 'send_interactive_buttons' && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">Timeout (minutes)</div>
          <input
            className="wf-input"
            type="number"
            min="1"
            value={cfg.timeout_minutes || ''}
            onChange={(e) => onConfigChange({ ...cfg, timeout_minutes: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      )}

      {node.type === 'send_template' && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">Template</div>
          <select className="wf-select" value={cfg.templateName || ''} onChange={(e) => onConfigChange({ ...cfg, templateName: e.target.value })}>
            <option value="">Choose a template…</option>
            {templates.filter((t) => t.status === 'approved').map((t) => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {node.type === 'delay' && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">Duration (minutes)</div>
          <input
            className="wf-input"
            type="number"
            min="0"
            value={cfg.duration_minutes ?? ''}
            onChange={(e) => onConfigChange({ ...cfg, duration_minutes: Number(e.target.value) })}
          />
        </div>
      )}

      {node.type === 'action' && cfg.kind === 'assign_tag' && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">Tag</div>
          <select className="wf-select" value={cfg.tag_id || ''} onChange={(e) => onConfigChange({ ...cfg, tag_id: e.target.value })}>
            <option value="">Choose a tag…</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {node.type === 'action' && cfg.kind === 'set_opt_in' && (
        <div className="wf-field nodrag">
          <div className="wf-field-label">New status</div>
          <select className="wf-select" value={cfg.opt_in_event || 'opted_in'} onChange={(e) => onConfigChange({ ...cfg, opt_in_event: e.target.value })}>
            <option value="opted_in">Opted In</option>
            <option value="opted_out">Opted Out</option>
          </select>
        </div>
      )}
      {node.type === 'action' && cfg.kind === 'human_handoff' && (
        <div className="wf-field-static">Ends automation — the chat stays visible to a human agent.</div>
      )}

      {/* Non-button branches for a buttons node; single 'always' branch display for single-output types. */}
      {node.type === 'send_interactive_buttons' && (
        <div className="wf-branches">
          {outgoingEdges.filter((e) => e.condition_type !== 'button_id').map((e) => (
            <BranchRow key={e.id} edge={e} targetLabel={nodeLabel(findNode(e.to_node_id))} onDelete={() => onDeleteEdge(e.id)} />
          ))}
          <AddBranchControl conditionType="keyword" otherNodes={otherNodes} onAdd={(targetId, kw) => onAddBranch('keyword', targetId, kw)} />
          {!outgoingEdges.some((e) => e.condition_type === 'default') && (
            <AddBranchControl conditionType="default" otherNodes={otherNodes} onAdd={(targetId) => onAddBranch('default', targetId)} />
          )}
          {!outgoingEdges.some((e) => e.condition_type === 'timeout') && (
            <AddBranchControl conditionType="timeout" otherNodes={otherNodes} onAdd={(targetId) => onAddBranch('timeout', targetId)} />
          )}
        </div>
      )}

      {alwaysEdge && (
        <div className="wf-branches">
          <BranchRow edge={alwaysEdge} targetLabel={nodeLabel(findNode(alwaysEdge.to_node_id))} onDelete={() => onDeleteEdge(alwaysEdge.id)} />
        </div>
      )}

      {showAlwaysHandle && (
        <Handle type="source" position={Position.Right} id="always" style={{ background: CONDITION_COLORS.always }} />
      )}
    </div>
  );
}

// Buttons sub-field — each button gets its own labelled, draggable source
// handle (button_id edges are created by dragging FROM here, per Agent 2's
// separate-labelled-port-per-edge design). Adding/removing a button here
// also removes its now-orphaned edge in the same action (App.jsx's
// onConfigChange path), matching Typebot's confirmed deleteItem ->
// deleteConnectedEdgesDraft pairing rather than leaving a dangling edge
// for the validator to catch after the fact.
function ButtonsField({ buttons, onChange, outgoingEdges, otherNodes, onAddBranch, onDeleteEdge }) {
  const nodeLabel = (nid) => {
    const n = otherNodes.find((x) => x.id === nid);
    return n ? `${NODE_TYPE_LABELS[n.type]} — ${n.id.slice(0, 8)}` : '—';
  };
  return (
    <div className="wf-field nodrag">
      <div className="wf-field-label">Buttons ({buttons.length}/3)</div>
      {buttons.map((b, i) => {
        const edge = outgoingEdges.find((e) => e.condition_type === 'button_id' && e.condition_value === b.id);
        return (
          <div key={b.id} className="wf-button-row">
            <input
              className="wf-input-sm"
              value={b.title}
              maxLength={20}
              onChange={(e) => {
                const next = buttons.slice();
                next[i] = { ...b, title: e.target.value };
                onChange(next);
              }}
              placeholder={`Button ${i + 1}`}
            />
            <button
              type="button"
              className="wf-btn-sm wf-btn-danger"
              onClick={() => {
                onChange(buttons.filter((x) => x.id !== b.id));
                if (edge) onDeleteEdge(edge.id);
              }}
            >
              &times;
            </button>
            {edge ? (
              <span className="wf-branch-target">&rarr; {nodeLabel(edge.to_node_id)}</span>
            ) : (
              <span className="wf-branch-target wf-branch-unrouted">unrouted — drag from the dot</span>
            )}
            <Handle
              type="source"
              position={Position.Right}
              id={`button-${b.id}`}
              style={{ position: 'absolute', right: -9, top: '50%', transform: 'translateY(-50%)', background: '#1e6e5a' }}
            />
          </div>
        );
      })}
      {buttons.length < 3 && (
        <button
          type="button"
          className="wf-btn-sm"
          onClick={() => onChange([...buttons, { id: `btn_${Date.now()}_${buttons.length}`, title: '' }])}
        >
          + Add Button
        </button>
      )}
    </div>
  );
}
