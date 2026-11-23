const { Router } = require('express');
const automationRulesRepo = require('../repositories/automationRulesRepo');
const automationFlowsRepo = require('../repositories/automationFlowsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { automationRuleCreateSchema, automationRuleUpdateSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  res.json(await automationRulesRepo.list(req.db, req.clientId, { flowId: req.query.flow_id }));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = automationRuleCreateSchema.parse(req.body);
  const rule = await automationRulesRepo.create(req.db, req.clientId, data);
  res.status(201).json(rule);
}));

router.patch('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = automationRuleUpdateSchema.parse(req.body);
  // The FK check bypasses RLS, so confirm the flow is this client's own.
  if (data.flow_id && !(await automationFlowsRepo.findById(req.db, req.clientId, data.flow_id))) {
    return res.status(400).json({ error: 'Flow not found' });
  }
  const rule = await automationRulesRepo.update(req.db, req.clientId, req.params.id, data);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
}));

module.exports = router;
