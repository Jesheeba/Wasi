import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import { CONDITION_COLORS, FLOW_EDGE_TYPE_LABELS } from './constants.js';

// Colored/labelled by condition_type (Agent 2's design, already proven in
// the read-only canvas) plus a delete button shown when the edge is
// selected — click the edge, then the button, or Backspace/Delete once
// selected (React Flow's own default). Not n8n's hover-with-debounce
// pattern (that's a further polish pass, not required for this stage to
// be functional) — click-to-select is simpler and just as real.
export default function ConditionEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = CONDITION_COLORS[data?.conditionType] || '#8a8578';
  const dashed = data?.conditionType === 'timeout';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: selected ? 3 : 2, strokeDasharray: dashed ? '6,4' : undefined }}
      />
      <EdgeLabelRenderer>
        <div
          className="wf-edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, borderColor: color, color }}
        >
          {FLOW_EDGE_TYPE_LABELS[data?.conditionType] || data?.conditionType}
          {data?.conditionValue ? ` "${data.conditionValue}"` : ''}
          {selected && (
            <button type="button" className="wf-edge-delete" onClick={() => data?.onDelete?.(id)}>&times;</button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
