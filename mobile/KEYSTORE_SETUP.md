# Android release keystore - one-time setup

This has to be done by you, not me, for a real reason: whoever holds this file and its
passwords is the only person who can ever publish an update to this app again. If it's
lost, Google **cannot** recover it or reset it — you'd have to publish the app as a brand
new listing, losing your installs, reviews and rating history. I should not generate or
hold something that sensitive on your behalf.

The good news: you only do this **once**, ever, for this app. After that, GitHub Actions
builds every future release from the secrets you set up here.

## 1. Generate the keystore

You need a JDK installed (Android Studio includes one, or install Temurin 21 directly:
https://adoptium.net). Then run this **once**, from any machine with `keytool` on its
PATH:

```sh
keytool -genkeypair -v \
  -keystore wasi-release.keystore \
  -alias wasi-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

It will ask for:
- A keystore password (write it down somewhere safe — a password manager, not a text file in this repo)
- Your name/org details (anything reasonable; cosmetic, shown nowhere public)
- A key password (can be the same as the keystore password)

This produces `wasi-release.keystore`. **Do not commit this file to git.** Store a copy
somewhere durable (your password manager's file storage, or an encrypted drive) — if you
lose it, see the warning above.

## 2. Add it to GitHub so Actions can build signed releases

In your GitHub repo: **Settings > Secrets and variables > Actions > New repository secret**.
Add these four secrets:

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Output of `base64 -w0 wasi-release.keystore` (Linux/Mac) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("wasi-release.keystore"))` (PowerShell) |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password from step 1 |
| `ANDROID_KEY_ALIAS` | `wasi-upload` (or whatever alias you used) |
| `ANDROID_KEY_PASSWORD` | The key password from step 1 |

Once these exist, the `.github/workflows/android-release.yml` workflow (already in this
repo) can build a signed `.aab` on demand — go to the **Actions** tab, select
**Android Release Build**, click **Run workflow**, give it a version code/name.

## 3. Local builds (optional, only if you install Android Studio)

If you also want to build locally, create `mobile/keystore.properties` (already
git-ignored — never commit it):

```properties
storeFile=../wasi-release.keystore
storePassword=YOUR_KEYSTORE_PASSWORD
keyAlias=wasi-upload
keyPassword=YOUR_KEY_PASSWORD
```

Then `cd mobile/android && ./gradlew bundleRelease` produces the same signed `.aab`
at `android/app/build/outputs/bundle/release/app-release.aab`.

## Which key goes to Google?

**The upload key you just generated, not a different one.** Google Play App Signing
(enabled for every new app since 2021) means: you upload your `.aab` signed with this
"upload key", and Google re-signs it with its own app-signing key before distributing it
to users. You never hand Google your actual distribution key — that's Google's own,
managed by them. You just need to keep using *this same upload key* for every future
release. That's exactly what steps 1-2 set up.
