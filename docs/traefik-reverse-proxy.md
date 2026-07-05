# Traefik reverse proxy

This is the supported automatic-TLS Traefik variant for Remnawave Traffic Audit release `2.7.4-traffic-audit.6`. It uses the pinned official `traefik:v3.7.5` image and the existing `remnawave-network` created by the panel Compose project.

## Prerequisites

- The panel stack is running from `/opt/remnawave` and `remnawave-network` exists.
- `PANEL_DOMAIN` and `SUB_PUBLIC_DOMAIN` have public A/AAAA records pointing to this host.
- TCP ports 80 and 443 are allowed through the host and provider firewalls.
- No other service is listening on host ports 80 or 443.
- This configuration is for a direct Internet edge. Do not put a CDN or load balancer in front without replacing the forwarded-header policy with explicit `trustedIPs` for that proxy.

The panel application and metrics remain bound to `127.0.0.1`; PostgreSQL, Valkey and ClickHouse have no host port mappings. Traefik reaches `remnawave:3000` over the shared Docker network.

## Install

Download all files from the same immutable backend release tag as the panel:

```bash
sudo install -d -m 0755 /opt/remnawave/traefik/dynamic
base=https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.6
sudo curl -fsSLo /opt/remnawave/traefik/compose.yml "$base/deploy/traefik/compose.yml"
sudo curl -fsSLo /opt/remnawave/traefik/traefik.yml "$base/deploy/traefik/traefik.yml"
sudo curl -fsSLo /opt/remnawave/traefik/render-config.sh "$base/deploy/traefik/render-config.sh"
sudo curl -fsSLo /opt/remnawave/traefik/dynamic/remnawave.yml.template \
  "$base/deploy/traefik/dynamic/remnawave.yml.template"
sudo curl -fsSLo /opt/remnawave/traefik/.env "$base/deploy/traefik/.env.sample"
sudo chmod 0755 /opt/remnawave/traefik/render-config.sh
sudo chmod 0600 /opt/remnawave/traefik/.env
sudoedit /opt/remnawave/traefik/.env
```

Render the exact host rules, validate Compose, then start:

```bash
cd /opt/remnawave/traefik
set -a; . ./.env; set +a
./render-config.sh
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 traefik
```

Traefik 3.7 does not provide a separate offline configuration-check command. Treat a healthy container and a startup log without static/dynamic configuration errors as the configuration validation gate. Traefik obtains and renews certificates through HTTP-01 and stores ACME account/certificate state in the `remnawave-traefik-acme` volume. Do not delete this volume during routine updates.

## Security model and client IP

The dashboard and insecure API are disabled, and neither port 8080 nor the internal ping endpoint is published. Only TCP 80 and 443 are exposed.

This direct-edge configuration does not trust client-supplied forwarded headers. Traefik derives the peer address itself and sends the application the normal `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` headers. WebSocket upgrades are handled by the HTTP proxy without a route-specific rule. If a trusted CDN or load balancer is later added, configure only its documented address ranges under `entryPoints.websecure.forwardedHeaders.trustedIPs`; never set `insecure: true` on a public entry point.

HTTP access logging is intentionally disabled because subscription URLs contain user credentials. Proxy, routing and ACME diagnostics remain available in the service log.

## Verification

Run from a machine outside the VPS after DNS propagation:

```bash
curl -fsSI http://panel.example.com/
curl -fsSI https://panel.example.com/
curl -fsSI https://panel.example.com/api/health
curl -fsSI https://sub.example.com/api/sub/TEST
```

HTTP must redirect permanently to HTTPS. HTTPS must reach the application; `401` or `404` is acceptable for unauthenticated or placeholder API/subscription values. During E2E acceptance, verify browser login, authenticated API calls, a real subscription, a WebSocket-dependent live UI action and the client IP recorded by the application.

Confirm public bindings, network membership and the absence of a dashboard listener:

```bash
sudo ss -lntup | grep -E ':(80|443|8080|3000|3001|5432|6379|8123|9000)\\b'
sudo docker inspect remnawave-traefik --format '{{json .NetworkSettings.Networks}}'
sudo docker compose logs --tail=100 traefik
```

Expected host bindings are `*:80`, `*:443`, `127.0.0.1:3000` and `127.0.0.1:3001`. There must be no public binding for 8080 or any application/storage port.

## Reload, update and rollback

The file provider watches the `dynamic` directory and reloads a changed dynamic file automatically. After changing domains, render the file and verify that the running instance accepted it:

```bash
cd /opt/remnawave/traefik
set -a; . ./.env; set +a
./render-config.sh
sleep 3
sudo docker compose ps
sudo docker compose logs --since=1m traefik
```

Static configuration changes require a restart. For a versioned image/configuration update:

```bash
cd /opt/remnawave/traefik
sudo docker compose pull
sudo docker compose up -d
```

Rollback by restoring the previous versioned `compose.yml`, `traefik.yml`, template and rendered dynamic file, validating them, then running `docker compose up -d`. The ACME volume remains intact.
