// Report a collected payment to SirahOS.
//
// Razorpay collects the money here; SirahOS holds the invoices and the books.
// Without this, a client pays their plan and their SirahOS invoice still says
// unpaid, so someone chases a payment that already arrived.
//
// SirahOS addresses the project by OUR client id ("wasi:<id>"), resolving it
// through the link it already stores. Nothing about SirahOS is kept here.
//
// Unset SIRAHOS_SECRET and reporting is simply off, so a dev copy and a
// self-hosted instance are unaffected.

const TIMEOUT_MS = 10_000;

const config = () => ({
  base: (process.env.SIRAHOS_URL || 'https://api.os.sirahagents.com').replace(/\/+$/, ''),
  secret: (process.env.SIRAHOS_SECRET || '').trim(),
});

/**
 * Tell SirahOS about one payment. Never throws and never rejects: Razorpay is
 * waiting on this webhook, and a billing server having a bad minute must not
 * make us answer non-2xx and be retried for a payment we already recorded.
 *
 * `kind`:
 *   'invoice' - the client paid their plan; settles their SirahOS invoice.
 *   'topup'   - prepaid message credit; recorded in the ledger, settles
 *               nothing. Using it to settle an invoice would mark a bill paid
 *               that nobody paid.
 *
 * `reference` is Razorpay's payment id, so their retries record it once.
 */
async function reportPayment({ clientId, amount, reference, kind, note }) {
  const { base, secret } = config();
  if (!secret || !clientId || !reference || !(amount > 0)) return;

  try {
    const res = await fetch(`${base}/api/payment-intake/wasi:${encodeURIComponent(clientId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sirahos-Signature': secret },
      body: JSON.stringify({
        amount,
        reference,
        method: 'razorpay',
        kind: kind || 'invoice',
        ...(note ? { note } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 here means the client has no linked SirahOS project, which is a
      // thing to fix there, not a fault in this webhook.
      const body = await res.text().catch(() => '');
      console.warn(`[sirahos] ${res.status} reporting ${reference}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[sirahos] could not report ${reference}: ${e.message}`);
  }
}

module.exports = { reportPayment };
