# Android release signing (upload key)

## Status: done on 2026-11-21

The upload key already exists, **outside this repo**, on the dev machine:

```
C:\Users\JESHEEBA\wasi-android-signing\
  wasi-release.keystore        PKCS12, alias wasi-upload, RSA 2048, valid 10,000 days
  CREDENTIALS-KEEP-SAFE.txt    store/key password (same password for both)
  builds\                      signed .aab files ready to upload
```

Upload-key certificate SHA-256 (Play Console shows this after the first upload; they
must match):
`D7:F3:30:43:27:BC:FA:CB:ED:DC:4C:92:B5:6D:85:DB:95:B3:3F:44:31:FB:A3:D6:DC:03:C3:96:B3:66:26:CD`

**Back up that folder now** (password manager file storage or an encrypted drive). It is
the only copy. Never commit it.

## How bad is losing it?

Less bad than the earlier version of this doc said. Google Play App Signing is mandatory
for `.aab` uploads, so this is only the **upload key**: Google re-signs every release with
its own app-signing key, which you never hold. If the upload key is lost or leaked, the
account owner can ask Google to reset it (Play Console > Test and release > App integrity
> Upload key reset), and keep the same listing, installs and reviews. That costs a few days
of waiting, so still back it up.

## Local builds (works on this machine now)

Android Studio's bundled JDK and the Android SDK are installed here. Signing is read from
`mobile/android/keystore.properties` (git-ignored; already created, points at the folder
above):

```properties
storeFile=C:/Users/JESHEEBA/wasi-android-signing/wasi-release.keystore
storePassword=...
keyAlias=wasi-upload
keyPassword=...
```

Build:

```sh
cd mobile/android
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat bundleRelease
# output: app/build/outputs/bundle/release/app-release.aab
```

Before each new release, raise `versionCode` (and usually `versionName`) in
`mobile/android/app/build.gradle`. Play rejects a repeated `versionCode`.

## CI builds (optional): GitHub secrets

To build from the **Android Release Build** workflow instead, add these in GitHub:
**Settings > Secrets and variables > Actions > New repository secret**.

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\JESHEEBA\wasi-android-signing\wasi-release.keystore")) \| Set-Clipboard` then paste |
| `ANDROID_KEYSTORE_PASSWORD` | Store password from `CREDENTIALS-KEEP-SAFE.txt` |
| `ANDROID_KEY_ALIAS` | `wasi-upload` |
| `ANDROID_KEY_PASSWORD` | Same password |
