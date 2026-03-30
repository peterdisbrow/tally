---
name: build-release
description: Build, sign, notarize, and release Tally Connect Electron app to GitHub
user_invocable: true
arguments:
  - name: version
    description: "Version to release (e.g. 1.2.0). If omitted, auto-increments patch version."
    required: false
---

# Build & Release Tally Connect

You are building, signing, notarizing, and publishing a new release of the Tally Connect Electron app.

## Pre-requisites

### Apple Developer ID Certificate (REQUIRED for Mac)

The following environment variables MUST be set before any signed Mac build. They are sourced from `~/.zshrc`:

| Variable | Purpose |
|---|---|
| `CSC_LINK` | Path to `.p12` certificate file OR base64-encoded certificate |
| `CSC_KEY_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

---

## Steps

### 1. Determine version

- If a version argument was provided, use it
- Otherwise, read the current version from `electron-app/package.json` and increment the patch number (e.g. 1.1.9 -> 1.1.10)

### 2. Bump version

Update the `"version"` field in all three package.json files:
- `electron-app/package.json`
- `relay-server/package.json`
- `church-client/package.json`

### 3. Commit and push

```bash
git add electron-app/package.json relay-server/package.json church-client/package.json
git commit -m "chore: bump version to v<VERSION>"
git push origin main
```

### 4. Clean dist and run release readiness check

```bash
rm -rf electron-app/dist/
```

Then run the release readiness check:

```bash
cd electron-app && npm run release:check
```

This validates signing + notarization env vars, required assets (icon.icns, icon.ico, entitlements.mac.plist), and certificate availability.

**IMPORTANT:** Use `npm run release:check` (full profile), NOT `release:check:mac` which skips signing checks.

### 5. Load Apple credentials and build

The Apple notarization credentials are in `~/.zshrc`. Source it before building:

```bash
source ~/.zshrc && cd /Users/andrewdisbrow/Documents/TallyConnect/church-av/electron-app && npm run build:mac:signed
```

Use a 10-minute timeout. Verify the output contains **"notarization successful"** for BOTH architectures. If notarization fails, stop and report the error.

### 6. Verify signing and notarization

**MUST do this before uploading. Never skip. If ANY check fails, DO NOT proceed.**

```bash
cd /Users/andrewdisbrow/Documents/TallyConnect/church-av/electron-app

# Verify code signature (both architectures):
codesign -v --deep --strict "dist/mac-arm64/Tally.app"
codesign -v --deep --strict "dist/mac/Tally.app"

# Verify Gatekeeper will accept it:
spctl --assess --type execute --verbose "dist/mac-arm64/Tally.app"
spctl --assess --type execute --verbose "dist/mac/Tally.app"
# Should output: accepted / source=Notarized Developer ID

# Verify DMG stapling:
stapler validate "dist/Tally-arm64.dmg"
stapler validate "dist/Tally-x64.dmg"
# Should output: The validate action worked!
```

If ANY of these fail, DO NOT proceed to upload. Stop and report the error.

### 7. Create GitHub release

Generate release notes from commits since the last tag:

```bash
git log $(git describe --tags --abbrev=0 HEAD~1)..HEAD --oneline --no-merges
```

Then create the release, uploading all artifacts from `electron-app/dist/`.

**DMG naming**: The electron-builder config uses `artifactName: "${productName}-${arch}.dmg"` so DMGs are **versionless** (`Tally-arm64.dmg`, `Tally-x64.dmg`). ZIPs are versioned.

```bash
DIST=/Users/andrewdisbrow/Documents/TallyConnect/church-av/electron-app/dist
gh release create v<VERSION> \
  "$DIST/Tally-arm64.dmg" \
  "$DIST/Tally-x64.dmg" \
  "$DIST/Tally-<VERSION>-arm64-mac.zip" \
  "$DIST/Tally-<VERSION>-mac.zip" \
  "$DIST/Tally-arm64.dmg.blockmap" \
  "$DIST/Tally-x64.dmg.blockmap" \
  "$DIST/Tally-<VERSION>-arm64-mac.zip.blockmap" \
  "$DIST/Tally-<VERSION>-mac.zip.blockmap" \
  "$DIST/latest-mac.yml" \
  --title "v<VERSION>" \
  --notes "<RELEASE_NOTES>"
```

Release notes format:
```
## What's New
<bullet points summarizing commits>

## Downloads
| File | Platform |
|------|----------|
| Tally-arm64.dmg | Apple Silicon (M1/M2/M3/M4) |
| Tally-x64.dmg | Intel Mac |
| Tally-Setup-<VERSION>.exe | Windows x64 |

Mac builds signed & notarized — Developer ID Application: Andrew Disbrow (HVSJPZDLZF)
Windows .exe added automatically via GitHub Actions after release creation.
```

### 8. Deploy relay server to Railway

Railway requires `railway up` CLI push -- git push to origin does NOT trigger a deploy.

```bash
cd /Users/andrewdisbrow/Documents/TallyConnect/church-av/relay-server && railway up
```

Then verify:

```bash
curl https://relay.tallyconnect.church/health
```

### 9. Trigger Windows build

The Windows `.exe` is built via GitHub Actions on `windows-latest`. Trigger the workflow and it will upload the `.exe` to the release automatically:

```bash
gh workflow run build-win.yml --ref main
```

Monitor the run:
```bash
gh run list --workflow=build-win.yml --limit=1
```

The workflow builds with `electron-builder --win --x64`, then uploads `*.exe`, `*.blockmap`, and `latest.yml` to the release tag matching the current version. No code signing on Windows (CSC_IDENTITY_AUTO_DISCOVERY=false).

### 10. Report

Print the release URL and confirm:
- Version bumped in all three package.json files
- Committed and pushed
- Release readiness check passed
- Both Mac architectures signed and notarized
- Signing verification passed (codesign, spctl, stapler)
- GitHub release created with Mac artifacts
- Relay server deployed and `/health` responds
- Windows build triggered (adds .exe to release automatically)

---

## Quick Reference: npm Scripts

| Script | What it does | When to use |
|---|---|---|
| `build:mac:signed` | Full signed + notarized Mac build | **Production releases** |
| `build:mac` | Bumps patch version + builds (signed if env set) | Dev builds with auto-bump |
| `build:mac:nobump` | Builds without version bump (signed if env set) | Re-building same version |
| `build:mac:unsigned` | Explicitly disables code signing | Local testing only |
| `release:check` | Full readiness check (signing + notarization) | Before any release build |
| `release:check:mac` | Mac-unsigned profile (skips signing) | Local testing only |

---

## Troubleshooting

### "The application is damaged" on Mac
The app was not signed or notarization failed. Rebuild with `build:mac:signed`.

### "Developer cannot be verified" Gatekeeper warning
Notarization ticket not stapled, or notarization failed silently. Check:
1. `stapler validate dist/Tally-arm64.dmg` -- should say "worked"
2. If not, check notarization status: `xcrun notarytool history --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_SPECIFIC_PASSWORD`
3. Get details on failed submission: `xcrun notarytool log <submission-id> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_SPECIFIC_PASSWORD`

### Notarization fails with "hardened runtime not enabled"
Check `hardenedRuntime: true` in package.json build config and entitlements file exists.

### Signing fails with "no identity found"
- Verify certificate is in Keychain: `security find-identity -v -p codesigning`
- Or verify `CSC_LINK` env var points to valid `.p12` file
- Check certificate hasn't expired

### electron-builder doesn't notarize
- Ensure `"notarize": true` is in package.json `build.mac` section
- Ensure `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are set
- electron-builder v26+ uses built-in notarization (no separate afterSign hook needed)

### afterPack fails with npm ci errors
The `scripts/afterPack.js` hook runs `npm ci --omit=dev` for church-client inside the bundle. If it fails:
- Check that `church-client/package-lock.json` exists and is valid
- Ensure network access is available during build

---

## Release Verification Checklist

Before announcing any release, verify ALL of the following:

- [ ] Version bumped in all three package.json files
- [ ] Git tag created and pushed
- [ ] `npm run release:check` passes (full profile, not mac-unsigned)
- [ ] Mac arm64 build: `codesign -v` passes
- [ ] Mac x64 build: `codesign -v` passes
- [ ] Mac arm64 build: `spctl --assess` shows "Notarized Developer ID"
- [ ] Mac x64 build: `spctl --assess` shows "Notarized Developer ID"
- [ ] DMGs stapled: `stapler validate` passes
- [ ] GitHub release created with Mac artifacts
- [ ] Relay server deployed and `/health` responds
- [ ] Windows build completed via GitHub Actions
- [ ] All assets uploaded to GitHub release (DMGs, ZIPs, EXE, blockmaps, latest.yml, latest-mac.yml)
- [ ] Auto-update works: install old version, verify it detects and installs new version
