// Flow CRUD — the step-list editor's backend (build plan Stage 6). Mounted
// under requireClientAuth/withTenantContext, same as automation-rules and
// every other client-scoped resource — req.db is the RLS-restricted
// connection, so every query here is already tenant-isolated at the
// Postgres level, not just by these WHERE clauses.
const { Router } = require('express');
const automationFlowsRepo = require('../repositories/automationFlowsRepo');
const flowNodesRepo = require('../repositories/flowNodesRepo');
const flowEdgesRepo = require('../repositories/flowEdgesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  uuid, automationFlowCreateSchema, automationFlowUpdateSchema,
  flowNodeCreateSchema, flowNodeUpdateSchema, flowEdgeCreateSchema,
} = require('../utils/validate');
const { isEdgeTypeLegalForNode } = require('../services/flowEngine');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await automationFlowsRepo.list(req.db, req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = automationFlowCreateSchema.parse(req.body);
  const flow = await automationFlowsRepo.create(req.db, req.clientId, data);
  res.status(201).json(flow);
}));

// Full graph in one call — the editor needs the flow, every node, and
// every edge to render the step list; fetching them as three separate
// round trips from the client would just be slower for no benefit.
router.get('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const flow = await automationFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  const nodes = await flowNodesRepo.listByFlowId(req.db, req.clientId, flow.id);
  const edges = await flowEdgesRepo.listByFlowId(req.db, req.clientId, flow.id);
  res.json({ ...flow, nodes, edges });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = automationFlowUpdateSchema.parse(req.body);
  const flow = await automationFlowsRepo.update(req.db, req.clientId, req.params.id, data);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  res.json(flow);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await automationFlowsRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

router.post('/:id/nodes', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const flow = await automationFlowsRepo.findById(req.db, req.clientId, req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  const data = flowNodeCreateSchema.parse(req.body);
  const node = await flowNodesRepo.create(req.db, req.clientId, flow.id, data);
  // The first node created on a flow becomes its entry point automatically
  // — a flow with nodes but no entry_node_id can never run (flowEngine.js's
  // startFlow returns immediately if it's null), and there's no reason to
  // make the author take a second explicit step for the common case of
  // building a flow node-by-node from the start. Still editable afterward
  // via PATCH .../:id { entry_node_id }.
  if (!flow.entry_node_id) {
    await automationFlowsRepo.update(req.db, req.clientId, flow.id, { entry_node_id: node.id });
  }
  res.status(201).json(node);
}));

router.patch('/:id/nodes/:nodeId', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.nodeId);
  const data = flowNodeUpdateSchema.parse(req.body);
  const node = await flowNodesRepo.update(req.db, req.clientId, req.params.nodeId, data);
  if (!node) return res.status(404).json({ error: 'Not found' });
  res.json(node);
}));

router.delete('/:id/nodes/:nodeId', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.nodeId);
  // flow_edges rows referencing this node cascade-delete (migration 023:
  // both from_node_id and to_node_id are ON DELETE CASCADE) — no manual
  // edge cleanup needed here.
  const deleted = await flowNodesRepo.remove(req.db, req.clientId, req.params.nodeId);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

router.post('/:id/edges', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = flowEdgeCreateSchema.parse(req.body);

  const fromNode = await flowNodesRepo.findById(req.db, req.clientId, data.from_node_id);
  if (!fromNode || fromNode.flow_id !== req.params.id) {
    return res.status(400).json({ error: 'from_node_id must belong to this flow' });
  }
  const toNode = await flowNodesRepo.findById(req.db, req.clientId, data.to_node_id);
  if (!toNode || toNode.flow_id !== req.params.id) {
    return res.status(400).json({ error: 'to_node_id must belong to this flow' });
  }
  // Write-time half of flowEngine.js's edge-legality guarantee (see
  // isEdgeTypeLegalForNode's comment) — reject a keyword/button_id/default
  // edge off a node type that can never receive an inbound event to match
  // it against, and a timeout edge off anything but a waiting node, before
  // it's ever saved, rather than letting it sit dead in the graph.
  if (!isEdgeTypeLegalForNode(fromNode.type, data.condition_type)) {
    return res.status(400).json({
      error: `A "${data.condition_type}" edge cannot start from a "${fromNode.type}" node.`,
    });
  }

  const edge = await flowEdgesRepo.create(req.db, req.clientId, req.params.id, data);
  res.status(201).json(edge);
}));

router.delete('/:id/edges/:edgeId', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.edgeId);
  const deleted = await flowEdgesRepo.remove(req.db, req.clientId, req.params.edgeId);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
