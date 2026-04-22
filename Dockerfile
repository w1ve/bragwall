FROM node:22-alpine

# Install nginx, certbot, supervisor, curl + native build tools for better-sqlite3
RUN apk add --no-cache \
    nginx \
    certbot \
    certbot-nginx \
    supervisor \
    curl \
    openssl \
    python3 \
    make \
    g++

# ── Node proxy ────────────────────────────────────────────────────────────────
WORKDIR /app/proxy
COPY proxy/proxy.js .
RUN npm install ws better-sqlite3

# ── Data directory for history DB ─────────────────────────────────────────────
RUN mkdir -p /data

# ── PWA static files ──────────────────────────────────────────────────────────
COPY pwa/ /usr/share/nginx/html/

# ── Nginx config (template — domain substituted at startup) ──────────────────
COPY nginx/nginx.conf       /etc/nginx/nginx.conf
COPY nginx/site.conf.tmpl              /etc/nginx/site.conf.tmpl
COPY nginx/rbnstrength.site.conf.tmpl /etc/nginx/rbnstrength.site.conf.tmpl

# ── Supervisor config ─────────────────────────────────────────────────────────
COPY supervisord.conf /etc/supervisord.conf

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Certbot webroot for ACME challenge
RUN mkdir -p /var/www/certbot /var/log/nginx /var/log/supervisor \
    /run/nginx /etc/nginx/sites-enabled

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
