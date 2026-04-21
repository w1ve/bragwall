#!/bin/sh
set -e

DOMAIN="${DOMAIN}"
EMAIL="${EMAIL:-}"
SKIP_CERTBOT="${SKIP_CERTBOT:-false}"
STRENGTH_DOMAIN="${STRENGTH_DOMAIN:-rbnstrength.rm.gl}"

echo "======================================"
echo "  hfsignals.live + RBNStrength"
echo "  Domain          : ${DOMAIN}"
echo "  Strength Domain : ${STRENGTH_DOMAIN}"
echo "  Certbot         : ${SKIP_CERTBOT}"
echo "======================================"

# ── Generate site configs from templates ──────────────────────────────────────
sed "s/__DOMAIN__/${DOMAIN}/g" /etc/nginx/site.conf.tmpl \
    > /etc/nginx/sites-enabled/rbn-smeter.conf

sed "s/__STRENGTH_DOMAIN__/${STRENGTH_DOMAIN}/g" /etc/nginx/rbnstrength.site.conf.tmpl \
    > /etc/nginx/sites-enabled/rbnstrength.conf

# ── Obtain SSL certificate for rbn-smeter if not present ─────────────────────
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

if [ "${SKIP_CERTBOT}" = "true" ]; then
    echo "[entrypoint] SKIP_CERTBOT=true — generating self-signed cert for testing"
    mkdir -p "/etc/letsencrypt/live/${DOMAIN}"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" \
        -out    "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" \
        -subj   "/CN=${DOMAIN}" 2>/dev/null
    # Also self-sign for strength domain
    mkdir -p "/etc/letsencrypt/live/${STRENGTH_DOMAIN}"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "/etc/letsencrypt/live/${STRENGTH_DOMAIN}/privkey.pem" \
        -out    "/etc/letsencrypt/live/${STRENGTH_DOMAIN}/fullchain.pem" \
        -subj   "/CN=${STRENGTH_DOMAIN}" 2>/dev/null
    echo "[entrypoint] Self-signed certs created."

elif [ ! -f "${CERT_PATH}" ]; then
    echo "[entrypoint] No certificate found — running certbot for both domains..."

    cat > /etc/nginx/sites-enabled/rbn-smeter.conf << HTTPONLY
server {
    listen 80;
    server_name ${DOMAIN} ${STRENGTH_DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'starting up'; add_header Content-Type text/plain; }
}
HTTPONLY

    nginx &
    NGINX_PID=$!
    sleep 2

    if [ -n "${EMAIL}" ]; then
        EMAIL_OPT="--email ${EMAIL} --agree-tos --no-eff-email"
    else
        EMAIL_OPT="--register-unsafely-without-email"
    fi

    certbot certonly --webroot --webroot-path /var/www/certbot \
        --domain "${DOMAIN}" ${EMAIL_OPT} \
        --non-interactive --keep-until-expiring || {
            echo "[entrypoint] certbot failed for ${DOMAIN} — falling back to self-signed"
            mkdir -p "/etc/letsencrypt/live/${DOMAIN}"
            openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                -keyout "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" \
                -out    "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" \
                -subj   "/CN=${DOMAIN}" 2>/dev/null
        }

    certbot certonly --webroot --webroot-path /var/www/certbot \
        --domain "${STRENGTH_DOMAIN}" ${EMAIL_OPT} \
        --non-interactive --keep-until-expiring || {
            echo "[entrypoint] certbot failed for ${STRENGTH_DOMAIN} — falling back to self-signed"
            mkdir -p "/etc/letsencrypt/live/${STRENGTH_DOMAIN}"
            openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                -keyout "/etc/letsencrypt/live/${STRENGTH_DOMAIN}/privkey.pem" \
                -out    "/etc/letsencrypt/live/${STRENGTH_DOMAIN}/fullchain.pem" \
                -subj   "/CN=${STRENGTH_DOMAIN}" 2>/dev/null
        }

    kill $NGINX_PID 2>/dev/null || true
    wait $NGINX_PID 2>/dev/null || true

    # Restore full configs
    sed "s/__DOMAIN__/${DOMAIN}/g" /etc/nginx/site.conf.tmpl \
        > /etc/nginx/sites-enabled/rbn-smeter.conf
    sed "s/__STRENGTH_DOMAIN__/${STRENGTH_DOMAIN}/g" /etc/nginx/rbnstrength.site.conf.tmpl \
        > /etc/nginx/sites-enabled/rbnstrength.conf

    echo "[entrypoint] Certificates obtained."

else
    echo "[entrypoint] Certificates already present — skipping certbot."
    # Still get strength cert if missing
    STRENGTH_CERT="/etc/letsencrypt/live/${STRENGTH_DOMAIN}/fullchain.pem"
    if [ ! -f "${STRENGTH_CERT}" ]; then
        echo "[entrypoint] Getting cert for ${STRENGTH_DOMAIN}..."
        if [ -n "${EMAIL}" ]; then
            EMAIL_OPT="--email ${EMAIL} --agree-tos --no-eff-email"
        else
            EMAIL_OPT="--register-unsafely-without-email"
        fi
        certbot certonly --webroot --webroot-path /var/www/certbot \
            --domain "${STRENGTH_DOMAIN}" ${EMAIL_OPT} \
            --non-interactive --keep-until-expiring || \
        echo "[entrypoint] certbot for ${STRENGTH_DOMAIN} failed — will run HTTP only"
    fi
fi

# ── Auto-renew ────────────────────────────────────────────────────────────────
renew_loop() {
    while true; do
        sleep 12h
        certbot renew --quiet --webroot --webroot-path /var/www/certbot \
            && nginx -s reload 2>/dev/null || true
    done
}
renew_loop &

# ── Hand off to supervisor ────────────────────────────────────────────────────
echo "[entrypoint] Starting services via supervisord..."
exec supervisord -c /etc/supervisord.conf
