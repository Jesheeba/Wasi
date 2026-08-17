const { Router } = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  try {
    await pool.query('select 1');
  } catch (err) {
    return res.status(503).json({ status: 'error', db: 'disconnected' });
  }
  res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
}));

module.exports = router;
