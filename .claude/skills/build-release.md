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

## Steps

### 1. Determine version

- If a version argument was provided, use it
- Otherwise, read the current version from `electron-app/package.json` and increment the patch number (e.g. 1.1.9 → 1.1.10)

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

### 4. Load Apple credentials and build

The Apple notarization credentials are in `~/.zshrc`. Source it before building:

```bash
source ~/.zshrc && cd /Users/andrewdisbrow/Documents/TallyConnect/church-av/electron-app && npx electron-builder --mac --arm64 --x64
```

Use a 10-minute timeout. Verify the output contains **"notarization successful"** for BOTH architectures. If notarization fails, stop and report the error.

### 5. Create GitHub release

Generate release notes from commits since the last tag:

```bash
git log $(git describe --tags --abbrev=0 HEAD~1)..HEAD --oneline --no-merges
```

Then create the release, uploading all artifacts from `electron-app/dist/`:

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

### 6. Trigger Windows build

The Windows `.exe` is built via GitHub Actions on `windows-latest`. Trigger the workflow and it will upload the `.exe` to the release automatically:

```bash
gh workflow run build-win.yml --ref main
```

Monitor the run:
```bash
gh run list --workflow=build-win.yml --limit=1
```

The workflow builds with `electron-builder --win --x64`, then uploads `*.exe`, `*.blockmap`, and `latest.yml` to the release tag matching the current version. No code signing on Windows (CSC_IDENTITY_AUTO_DISCOVERY=false).

### 7. Report

Print the release URL and confirm:
- Version bumped
- Committed and pushed
- Both Mac architectures signed and notarized
- GitHub release created with Mac artifacts
- Windows build triggered (adds .exe to release automatically)
