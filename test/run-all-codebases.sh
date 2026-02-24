#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_step() {
  local title="$1"
  local dir="$2"
  local cmd="$3"
  echo
  echo "==> ${title}"
  (cd "${ROOT_DIR}/${dir}" && eval "${cmd}")
}

run_step "Relay Server tests (unit + integration)" "relay-server" "npm run test:all"
run_step "Church Client tests" "church-client" "npm test"
run_step "Electron App tests" "electron-app" "npm test"

echo
echo "All codebase checks passed."
