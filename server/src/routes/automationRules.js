const { Router } = require('express');
const automationRulesRepo = require('../repositories/automationRulesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { automationRuleCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await automationRulesRepo.list(req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = automationRuleCreateSchema.parse(req.body);
  const rule = await automationRulesRepo.create(req.clientId, data);
  res.status(201).json(rule);
}));

module.exports = router;
