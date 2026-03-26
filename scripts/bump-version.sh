#!/bin/bash
# Bump version across all packages, commit, and tag
# Usage: ./scripts/bump-version.sh [major|minor|patch]
#   patch: 1.1.0 → 1.1.1
#   minor: 1.1.0 → 1.2.0
#   major: 1.1.0 → 2.0.0

set -e

BUMP_TYPE="${1:-patch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Read current version from electron-app (source of truth)
CURRENT=$(node -p "require('$ROOT/electron-app/package.json').version")

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

echo "Bumping version: $CURRENT → $NEW_VERSION ($BUMP_TYPE)"

# Update all three package.json files
for PKG in electron-app relay-server church-client; do
  node -e "
    const fs = require('fs');
    const path = '$ROOT/$PKG/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ $PKG/package.json → $NEW_VERSION"
done

# Stage, commit, and tag
cd "$ROOT"
git add electron-app/package.json relay-server/package.json church-client/package.json
git commit -m "chore: bump version to v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo ""
echo "✅ Version bumped to v$NEW_VERSION"
echo "   Commit created and tagged as v$NEW_VERSION"
echo ""
echo "To push: git push && git push --tags"
echo "To build DMG: cd electron-app && npm run build:mac"
