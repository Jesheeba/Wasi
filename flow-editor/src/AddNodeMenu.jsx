import { PALETTE_ITEMS } from './constants.js';

// Shown when a connection is dragged from a handle and dropped on empty
// canvas (React Flow's onConnectEnd with no valid target) — n8n and
// AiSensy's "stretch a thread to empty space" pattern (confirmed live in
// both, this session's earlier investigation). Picking a type creates the
// node at the drop position AND the edge in one action, via
// onPick(paletteItem).
export default function AddNodeMenu({ x, y, onPick, onClose }) {
  return (
    <>
      <div className="wf-menu-backdrop" onClick={onClose} />
      <div className="wf-add-node-menu" style={{ left: x, top: y }}>
        {PALETTE_ITEMS.map((item) => (
          <button key={item.paletteId} type="button" onClick={() => onPick(item)}>
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
