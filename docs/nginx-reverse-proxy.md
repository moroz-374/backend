# Nginx reverse proxy

This is the supported file-based TLS proxy variant for Remnawave Traffic Audit release `2.7.4-traffic-audit.3`. It uses the pinned official `nginx:1.30.3-alpine-slim` image, Certbot on the host and the existing `remnawave-network` created by the panel Compose project.

## Prerequisites

- The panel stack is running from `/opt/remnawave` and its `remnawave-network` exists.
- `PANEL_DOMAIN` and `SUB_PUBLIC_DOMAIN` have public A/AAAA records pointing to this host.
- TCP ports 80 and 443 are allowed through the host and provider firewalls.
- No other service is listening on host ports 80 or 443.
- Certbot is installed from the current Ubuntu/Debian package or snap and `/etc/letsencrypt` is retained in backups.
- Do not place a CDN or another load balancer in front of this direct-edge configuration. That topology requires an explicit trusted-proxy policy.

The panel production Compose publishes the application and metrics only on `127.0.0.1`. PostgreSQL, Valkey and ClickHouse have no host port mappings. Nginx reaches `remnawave:3000` over the shared Docker network.

## Install and issue the first certificate

Download all proxy files from the same immutable backend release tag as the panel:

```bash
sudo install -d -m 0755 /opt/remnawave/nginx/acme
sudo curl -fsSLo /opt/remnawave/nginx/compose.yml \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.3/deploy/nginx/compose.yml
sudo curl -fsSLo /opt/remnawave/nginx/remnawave.conf.template \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.3/deploy/nginx/remnawave.conf.template
sudo curl -fsSLo /opt/remnawave/nginx/.env \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.3/deploy/nginx/.env.sample
sudo chmod 0600 /opt/remnawave/nginx/.env
sudoedit /opt/remnawave/nginx/.env
```

Read the two domains from the reviewed file, then issue one certificate whose lineage name is the panel domain. The standalone bootstrap is used only before Nginx owns port 80:

```bash
cd /opt/remnawave/nginx
set -a; . ./.env; set +a
sudo certbot certonly --standalone --preferred-challenges http \
  --cert-name "$PANEL_DOMAIN" \
  -d "$PANEL_DOMAIN" -d "$SUB_PUBLIC_DOMAIN"
unset PANEL_DOMAIN SUB_PUBLIC_DOMAIN
```

Do not start Nginx if certificate issuance failed. Validate Compose and the rendered Nginx configuration before starting:

```bash
cd /opt/remnawave/nginx
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps nginx nginx -t
sudo docker compose up -d
sudo docker compose ps
```

The template substitution filter is intentional: only the two domain placeholders are expanded. Nginx variables such as `$host`, `$request_uri` and `$proxy_add_x_forwarded_for` remain intact.

## Renewal and safe reload

The HTTP server keeps `/.well-known/acme-challenge/` available from `/opt/remnawave/nginx/acme`, while all other HTTP requests redirect to HTTPS. Test renewal through that webroot:

```bash
sudo certbot renew --dry-run --webroot -w /opt/remnawave/nginx/acme
```

Run renewal at least twice daily with the platform's systemd timer or cron. Use a deploy hook so Nginx is tested and gracefully reloaded only after Certbot actually renews a certificate:

```bash
sudo certbot renew --webroot -w /opt/remnawave/nginx/acme \
  --deploy-hook 'cd /opt/remnawave/nginx && docker compose exec -T nginx sh -c "nginx -t && nginx -s reload"'
```

If the packaged Certbot timer already runs `certbot renew`, store the same deploy command in an executable root-owned script under `/etc/letsencrypt/renewal-hooks/deploy/` and configure the certificate's renewal authenticator as webroot. Verify the effective timer and renewal configuration on the target distribution; do not schedule a second competing renewal job.

For a manual configuration change, validate first and reload the master process without dropping active connections:

```bash
cd /opt/remnawave/nginx
sudo docker compose exec -T nginx nginx -t
sudo docker compose exec -T nginx nginx -s reload
```

## Verification

Run the external checks after DNS propagation:

```bash
curl -fsSI http://panel.example.com/
curl -fsSI https://panel.example.com/
curl -fsSI https://panel.example.com/api/health
curl -fsSI https://sub.example.com/api/sub/TEST
```

HTTP must redirect to HTTPS. HTTPS must reach the panel; application-level `401` or `404` is acceptable for unauthenticated or placeholder API/subscription values. Browser login, API calls, real subscription retrieval and a WebSocket-dependent live UI action remain part of E2E acceptance.

Confirm the certificate names, public bindings and shared network:

```bash
openssl s_client -connect panel.example.com:443 -servername panel.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
sudo ss -lntup | grep -E ':(80|443|3000|3001|5432|6379|8123|9000)\\b'
sudo docker inspect remnawave-nginx --format '{{json .NetworkSettings.Networks}}'
sudo docker compose logs --tail=100 nginx
```

Expected host bindings are `*:80`, `*:443`, `127.0.0.1:3000` and `127.0.0.1:3001`. There must be no public bindings for ports 3000, 3001, 5432, 6379, 8123 or 9000.

The proxy explicitly supplies `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`, and forwards WebSocket upgrade headers. A single upstream therefore covers frontend, API and subscription routes consistently. HTTP access logging is disabled because subscription URLs contain user credentials; error and certificate diagnostics remain available in Docker and Certbot logs.

## Update and rollback

For a versioned proxy update, save the current files, download the next immutable versions, then validate before recreating the container:

```bash
cd /opt/remnawave/nginx
sudo cp compose.yml compose.yml.previous
sudo cp remnawave.conf.template remnawave.conf.template.previous
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps nginx nginx -t
sudo docker compose pull
sudo docker compose up -d
```

Rollback by restoring the two `.previous` files, running the same Compose and `nginx -t` validations, and then `docker compose up -d`. Certificate files remain under `/etc/letsencrypt` and are not removed by Compose.
