# Go-Live Checklist — Meta & Razorpay Compliance

Everything in this repo is now built and tested against a real Supabase database with
sandbox/no-credential fallbacks. What's left is account-side setup that only you can
do (requires your business identity, bank details, legal documents) — this is that list.

## 1. Meta — becoming a real WhatsApp Tech Provider

- [ ] **Meta Business Manager**: create one at business.facebook.com if you don't have
      one, and complete **Business Verification** (legal business name, address, a
      document like a business registration or utility bill). This is the single
      longest step in the whole checklist — often 1–5 business days, sometimes needs
      resubmission. Start this first.
- [ ] **Meta App**: create at developers.facebook.com, add the **WhatsApp** product.
- [ ] **Embedded Signup config**: inside the WhatsApp product settings, create a
      configuration (`config_id`) for Embedded Signup. Set the redirect/allowed
      domains to your production URL.
- [ ] Copy `META_APP_ID`, `META_APP_SECRET`, and the `config_id` into your production
      environment as `META_APP_ID` / `META_APP_SECRET` / `META_CONFIG_ID`.
- [ ] **Webhook subscription**: in the App Dashboard's WhatsApp > Configuration, set
      the webhook URL to `https://<your-domain>/webhooks/meta` and the verify token to
      match `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to these fields (all are already
      implemented in `server/src/routes/metaWebhook.js`):
  - [ ] `messages` — inbound customer messages
  - [ ] `statuses` — delivery/read/failed receipts
  - [ ] `message_template_status_update` — template approval results
  - [ ] `account_update` — phone number quality rating changes
- [ ] **Data deletion callback**: already implemented and returns a working status URL
      (`server/src/routes/metaDataDeletion.js` + `/webhooks/meta/data-deletion/status/:code`).
      Register the callback URL `https://<your-domain>/webhooks/meta/data-deletion` in
      the App Dashboard's Data Deletion Instructions field.
- [ ] **Privacy Policy / Terms of Service**: already live at `/marketing/privacy.html`
      and `/marketing/terms.html` — replace the placeholder legal text with real
      counsel-reviewed copy before submitting for review, then link both URLs in the
      App Dashboard's Basic Settings.
- [ ] **Test the full flow against a Meta test WABA** (Meta gives you sandbox test
      numbers before App Review) — sign up a test client end-to-end through
      `/marketing/signup.html`, confirm Embedded Signup connects, send/receive a real
      test message, run a test broadcast.
- [ ] **Submit for App Review**, requesting `whatsapp_business_management`,
      `whatsapp_business_messaging`, and `business_management` permissions. You'll need
      a screen recording of the full onboarding → connect → send/receive flow — record
      this once the test above passes.
- [ ] Once approved, every *new* client's Embedded Signup connects a real WABA — no
      further code changes needed, this is purely an account-approval gate.

## 2. Razorpay — accepting real payments

- [ ] Create a Razorpay business account, complete KYC (PAN, bank account, business
      documents).
- [ ] Generate **live mode** API keys, set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` in
      production.
- [ ] Register a webhook in the Razorpay dashboard pointing at
      `https://<your-domain>/webhooks/razorpay`, subscribed to: `payment.captured`,
      `order.paid`, `payment.failed`, `refund.processed`, `payment_link.paid`. Set
      `RAZORPAY_WEBHOOK_SECRET` to match what you configure there.
- [ ] Confirm `PLAN_PRICING_INR` — now the `plans` table (migration `008_billing.js`) —
      reflects real pricing you intend to charge before any client checks out.
- [ ] Test one real low-value payment end-to-end (signup checkout, a payment link,
      and a wallet recharge) before announcing launch.

## 3. Production secrets (before either of the above goes live with real data)

- [ ] Rotate `JWT_SECRET` and `SERVER_SECRET` off their dev defaults — the admin panel's
      Settings page (`/admin` → Settings) reports whether these are still default.
- [ ] `server/src/utils/encryption.js` (AES-256-GCM keyed by `SERVER_SECRET`) is
      explicitly an MVP secret store, not a KMS/Vault — it's adequate to ship with, but
      upgrade to Supabase Vault, AWS KMS, or similar before real client WABA access
      tokens accumulate in the database at scale. Read the file's own header comment
      for the reasoning.
- [ ] Configure `RESEND_API_KEY` + `EMAIL_FROM` (or swap in another provider in
      `server/src/utils/emailService.js`) — without it, password reset/verification/
      admin-invite emails only log to the server console (safe for dev, not for real
      users, who'd never receive their reset link).

## 4. Not blocking launch, worth knowing about

- No genuine AI features exist yet (auto-reply suggestions, campaign copy generation,
  etc.) — per your own scoping decision, this was deliberately deferred to finalize
  later. The keyword-trigger automation engine (`server/src/services/automationEngine.js`)
  covers Kwick's actual (non-AI) automation feature set.
- Ecommerce catalog, WhatsApp Flows, Instagram DM automation, and Click-to-WhatsApp Ads
  config are still static/decorative screens — each is its own separate Meta product
  integration, out of scope for this build per the approved plan's Phase 8.
- Reports sub-views for Flow/API/Live-Chat/Operator-stats remain static — there's no
  underlying feature (Flows, a live-chat widget, multi-agent attribution) yet to
  report real numbers on. Message, Tags, and Campaign reports are real.
