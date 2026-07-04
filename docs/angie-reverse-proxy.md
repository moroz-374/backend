# Angie reverse proxy

This is the supported automatic-TLS Angie variant for Remnawave Traffic Audit release `2.7.4-traffic-audit.4`. It uses the pinned official `docker.angie.software/angie:1.11.8-templated` image, Angie's built-in open-source ACME module and the existing `remnawave-network` created by the panel Compose project.

## Prerequisites

- The panel stack is running from `/opt/remnawave` and `remnawave-network` exists.
- `PANEL_DOMAIN` and `SUB_PUBLIC_DOMAIN` have public A/AAAA records pointing to this host.
- TCP ports 80 and 443 are allowed through the host and provider firewalls.
- No other service is listening on host ports 80 or 443.
- This configuration is a direct Internet edge. A CDN or load balancer in front requires an explicit trusted-proxy/RealIP policy.

The panel application and metrics remain bound to `127.0.0.1`; PostgreSQL, Valkey and ClickHouse have no host port mappings. Angie reaches `remnawave:3000` over the shared Docker network.

## Install

Download the files from the same immutable backend release tag as the panel:

```bash
sudo install -d -m 0755 /opt/remnawave/angie
base=https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.4
sudo curl -fsSLo /opt/remnawave/angie/compose.yml "$base/deploy/angie/compose.yml"
sudo curl -fsSLo /opt/remnawave/angie/remnawave.conf.template \
  "$base/deploy/angie/remnawave.conf.template"
sudo curl -fsSLo /opt/remnawave/angie/.env "$base/deploy/angie/.env.sample"
sudo chmod 0600 /opt/remnawave/angie/.env
sudoedit /opt/remnawave/angie/.env
```

Validate Compose and the fully rendered Angie configuration before starting:

```bash
cd /opt/remnawave/angie
sudo docker compose config --quiet
sudo docker compose run --rm --no-deps angie angie -t
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 angie
```

The official templated image renders the domain and ACME email variables at container startup. Angie obtains and renews one certificate covering both configured domains through HTTP-01. Account keys, private keys and certificates are stored in the named volume `remnawave-angie-acme`; never delete it during routine updates or restarts.

## Security and forwarded headers

Only TCP 80 and 443 are exposed. HTTP redirects permanently to HTTPS. The direct-edge configuration overwrites incoming `X-Forwarded-For` with the actual TCP peer address, so a client cannot spoof its IP through that header. It also supplies `X-Real-IP`, `X-Forwarded-Host` and `X-Forwarded-Proto`. WebSocket upgrade headers are forwarded explicitly.

HTTP access logging is disabled because subscription URLs contain user credentials. Angie startup, proxy and ACME diagnostics remain available through `docker compose logs angie`.

## Verification

Run from a machine outside the VPS after DNS propagation:

```bash
curl -fsSI http://panel.example.com/
curl -fsSI https://panel.example.com/
curl -fsSI https://panel.example.com/api/health
curl -fsSI https://sub.example.com/api/sub/TEST
```

HTTP must redirect to HTTPS. HTTPS must reach the application; `401` or `404` is acceptable for unauthenticated or placeholder API/subscription values. During E2E acceptance, verify browser login, authenticated API calls, a real subscription, a WebSocket-dependent live UI action and the client IP observed by the application.

Confirm public bindings, network membership and certificate persistence:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3001|5432|6379|8123|9000)\\b'
sudo docker inspect remnawave-angie --format '{{json .NetworkSettings.Networks}}'
sudo docker compose exec angie find /var/lib/angie/acme -maxdepth 2 -type f -exec ls -l {} \;
sudo docker compose logs --tail=100 angie
```

Expected host bindings are `*:80`, `*:443`, `127.0.0.1:3000` and `127.0.0.1:3001`. There must be no public binding for application or storage ports.

## Reload, update and rollback

After changing `.env` or the configuration template, validate the newly rendered configuration and recreate the container. Recreating is required for environment changes:

```bash
cd /opt/remnawave/angie
sudo docker compose run --rm --no-deps angie angie -t
sudo docker compose up -d --force-recreate
```

For a configuration already rendered inside the running container, Angie supports a graceful reload with `docker compose kill -s HUP angie`. The versioned host-side template is rendered only at container startup, so the supported host-template workflow is validation followed by recreation.

For a versioned proxy update:

```bash
cd /opt/remnawave/angie
sudo docker compose pull
sudo docker compose up -d
```

Rollback by restoring the previous versioned `compose.yml` and template, validating them, and running `docker compose up -d --force-recreate`. The ACME volume remains intact and avoids unnecessary certificate reissuance.
