#!/bin/bash
#
# Configure Railway env vars for production.
# Run from the relay-server directory after `railway link`.
#
# Usage:
#   chmod +x scripts/setup-railway-env.sh
#   scripts/setup-railway-env.sh
#
# Prerequisites:
#   - railway CLI installed and authenticated (railway login)
#   - Project linked (railway link)
#   - Stripe setup script already run (to get price IDs)

set -euo pipefail

SERVICE="tally"

echo ""
echo "  Railway Environment Setup for Tally Relay"
echo "  ─────────────────────────────────────────"
echo ""

# ─── Backup Config ────────────────────────────────────────────────────────────
# Backups are automatic in production (every 15 min by default)
railway variables set \
  DB_BACKUP_INTERVAL_MINUTES=15 \
  BACKUP_RETAIN_COUNT=96 \
  NODE_ENV=production \
  LOG_FORMAT=json \
  -s "$SERVICE" 2>/dev/null && echo "  ✓ Backup + logging config set" || echo "  ✗ Failed to set backup config"

# ─── Prompt for secrets ───────────────────────────────────────────────────────

echo ""
echo "  The following env vars need manual values."
echo "  Press Enter to skip any you've already set."
echo ""

read -rp "  SENTRY_DSN (from sentry.io): " SENTRY_DSN
if [ -n "$SENTRY_DSN" ]; then
  railway variables set SENTRY_DSN="$SENTRY_DSN" -s "$SERVICE" 2>/dev/null
  echo "  ✓ SENTRY_DSN set"
fi

read -rp "  BACKUP_ENCRYPTION_KEY (any passphrase): " BACKUP_KEY
if [ -n "$BACKUP_KEY" ]; then
  railway variables set BACKUP_ENCRYPTION_KEY="$BACKUP_KEY" -s "$SERVICE" 2>/dev/null
  echo "  ✓ BACKUP_ENCRYPTION_KEY set"
fi

echo ""
echo "  ─── Stripe Price IDs ───"
echo "  (Run 'node scripts/setup-stripe.js' first to get these)"
echo ""

STRIPE_VARS=(
  STRIPE_PRICE_CONNECT
  STRIPE_PRICE_CONNECT_ANNUAL
  STRIPE_PRICE_PLUS
  STRIPE_PRICE_PLUS_ANNUAL
  STRIPE_PRICE_PRO
  STRIPE_PRICE_PRO_ANNUAL
  STRIPE_PRICE_MANAGED
  STRIPE_PRICE_MANAGED_ANNUAL
  STRIPE_PRICE_EVENT
)

for var in "${STRIPE_VARS[@]}"; do
  read -rp "  $var: " val
  if [ -n "$val" ]; then
    railway variables set "$var=$val" -s "$SERVICE" 2>/dev/null
    echo "  ✓ $var set"
  fi
done

echo ""
echo "  Done! Run 'railway variables -s $SERVICE' to verify."
echo "  Deploy with: railway up -s $SERVICE --detach"
echo ""
