# Ad spend, clicks and cost per lead (Marketing API)

## Purpose
The owner asked to check whether the Marketing API allows building this end
to end. It does, but Meta gates who can use it:

- **Before App Review:** works only for ad accounts of people with a role
  on the Wasi Meta app (e.g. the owner's own ad account).
- **For clients:** needs ads_read Advanced access (App Review with a
  screencast, plus business verification) and the Marketing API "Full
  access" tier: 500+ successful Marketing API calls in 15 days, under 15%
  errors.

## Architecture
- **Sign-in:** Facebook Login for Business, redirect flow, with a
  configuration that grants `ads_read` (`META_ADS_CONFIG_ID`).
  - `POST /api/ads/connect` returns the dialog URL with a signed, 15-minute
    `state` (HMAC with JWT_SECRET, names the client).
  - The public `GET /api/ads/callback` verifies the state, exchanges the
    code (the same `redirect_uri`), swaps it for a long-lived (60-day)
    token, lists ad accounts (auto-picks a single one), and redirects to
    `/app?ads=<result>#ctwa`.
- **Storage:** `ads_connections` (migration 105, RLS). The token is stored
  encrypted and never returned.
- **Account:** `GET /api/ads/accounts` and `PUT /api/ads/account` (only
  accounts Meta shared). Disconnect is `DELETE /api/ads`.
- **Numbers:** `GET /api/analytics/ctwa` adds per-ad `spend`, `clicks`,
  `impressions` and `costPerLead`, plus totals.
  - Source: `GET /{act}/insights?level=ad&fields=ad_id,ad_name,spend,impressions,clicks`.
  - Matched on ad id = `referral.source_id` (Meta documents source_id as
    the CTWA ad id).
  - Cost per lead = spend / Wasi's own lead count. **Meta's
    "messaging conversations started" metric is deliberately not used:**
    its action type isn't confirmed, and Meta is deprecating conversion
    metrics in Ads Insights (Q1 2026).
  - A Meta error keeps the leads and reports the reason.

## Owner setup (Meta App Dashboard)
1. **Add the Marketing API product** to the Wasi app.
2. **Create a Facebook Login for Business configuration:**
   - Login variation: General.
   - Token type: user access token.
   - Permissions: `ads_read` (plus `business_management` if Meta asks).
   - Copy its Configuration ID into `META_ADS_CONFIG_ID` on the server.
3. **Add the redirect URL:** Facebook Login for Business > Settings > Valid
   OAuth Redirect URIs: `https://wasi.sirahagents.com/api/ads/callback`.
4. **Test with your own ad account first.** It works before review because
   you have a role on the app, and each page view makes Marketing API calls
   that count toward the 500.
5. **App Review:** request `ads_read` Advanced access, using a screencast
   of Ad Leads > Connect ad account > numbers showing. Business
   verification must be complete.
6. Once 500+ calls in 15 days are reached, **upgrade the Marketing API tier**
   to Full access in the App Dashboard.

## Tests
- `ctwaAdMetrics.test.js` (8): state signing; not-configured 409; dialog
  URL; bad state redirect; code exchange (same redirect_uri) and encrypted
  long-lived token; merge and cost per lead; a Meta refusal keeps leads;
  the account picker refuses unshared accounts; disconnect.
- `ctwaAdsPage.test.js` (6): updated, because the old "never show spend"
  rule became "never invent it". Without a connected account, the money
  columns show "-" and there is no spend tile.
