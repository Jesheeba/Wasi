# Wasi mobile app (Capacitor Android wrapper)

## What this is, and why it works the way it does

This is a thin native Android shell around the existing root CRM app
(`index.html`/`app.js`/`index.css` at the repo root), built with
[Capacitor](https://capacitorjs.com/).

**The app does not bundle the CRM's HTML/JS inside the APK.** Instead,
`capacitor.config.json`'s `server.url` points the app's WebView directly at
`https://wasi.sirahagents.com`. The practical effect: when you deploy a change to the
CRM the normal way (same as today, no mobile-specific step), it's live in every
installed copy of this app immediately, with **no Play Store update required**. That was
the explicit goal behind building it this way rather than as a "real" server-driven-UI
(JSON screen schema) engine, which would add a new rendering layer without updating any
faster than this already does.

A native release build (see below) is only needed when the *native shell itself* changes
— icon, splash screen, permissions, or a Google-mandated target SDK bump. Not for
ordinary feature/content work.

## Structure

```
mobile/
  capacitor.config.json   - points the WebView at the live production URL
  www/                    - local fallback page only, shown if the remote URL can't be reached
  resources/              - source icon/splash images (from img/wasi-mark-512.png)
  android/                - generated native Android project (Gradle)
  KEYSTORE_SETUP.md        - one-time signing key setup (you must do this, not me - see why inside)
  PLAY_STORE_SETUP.md      - the full Play Console checklist (account, listing, data safety, etc.)
```

## Local development

Building/running the Android project needs Android Studio (which bundles a JDK) or a
standalone JDK 21 + Android SDK command-line tools — neither is installed on this
machine, so builds run via the GitHub Actions workflow
(`.github/workflows/android-release.yml`) by default.

If you install Android Studio and want to run it locally:

```sh
cd mobile
npm install
npx cap sync android
npx cap open android      # opens the project in Android Studio
```

From Android Studio, Run on an emulator or a connected device. Because `server.url` is
remote, you're always testing against whatever's live on `wasi.sirahagents.com` — if you
want to test against a local dev server instead, temporarily change `server.url` to your
machine's LAN IP (e.g. `http://192.168.x.x:3000`) and set `"cleartext": true`, but **never
commit that change** — it must always point at the real HTTPS production URL before any
release build.

## Releasing an update to the native shell

See `KEYSTORE_SETUP.md` (one-time) then `PLAY_STORE_SETUP.md` section 7.

## What's deliberately not built yet (Phase 2, not blocking launch)

- Push notifications (needs Firebase Cloud Messaging + `google-services.json` + a server-side
  send path — real scope, not a config tweak)
- A dedicated "no WhatsApp number connected yet" onboarding screen in the app shell —
  today a fresh login just shows whatever the web app shows in that state, which is fine
- Deep links (e.g. `wasi://chat/123`) for notification taps
