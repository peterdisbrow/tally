#!/bin/bash
# ============================================================
# Tally Encoder — Automated Install Script
# Supports: Raspberry Pi OS Lite (arm64), Ubuntu 20.04/22.04
#
# Usage: sudo bash setup.sh
# ============================================================

set -euo pipefail

INSTALL_DIR="/opt/tally-encoder"
CONFIG_DIR="/etc/tally-encoder"
LOG_DIR="/var/log"
SERVICE_USER="tally"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Root check ───────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  error "Please run as root: sudo bash setup.sh"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Tally Encoder Installer            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Detect OS / architecture ─────────────────────────────────
info "Detecting system..."
if [[ -f /etc/os-release ]]; then
  source /etc/os-release
  info "OS: $PRETTY_NAME"
else
  warn "Could not detect OS — assuming Debian-compatible"
fi

ARCH="$(uname -m)"
info "Architecture: $ARCH"

# ── Update package lists ──────────────────────────────────────
info "Updating package lists..."
apt-get update -qq

# ── Install ffmpeg ────────────────────────────────────────────
info "Installing ffmpeg..."
apt-get install -y -qq ffmpeg
FFMPEG_VERSION="$(ffmpeg -version 2>&1 | head -1)"
success "ffmpeg installed: $FFMPEG_VERSION"

# ── Install Node.js 18+ ───────────────────────────────────────
info "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VERSION="$(node --version)"
  MAJOR_VERSION="${NODE_VERSION#v}"
  MAJOR_VERSION="${MAJOR_VERSION%%.*}"
  if [[ "$MAJOR_VERSION" -ge 18 ]]; then
    success "Node.js $NODE_VERSION already installed"
  else
    warn "Node.js $NODE_VERSION is too old (need >=18). Installing LTS..."
    INSTALL_NODE=true
  fi
else
  info "Node.js not found. Installing LTS..."
  INSTALL_NODE=true
fi

if [[ "${INSTALL_NODE:-false}" == "true" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
fi

# ── Install npm packages ──────────────────────────────────────
info "Installing npm..."
apt-get install -y -qq npm 2>/dev/null || true
success "npm $(npm --version) ready"

# ── Create service user ───────────────────────────────────────
info "Creating service user '$SERVICE_USER'..."
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --groups video,audio,plugdev \
    "$SERVICE_USER" || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  success "User '$SERVICE_USER' created"
else
  success "User '$SERVICE_USER' already exists"
  # Ensure group memberships
  usermod -aG video,audio "$SERVICE_USER" 2>/dev/null || true
fi

# ── Create directories ────────────────────────────────────────
info "Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
touch "$LOG_DIR/tally-encoder.log"
touch "$LOG_DIR/tally-api.log"
chown "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR/tally-encoder.log" "$LOG_DIR/tally-api.log"
success "Directories ready"

# ── Copy application files ────────────────────────────────────
info "Installing application files to $INSTALL_DIR..."
cp "$SCRIPT_DIR/encoder.sh"   "$INSTALL_DIR/encoder.sh"
cp "$SCRIPT_DIR/api-server.js" "$INSTALL_DIR/api-server.js"
cp "$SCRIPT_DIR/package.json"  "$INSTALL_DIR/package.json"
chmod +x "$INSTALL_DIR/encoder.sh"
success "Application files installed"

# ── Install Node.js dependencies ──────────────────────────────
info "Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --quiet
success "npm packages installed"
cd "$SCRIPT_DIR"

# ── Install config (if not already present) ───────────────────
if [[ ! -f "$CONFIG_DIR/config.env" ]]; then
  info "Installing default config..."
  cp "$SCRIPT_DIR/config.env.example" "$CONFIG_DIR/config.env"
  chmod 640 "$CONFIG_DIR/config.env"
  chown root:"$SERVICE_USER" "$CONFIG_DIR/config.env"
  success "Default config installed at $CONFIG_DIR/config.env"
else
  warn "Config already exists at $CONFIG_DIR/config.env — not overwriting"
fi

# ── Tailscale VPN ────────────────────────────────────────────
echo ""
info "Setting up Tailscale VPN (remote access)..."
if command -v tailscale &>/dev/null; then
  success "Tailscale already installed: $(tailscale version | head -1)"
else
  info "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
  success "Tailscale installed"
fi

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  TAILSCALE AUTH KEY                                  │"
echo "  │  Generate a reusable key at:                         │"
echo "  │  https://login.tailscale.com/admin/settings/keys     │"
echo "  │  (tick 'Reusable' and 'Pre-approved')                │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
read -rp "  Paste your Tailscale auth key (or press Enter to skip): " TS_AUTH_KEY

if [[ -n "$TS_AUTH_KEY" ]]; then
  tailscale up --authkey="$TS_AUTH_KEY" --hostname="tally-$(hostname | tr '[:upper:]' '[:lower:]')" --accept-routes
  success "Tailscale connected: $(tailscale ip -4 2>/dev/null || echo 'check with: tailscale ip')"
else
  warn "Tailscale skipped — run manually: sudo tailscale up --authkey=YOUR_KEY"
fi

# ── SSH hardening ─────────────────────────────────────────────
echo ""
info "Hardening SSH..."

SSHD_CONFIG="/etc/ssh/sshd_config"

# Backup original
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%Y%m%d)" 2>/dev/null || true

# Apply hardening settings
declare -A SSH_SETTINGS=(
  ["PasswordAuthentication"]="no"
  ["PubkeyAuthentication"]="yes"
  ["PermitRootLogin"]="no"
  ["X11Forwarding"]="no"
  ["MaxAuthTries"]="3"
  ["ClientAliveInterval"]="300"
  ["ClientAliveCountMax"]="2"
)

for KEY in "${!SSH_SETTINGS[@]}"; do
  VALUE="${SSH_SETTINGS[$KEY]}"
  if grep -q "^#\?${KEY}" "$SSHD_CONFIG"; then
    sed -i "s|^#\?${KEY}.*|${KEY} ${VALUE}|" "$SSHD_CONFIG"
  else
    echo "${KEY} ${VALUE}" >> "$SSHD_CONFIG"
  fi
done

success "SSH hardened: password auth disabled, root login disabled"

# Prompt to add admin SSH public key
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  ADD ADMIN SSH PUBLIC KEY                            │"
echo "  │  Paste Andrew's public key so you can SSH in.        │"
echo "  │  (Get it with: cat ~/.ssh/id_ed25519.pub)            │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
read -rp "  Paste SSH public key (or press Enter to skip): " ADMIN_PUBKEY

if [[ -n "$ADMIN_PUBKEY" ]]; then
  ADMIN_HOME="/home/tally-admin"
  if ! id "tally-admin" &>/dev/null; then
    useradd --create-home --shell /bin/bash tally-admin
    usermod -aG sudo tally-admin
  fi
  mkdir -p "$ADMIN_HOME/.ssh"
  echo "$ADMIN_PUBKEY" >> "$ADMIN_HOME/.ssh/authorized_keys"
  chmod 700 "$ADMIN_HOME/.ssh"
  chmod 600 "$ADMIN_HOME/.ssh/authorized_keys"
  chown -R tally-admin:tally-admin "$ADMIN_HOME/.ssh"
  success "SSH key added for user 'tally-admin'"
else
  warn "No SSH key added — add manually to ~/.ssh/authorized_keys before locking password auth"
fi

# Restart SSH (use reload to avoid killing current session)
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || warn "Reload SSH manually: sudo systemctl reload sshd"
success "SSH configuration applied"

# ── Install systemd units ─────────────────────────────────────
info "Installing systemd service units..."
cp "$SCRIPT_DIR/tally-encoder.service" /etc/systemd/system/tally-encoder.service
cp "$SCRIPT_DIR/tally-api.service"     /etc/systemd/system/tally-api.service
success "Service units installed"

# ── Set ownership ─────────────────────────────────────────────
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Reload systemd and enable services ───────────────────────
info "Enabling and starting services..."
systemctl daemon-reload
systemctl enable tally-encoder tally-api
systemctl start tally-api
# Don't auto-start encoder until config is set
success "Services enabled"

# ── Print completion message ─────────────────────────────────
echo ""
TAILSCALE_IP="$(tailscale ip -4 2>/dev/null || echo 'not connected')"
LOCAL_IP="$(hostname -I | awk '{print $1}')"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅  Tally Encoder installed successfully!                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║  NEXT STEPS:                                                 ║"
echo "║                                                              ║"
echo "║  1. Edit config:                                             ║"
echo "║     sudo nano /etc/tally-encoder/config.env                  ║"
echo "║     Set: RELAY_URL, CHURCH_TOKEN, TALLY_API_TOKEN            ║"
echo "║                                                              ║"
echo "║  2. Start encoder:                                           ║"
echo "║     sudo systemctl restart tally-encoder                     ║"
echo "║                                                              ║"
echo "║  REMOTE ACCESS:                                              ║"
echo "║  Tailscale IP : $TAILSCALE_IP                    ║"
echo "║  Local IP     : $LOCAL_IP                        ║"
echo "║  SSH           : ssh tally-admin@$TAILSCALE_IP   ║"
echo "║  API           : http://$TAILSCALE_IP:7070/status ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Tally Encoder installed. Edit /etc/tally-encoder/config.env then: sudo systemctl restart tally-encoder"
