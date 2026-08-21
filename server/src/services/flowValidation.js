// Checks a flow's nodes/edges for configurations that are broken today, not
// just "look incomplete" — every issue here is something confirmed against
// flowEngine.js's actual runtime behavior, not a style preference. Two
// callers: routes/automationFlows.js's GET /:id (surfaced in the step
// editor, informational) and its PATCH /:id (blocks a transition to
// status: 'active').
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');

// Deliberately NOT flagged: send_text/send_template/action nodes with zero
// outgoing edges. flowEngine.js's runToRest treats that as a legitimate,
// silent implicit end ("no outgoing edge = implicit end") — a
// one-message-and-stop flow is a valid design, not a bug. 'delay' and
// 'send_interactive_buttons' don't get the same pass: a delay node ALWAYS
// needs its 'always' edge to ever advance — flowRunner's advanceDueNode
// confirms a delay with no matching edge logs 'stalled' and parks the
// contact there permanently, a real runtime failure, checked below.
// send_interactive_buttons CAN legitimately end automation with zero edges
// (e.g. "send this, then a human takes over" — the same pattern action's
// human_handoff kind already uses), so it isn't flagged for that either —
// only its unrouted-button case is, since that one has a confirmed live
// example (the Stage 7 spike) of silently dropping a real reply.

async function validateFlow(db, clientId, nodes, edges) {
  const issues = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgesByFromNode = new Map();
  for (const edge of edges) {
    if (!edgesByFromNode.has(edge.from_node_id)) edgesByFromNode.set(edge.from_node_id, []);
    edgesByFromNode.get(edge.from_node_id).push(edge);
  }

  // Structurally shouldn't be reachable — migration 023's flow_edges FKs
  // are ON DELETE CASCADE for both from_node_id/to_node_id — but checked
  // anyway per the explicit ask, and it's nearly free once nodes/edges are
  // already in hand.
  for (const edge of edges) {
    if (!nodeById.has(edge.from_node_id) || !nodeById.has(edge.to_node_id)) {
      issues.push({ edgeId: edge.id, nodeId: null, code: 'dangling_edge', message: 'This branch points at a node that no longer exists.' });
    }
  }

  for (const node of nodes) {
    const outgoing = (edgesByFromNode.get(node.id) || []).filter((e) => nodeById.has(e.to_node_id));

    if (node.type === 'send_interactive_buttons') {
      const buttons = node.config?.buttons || [];
      const routedButtonIds = new Set(outgoing.filter((e) => e.condition_type === 'button_id').map((e) => e.condition_value));
      const hasDefault = outgoing.some((e) => e.condition_type === 'default');
      for (const button of buttons) {
        if (routedButtonIds.has(button.id)) continue;
        issues.push({
          nodeId: node.id,
          edgeId: null,
          code: 'unrouted_button',
          message: hasDefault
            ? `Button "${button.title}" has no matching branch — a reply to it falls through to the default branch instead.`
            : `Button "${button.title}" has no matching branch, and there's no default branch either — a reply to it is silently dropped.`,
        });
      }
    }

    if (node.type === 'delay' && !outgoing.some((e) => e.condition_type === 'always')) {
      issues.push({
        nodeId: node.id,
        edgeId: null,
        code: 'delay_dead_end',
        message: 'This delay has no branch to continue to — every contact who reaches it stalls here permanently.',
      });
    }

    if (node.type === 'send_template') {
      const templateName = node.config?.templateName;
      if (!templateName) {
        issues.push({ nodeId: node.id, edgeId: null, code: 'template_missing', message: 'No template selected for this node.' });
      } else {
        const template = await messageTemplatesRepo.findByNameAndClient(db, clientId, templateName);
        if (!template) {
          issues.push({ nodeId: node.id, edgeId: null, code: 'template_not_found', message: `Template "${templateName}" no longer exists.` });
        } else if (template.status !== 'approved') {
          issues.push({
            nodeId: node.id, edgeId: null, code: 'template_not_approved',
            message: `Template "${templateName}" is ${template.status}, not approved — Meta will reject sends using it.`,
          });
        }
      }
    }
  }

  return issues;
}

module.exports = { validateFlow };
