// Ad account connection for Click-to-WhatsApp spend / clicks / cost per lead
// (build-docs/features/ctwa-ad-metrics.md).
//
// Sign-in uses Facebook Login for Business (redirect flow) with an ads_read
// configuration (META_ADS_CONFIG_ID). Until Meta grants ads_read Advanced
// access through App Review, only people with a role on the Meta app (e.g.
// the owner) can connect; clients see Meta's own refusal.
//
// `router` (tenant, Admin/Manager) manages the connection. `callbackRouter`
// is public: Meta redirects the browser there with ?code&state, so state is
// an HMAC-signed, expiring token naming the client (no session cookie exists
// in this app to tie the redirect back to).
const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const metaClient = require('../utils/metaClient');
const { encrypt, decrypt } = require('../utils/encryption');

const STATE_TTL_MS = 15 * 60 * 1000;
const baseUrl = () => String(process.env.APP_URL || '').replace(/\/+$/, '');
const redirectUri = () => `${baseUrl()}/api/ads/callback`;
const isConfigured = () => Boolean(process.env.META_ADS_CONFIG_ID && process.env.META_APP_ID && baseUrl().startsWith('https://'));

function signState(clientId) {
  const payload = Buffer.from(JSON.stringify({ c: clientId, e: Date.now() + STATE_TTL_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readState(state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.e > Date.now() && typeof data.c === 'string' ? data.c : null;
  } catch { return null; }
}

async function connectionFor(db, clientId) {
  const { rows } = await db.query('select * from ads_connections where client_id = $1', [clientId]);
  return rows[0] || null;
}

const router = Router();
router.use(requireRole('Admin', 'Manager'));

router.get('/status', asyncHandler(async (req, res) => {
  const c = await connectionFor(req.db, req.clientId);
  res.json({
    configured: isConfigured(),
    connected: Boolean(c),
    adAccountId: c?.ad_account_id || null,
    adAccountName: c?.ad_account_name || null,
    currency: c?.currency || null,
    lastError: c?.last_error || null,
  });
}));

router.post('/connect', asyncHandler(async (req, res) => {
  if (!isConfigured()) return res.status(409).json({ error: 'Ad reporting is not set up on this Wasi server yet (Meta app configuration needed).' });
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('config_id', process.env.META_ADS_CONFIG_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', signState(req.clientId));
  res.json({ url: url.toString() });
}));

router.get('/accounts', asyncHandler(async (req, res) => {
  const c = await connectionFor(req.db, req.clientId);
  if (!c) return res.status(409).json({ error: 'Connect your Meta ad account first.' });
  try {
    const accounts = await metaClient.listAdAccounts(decrypt(c.access_token_encrypted));
    res.json(accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })));
  } catch (err) {
    res.status(502).json({ error: 'Meta did not list your ad accounts. Try connecting again.', detail: err.message });
  }
}));

router.put('/account', asyncHandler(async (req, res) => {
  const { adAccountId } = z.object({ adAccountId: z.string().regex(/^act_\d{3,25}$/, 'Pick one of your ad accounts') }).parse(req.body);
  const c = await connectionFor(req.db, req.clientId);
  if (!c) return res.status(409).json({ error: 'Connect your Meta ad account first.' });
  let accounts;
  try {
    accounts = await metaClient.listAdAccounts(decrypt(c.access_token_encrypted));
  } catch (err) {
    return res.status(502).json({ error: 'Meta did not list your ad accounts.', detail: err.message });
  }
  const chosen = accounts.find((a) => a.id === adAccountId);
  if (!chosen) return res.status(400).json({ error: 'That ad account is not one you gave Wasi access to.' });
  await req.db.query(
    'update ads_connections set ad_account_id = $2, ad_account_name = $3, currency = $4, last_error = null where client_id = $1',
    [req.clientId, chosen.id, chosen.name || null, chosen.currency || null]
  );
  res.json({ adAccountId: chosen.id, adAccountName: chosen.name || null, currency: chosen.currency || null });
}));

router.delete('/', asyncHandler(async (req, res) => {
  await req.db.query('delete from ads_connections where client_id = $1', [req.clientId]);
  res.status(204).send();
}));

// Public: Meta's redirect after sign-in. Always ends with a redirect back to
// the Ad Leads page, carrying a short result code the page turns into a message.
const callbackRouter = Router();
callbackRouter.get('/', asyncHandler(async (req, res) => {
  const back = (result) => res.redirect(`${baseUrl()}/app?ads=${encodeURIComponent(result)}#ctwa`);
  const clientId = readState(req.query.state);
  if (!clientId) return back('expired');
  if (req.query.error || !req.query.code) return back('cancelled');
  try {
    const shortToken = await metaClient.exchangeAdsCode(String(req.query.code), redirectUri());
    const token = await metaClient.exchangeForLongLivedToken(shortToken);
    const accounts = await metaClient.listAdAccounts(token);
    const only = accounts.length === 1 ? accounts[0] : null;
    await pool.query(
      `insert into ads_connections (client_id, access_token_encrypted, token_expires_at, ad_account_id, ad_account_name, currency)
       values ($1, $2, now() + interval '60 days', $3, $4, $5)
       on conflict (client_id) do update set access_token_encrypted = $2, token_expires_at = now() + interval '60 days',
         ad_account_id = coalesce($3, ads_connections.ad_account_id), ad_account_name = coalesce($4, ads_connections.ad_account_name),
         currency = coalesce($5, ads_connections.currency), last_error = null, connected_at = now()`,
      [clientId, encrypt(token), only?.id || null, only?.name || null, only?.currency || null]
    );
    return back(accounts.length ? 'connected' : 'no_accounts');
  } catch (err) {
    console.error('ads: connecting the ad account failed', { clientId, error: err.message });
    return back('failed');
  }
}));

// Spend/impressions/clicks per ad for the Ad Leads page; null when not
// connected. Errors are returned as text so the page still shows leads.
async function insightsByAd(db, clientId, { since, until }) {
  const c = await connectionFor(db, clientId);
  if (!c?.ad_account_id) return { connected: Boolean(c), byAd: null, error: null, currency: c?.currency || null };
  try {
    const rows = await metaClient.getAdInsights(c.ad_account_id, decrypt(c.access_token_encrypted), { since, until });
    const byAd = new Map(rows.map((r) => [String(r.ad_id), {
      spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    }]));
    return { connected: true, byAd, error: null, currency: c.currency || null };
  } catch (err) {
    return { connected: true, byAd: null, error: err.message, currency: c.currency || null };
  }
}

module.exports = { router, callbackRouter, insightsByAd, signState, readState };
