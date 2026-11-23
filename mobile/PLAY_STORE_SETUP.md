# Play Store launch checklist - Wasi (root CRM app)

Everything below that's pure code/config is already done in this repo (see
`mobile/README.md`). This file is the rest: the steps that need your Play Console
account, your decisions, or a human click. I drafted the text wherever I could so you're
mostly reviewing/pasting, not writing from scratch.

## 0. Status (2026-11-21)

Done in the repo:
- Real privacy policy (replaces the placeholder): `marketing/privacy.html`.
  Play Console URL: **https://wasi.sirahagents.com/marketing/privacy.html**
- Account deletion page (Play requires a web link for apps that let users create an
  account): `marketing/delete-account.html`.
  Play Console URL (Data safety > Data deletion): **https://wasi.sirahagents.com/marketing/delete-account.html**
- Upload key generated and a signed `.aab` built locally (`KEYSTORE_SETUP.md`). The file
  to upload: `C:\Users\JESHEEBA\wasi-android-signing\builds\wasi-1.0-vc1.aab`.
- Listing graphics: `mobile/store-listing/app-icon-512.png`,
  `mobile/store-listing/feature-graphic-1024x500.png`.
- Screenshots (2026-11-23): `mobile/store-listing/screenshots/` - `phone-*` (1080x1920),
  `tablet7-*` (1200x1920), `tablet10-*` (1600x2560). Taken from the synthetic
  "Vetri Academy (Demo)" client (`server/src/db/seedLandingDemo.js`) seeded into the
  LOCAL embedded Postgres only, never production, so no real client data appears.
  Re-take: seed it locally, then serve with `createApp()` on port 4000 and capture with
  Playwright using a locally signed client token.
- Trader status details (from sirahdigital.in/contact): Sirah Digital, 8th Floor,
  Innovate, Featherlite - The Address, Pallavaram, Chennai 600044, Tamil Nadu, India;
  +91 97899 61631; support@sirahdigital.in.
- Wallet top-ups removed from the app (2026-11-23), so the only in-app payment left is
  Settings > Subscription checkout (Razorpay). Play's payments policy may still query it.

Still yours:
- Read the privacy policy and deletion page once. They describe what the code does today
  and make two commitments you must keep: deletion within 30 days of a confirmed request,
  and email notice of significant policy changes. Legal review is still recommended.
- The pages must be **deployed** before you paste the URLs into Play Console.
- Everything from section 1 down that happens inside Play Console.

## 1. Confirm your Play Console account is in good standing

You said you already have one. Two things worth checking before you start:

- **New personal developer accounts must run a closed test with at least 12 testers for
  14 continuous days before Google grants production access.** If your account is new
  (registered recently), budget 2 weeks for this *before* you can go to Production - plan
  the closed testing track first, not last. If your account is older/already has
  published apps, this likely doesn't apply - check **Release > Testing > Closed testing**
  in your console for whether it shows this requirement.
- Make sure your developer account's identity verification (D-U-N-S number or personal ID,
  depending on account type) is already complete - Google has been enforcing this more
  strictly through 2026.

## 2. Create the app in Play Console

**Release > ... > All apps > Create app.**

| Field | Value |
| --- | --- |
| App name | Wasi |
| Default language | English (India) — add Tamil as an additional language once you have Tamil store listing text, since your client base includes Tamil-speaking businesses |
| App or game | App |
| Free or paid | Free (the WhatsApp CRM itself isn't sold through the Play Store - your billing is handled outside it, so there's no Play Billing integration needed) |
| Declarations | Confirm you'll follow the Developer Program Policies and US export laws (standard) |

## 3. Store listing content (draft - review and edit before publishing)

**Short description** (80 chars max):
> WhatsApp Business CRM - manage chats, contacts and campaigns on the go.

**Full description** (draft, edit to match your actual positioning):
> Wasi is a WhatsApp Business CRM for teams who talk to customers on WhatsApp. Reply to
> customer conversations from a shared team inbox, manage your contacts, run WhatsApp
> campaigns with approved templates, and automate common replies - all from your phone.
>
> This app is for existing Wasi clients. If your business doesn't yet have a Wasi account,
> visit [your marketing site URL] to get started.
>
> Features:
> - Shared team inbox for WhatsApp Business conversations
> - Contact management and tagging
> - Campaign broadcasts using Meta-approved message templates
> - Automated reply flows
> - Real-time delivery and read status

**Graphics you need to prepare** (I can't generate photographic app-in-use screenshots -
these need real screenshots of the actual running app):
- App icon (512x512): `mobile/store-listing/app-icon-512.png`
- Feature graphic (1024x500): `mobile/store-listing/feature-graphic-1024x500.png`
- Phone screenshots: minimum 2, Google recommends 4-8 — take these from the real app (Chat view, Contacts, Campaigns, Templates) once you have a build running on a device/emulator
- Short promo video: optional, skip for v1

**Category:** Business
**Tags/contact details:** your support email (not personal), and a real support URL

## 4. Content rating questionnaire

In **Policy > App content > Content ratings**, answer Google's IARC questionnaire.
For an app like this (business messaging tool, no user-generated public content, no
violence/gambling/etc.), expect it to land on the lowest rating. Answer honestly per their
actual questions — I'm not filling this in for you since it's a formal declaration tied to
your account.

## 5. Data Safety section (draft answers - verify against what the app actually does before submitting)

This is the section Google shows users as "Data this app collects." Based on what Wasi
actually does:

| Data type | Collected? | Shared with third parties? | Purpose |
| --- | --- | --- | --- |
| Name, phone number, email | Yes (your own account login; your contacts' data as a business tool) | No (beyond Meta, as the WhatsApp platform operator, and your own Postgres/Supabase hosting) | App functionality, account management |
| Messages (WhatsApp conversation content) | Yes | No (delivered only via Meta's WhatsApp Cloud API) | Core app functionality |
| App activity / diagnostics | Up to you — if you have no crash-reporting SDK wired into the mobile shell, answer "not collected" here, not "collected," since claiming collection you don't do is itself a policy violation | - | - |
| Financial info | Only if your admin/billing flows are reachable from this app (check — if the client app never shows Razorpay/payment UI, answer "not collected") | - | - |

**Declare "Data is encrypted in transit"** — true, since the app only loads
`https://wasi.sirahagents.com` (TLS, Capacitor's `cleartext: false` blocks any plain
HTTP). **Declare that users can request deletion**: yes, via the email process on
`marketing/delete-account.html` (URL in section 0).

Don't let me guess your answers into the actual form - this table is a starting point for
you to confirm against reality, since a wrong declaration here is a policy violation in
its own right, not just an inaccuracy.

## 6. (Only if you want CI to auto-upload to Play Console) Service account for the Play Developer API

Needed only if you want the already-prepared, currently-commented-out step in
`.github/workflows/android-release.yml` to push builds straight to a testing track.
Skip this entirely if you're fine uploading the `.aab` by hand the first few times.

1. Play Console > **Setup > API access** > link a Google Cloud project (or create one).
2. Create a service account in that Cloud project, grant it a key (JSON), download it.
3. Back in Play Console's API access page, grant that service account **Release manager**
   permissions (or just "Release to testing tracks" if you want to limit blast radius).
4. Add the JSON file's full contents as a GitHub secret named `PLAY_SERVICE_ACCOUNT_JSON`.
5. Uncomment the last step in `.github/workflows/android-release.yml`.

## 7. Build and upload the first release

1. The first `.aab` is already built: `C:\Users\JESHEEBA\wasi-android-signing\builds\wasi-1.0-vc1.aab`.
2. Later releases: raise `versionCode`, then build locally or via the GitHub Action
   (`KEYSTORE_SETUP.md`).
4. Play Console > **Release > Testing > Closed testing** (or Production, if your account
   doesn't need the closed-testing gate) > **Create new release** > upload the `.aab`.
5. Add release notes (e.g. "Initial release").
6. Review and roll out.

## 8. After it's live - the part that matters for your actual goal

Once this first version is approved and live, **ordinary changes to your CRM
(app.js, index.html, new features, bug fixes) need zero Play Store action** — they're
already live on `wasi.sirahagents.com`, and the app loads that URL directly. You only
need to repeat step 7 (a new native release) when:
- You change the app icon, splash screen, or app name
- You add a new native capability (push notifications, camera-specific permissions, etc.)
- Google requires a target SDK bump (happens roughly yearly - Google emails registered
  developers with the deadline)
- You change `capacitor.config.json`'s `server.url` or `allowNavigation`

Everything else — which is almost everything you'll actually do day to day — just ships
the normal way, through your existing deploy process.
