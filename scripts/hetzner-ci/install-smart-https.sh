#!/bin/bash
# Add a separate HTTPS vhost. Existing application sites stay untouched.
set -euo pipefail
install -d -m 755 /var/www/aquilla-qa-acme
if ! test -f /etc/letsencrypt/live/aquilla-qa.5-161-201-46.sslip.io/fullchain.pem; then
  cat > /etc/nginx/sites-available/aquilla-qa <<'EOF'
server {
    listen 80;
    server_name aquilla-qa.5-161-201-46.sslip.io;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/aquilla-qa-acme;
    }
    location / { return 404; }
}
EOF
  ln -sf /etc/nginx/sites-available/aquilla-qa /etc/nginx/sites-enabled/aquilla-qa
  nginx -t
  systemctl reload nginx
fi
certbot certonly --webroot -w /var/www/aquilla-qa-acme \
  -d aquilla-qa.5-161-201-46.sslip.io --non-interactive --agree-tos \
  --keep-until-expiring
cat > /etc/nginx/sites-available/aquilla-qa <<'EOF'
limit_req_zone $binary_remote_addr zone=aquilla_qa:1m rate=5r/s;
server {
    listen 80;
    server_name aquilla-qa.5-161-201-46.sslip.io;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/aquilla-qa-acme;
    }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    server_name aquilla-qa.5-161-201-46.sslip.io;
    ssl_certificate /etc/letsencrypt/live/aquilla-qa.5-161-201-46.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aquilla-qa.5-161-201-46.sslip.io/privkey.pem;
    location ^~ /aquilla-qa/ {
        client_max_body_size 1m;
        limit_req zone=aquilla_qa burst=20 nodelay;
        access_log off;
        proxy_pass http://127.0.0.1:9086;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_read_timeout 15s;
    }
    location / { return 404; }
}
EOF
nginx -t
systemctl reload nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' \
  > /etc/letsencrypt/renewal-hooks/deploy/aquilla-qa-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/aquilla-qa-nginx
