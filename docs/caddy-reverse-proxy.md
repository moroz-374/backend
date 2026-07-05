# Caddy reverse proxy

This is the supported automatic-TLS proxy variant for Remnawave Traffic Audit release `2.7.4-traffic-audit.6`. It uses the pinned official `caddy:2.10.2-alpine` image and the existing `remnawave-network` created by the panel Compose project.

## Prerequisites

- The panel stack is running from `/opt/remnawave` and its `remnawave-network` exists.
- `PANEL_DOMAIN` and `SUB_PUBLIC_DOMAIN` have public A/AAAA records pointing to this host.
- TCP ports 80 and 443 and UDP port 443 are allowed through the host and provider firewalls.
- No other service is listening on host ports 80 or 443.
- Do not proxy the panel through a CDN or another load balancer with this direct-edge configuration. Such a topology needs an explicit trusted-proxy policy.

The panel production Compose publishes its application and metrics ports only on `127.0.0.1`. PostgreSQL, Valkey and ClickHouse have no host port mappings. Caddy reaches the application directly as `remnawave:3000` over the shared Docker network; no panel port is exposed publicly.

## Install

Download the files from the same immutable backend release tag as the panel:

```bash
sudo install -d -m 0755 /opt/remnawave/caddy
sudo curl -fsSLo /opt/remnawave/caddy/compose.yml \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.6/deploy/caddy/compose.yml
sudo curl -fsSLo /opt/remnawave/caddy/Caddyfile \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.6/deploy/caddy/Caddyfile
sudo curl -fsSLo /opt/remnawave/caddy/.env \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.6/deploy/caddy/.env.sample
sudo chmod 0600 /opt/remnawave/caddy/.env
sudoedit /opt/remnawave/caddy/.env
```

Validate both Compose and the adapted Caddy configuration before starting:

```bash
cd /opt/remnawave/caddy
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose up -d
sudo docker compose ps
```

Caddy obtains and renews certificates automatically. Its `/data` and `/config` directories use persistent named volumes; do not delete `remnawave-caddy-data` during a routine update.

## Verification

Run these checks from a machine outside the VPS after DNS propagation:

```bash
curl -fsSI http://panel.example.com/
curl -fsSI https://panel.example.com/
curl -fsSI https://panel.example.com/api/health
curl -fsSI https://sub.example.com/api/sub/TEST
```

The HTTP requests must redirect to HTTPS. HTTPS requests must reach the panel rather than return a proxy connection error; application-level `401` or `404` responses are acceptable for unauthenticated or placeholder API/subscription values. Browser login, API calls, subscription retrieval and a WebSocket-dependent live UI action must be checked with real credentials during E2E acceptance.

Confirm that only Caddy is publicly bound and internal services remain private:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3001|5432|6379|8123|9000)\\b'
sudo docker inspect remnawave-caddy --format '{{json .NetworkSettings.Networks}}'
sudo docker compose logs --tail=100 caddy
```

Expected host bindings are `*:80`, `*:443`, `127.0.0.1:3000` and `127.0.0.1:3001`. There must be no public bindings for ports 3000, 3001, 5432, 6379, 8123 or 9000.

Caddy's `reverse_proxy` supplies `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` and supports WebSocket upgrades without route-specific configuration. The single upstream rule therefore covers the frontend, API and subscription routes consistently.

HTTP access logging is intentionally disabled because subscription URLs contain user credentials. Caddy service and certificate diagnostics remain available through `docker compose logs caddy`.

## Reload and update

After editing the Caddyfile, validate and reload without dropping active connections:

```bash
cd /opt/remnawave/caddy
sudo docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

For a versioned proxy update:

```bash
cd /opt/remnawave/caddy
sudo docker compose pull
sudo docker compose up -d
```

Rollback by restoring the previous versioned `compose.yml` and `Caddyfile`, validating them, and running `docker compose up -d` again. Certificate/account state remains in the named volumes.
