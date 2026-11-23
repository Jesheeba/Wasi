const { Router } = require('express');
const walletRepo = require('../repositories/walletRepo');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

// Read-only. Wallet top-ups were removed on 2026-11-23: message costs can't be
// metered per client, so there was nothing to spend a balance on. The Razorpay
// webhook still settles any top-up that was already pending.
router.get('/', asyncHandler(async (req, res) => {
  const [balance, transactions] = await Promise.all([
    walletRepo.balance(req.db, req.clientId),
    walletRepo.listByClientId(req.db, req.clientId),
  ]);
  res.json({ balance, transactions });
}));

module.exports = router;
