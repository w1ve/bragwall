#!/bin/bash
set -e

# ── Colours ───────────────────────────────────────────────────────────────────
GRN='\033[0;32m'; CYN='\033[0;36m'; YLW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${CYN}[info]${NC}  $*"; }
ok()    { echo -e "${GRN}[ok]${NC}    $*"; }
warn()  { echo -e "${YLW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

echo ""
echo -e "${CYN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYN}║       RBN S-Meter  —  Installer          ║${NC}"
echo -e "${CYN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Must run as root ──────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Please run as root: sudo ./install.sh"

# ── Check Docker is installed ─────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    warn "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    ok "Docker installed."
fi

if ! docker compose version &>/dev/null 2>&1; then
    warn "Docker Compose plugin not found. Installing..."
    apt-get install -y docker-compose-plugin 2>/dev/null || \
    yum install -y docker-compose-plugin 2>/dev/null || \
    error "Could not install docker-compose-plugin. Please install it manually."
    ok "Docker Compose installed."
fi

ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ── Detect public IP ──────────────────────────────────────────────────────────
info "Detecting public IP address..."
DETECTED_IP=$(curl -sf --max-time 5 https://api.ipify.org \
           || curl -sf --max-time 5 https://ifconfig.me \
           || curl -sf --max-time 5 https://icanhazip.com \
           || echo "")

if [ -n "$DETECTED_IP" ]; then
    ok "Detected public IP: ${DETECTED_IP}"
else
    warn "Could not auto-detect public IP."
fi

# ── Gather configuration ──────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── Configuration ────────────────────────────────────${NC}"
echo ""

# Domain
while true; do
    read -rp "  Domain name (e.g. meter.remote.radio): " DOMAIN
    DOMAIN="${DOMAIN// /}"   # strip spaces
    [ -n "$DOMAIN" ] && break
    warn "Domain cannot be empty."
done

# Email for certbot
read -rp "  Email for SSL certificate notices (leave blank to skip): " EMAIL

# Confirm / override IP
echo ""
if [ -n "$DETECTED_IP" ]; then
    read -rp "  Public IP detected as ${DETECTED_IP}. Press Enter to confirm or type a different IP: " INPUT_IP
    SERVER_IP="${INPUT_IP:-$DETECTED_IP}"
else
    while true; do
        read -rp "  Public IP of this server: " SERVER_IP
        [ -n "$SERVER_IP" ] && break
        warn "IP cannot be empty."
    done
fi

# Skip certbot option (useful for local testing)
echo ""
read -rp "  Use self-signed cert instead of Let's Encrypt? (y/N): " SKIP_CERT
if [[ "$SKIP_CERT" =~ ^[Yy]$ ]]; then
    SKIP_CERTBOT="true"
else
    SKIP_CERTBOT="false"
fi

# ── DNS check ─────────────────────────────────────────────────────────────────
echo ""
info "Checking DNS: ${DOMAIN} → ${SERVER_IP}"
RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)

if [ "$RESOLVED" = "$SERVER_IP" ]; then
    ok "DNS resolves correctly."
elif [ -z "$RESOLVED" ]; then
    warn "DNS for ${DOMAIN} does not resolve yet."
    warn "Make sure you have an A record: ${DOMAIN} → ${SERVER_IP}"
    warn "Let's Encrypt will fail until DNS is live."
    read -rp "  Continue anyway? (y/N): " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || { info "Exiting. Re-run once DNS is set up."; exit 0; }
else
    warn "DNS resolves to ${RESOLVED}, expected ${SERVER_IP}."
    warn "Let's Encrypt may fail if DNS doesn't match."
    read -rp "  Continue anyway? (y/N): " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || { info "Exiting."; exit 0; }
fi

# ── Write .env ────────────────────────────────────────────────────────────────
echo ""
info "Writing .env..."
cat > .env << ENVEOF
DOMAIN=${DOMAIN}
EMAIL=${EMAIL}
SERVER_IP=${SERVER_IP}
SKIP_CERTBOT=${SKIP_CERTBOT}
ENVEOF
ok ".env written."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── Summary ───────────────────────────────────────────${NC}"
echo "  Domain     : ${DOMAIN}"
echo "  Server IP  : ${SERVER_IP}"
echo "  Email      : ${EMAIL:-<none>}"
echo "  Self-signed: ${SKIP_CERTBOT}"
echo ""
read -rp "  Build and start now? (Y/n): " GO
[[ "$GO" =~ ^[Nn]$ ]] && { info "Run 'docker compose up -d --build' when ready."; exit 0; }

# ── Build and start ───────────────────────────────────────────────────────────
echo ""
info "Building Docker image..."
docker compose build

info "Starting container..."
docker compose up -d

# ── Wait and verify ───────────────────────────────────────────────────────────
echo ""
info "Waiting for container to start..."
sleep 6

if docker compose ps | grep -q "Up\|running"; then
    ok "Container is running."
else
    error "Container failed to start. Run 'docker compose logs' to diagnose."
fi

# Health check
if curl -sf --max-time 5 "http://localhost/health" &>/dev/null; then
    ok "Health endpoint responding."
else
    warn "Health endpoint not yet responding — may still be obtaining certificate."
fi

echo ""
echo -e "${GRN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GRN}║  Installation complete!                              ║${NC}"
echo -e "${GRN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GRN}║  URL : https://${DOMAIN}$(printf '%*s' $((38 - ${#DOMAIN})) '')║${NC}"
echo -e "${GRN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GRN}║  Useful commands:                                    ║${NC}"
echo -e "${GRN}║    docker compose logs -f        (live logs)         ║${NC}"
echo -e "${GRN}║    docker compose restart        (restart)           ║${NC}"
echo -e "${GRN}║    docker compose pull && \       (update)            ║${NC}"
echo -e "${GRN}║      docker compose up -d --build                   ║${NC}"
echo -e "${GRN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
