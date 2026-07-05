# Panel installation and upgrade

Supported hosts are Ubuntu and Debian on `amd64` or `arm64`, with Docker Engine and the Docker Compose v2 plugin already installed. Run the installer as root, or as a user that can write the installation directory and access the Docker daemon.

The installer downloads versioned files from the matching backend Git tag. The default installation directory is `/opt/remnawave`.

## Fresh installation

```bash
curl -fsSLo panel-installer.sh \
  https://raw.githubusercontent.com/moroz-374/backend/2.7.4-traffic-audit.6/scripts/panel-installer.sh
chmod +x panel-installer.sh
sudo ./panel-installer.sh install \
  --version 2.7.4-traffic-audit.6 \
  --panel-domain panel.example.com \
  --frontend-domain panel.example.com \
  --subscription-domain sub.example.com
```

The script checks the host and Docker, downloads `docker-compose-prod.yml` and `.env.sample`, generates all required secrets, validates the rendered Compose configuration, starts the stack, and waits for the panel healthcheck.

The panel application and metrics ports bind to `127.0.0.1` only. To publish the panel with automatic TLS, install the supported [Caddy reverse proxy](caddy-reverse-proxy.md) after the panel is healthy.

## Upgrade from official Remnawave 2.7.x

Run from any directory; point `--install-dir` at the existing directory if it is not `/opt/remnawave`.

```bash
sudo ./panel-installer.sh upgrade \
  --version 2.7.4-traffic-audit.6 \
  --install-dir /opt/remnawave
```

Before changing files, the script stores the existing `.env` and compose file plus a logical PostgreSQL dump under `/opt/remnawave/backups/<UTC timestamp>/`. Existing environment values, domains, and secrets are preserved. Missing traffic-audit variables are appended, and only a missing ClickHouse password is generated. The fixed `remnawave-db-data` volume name preserves the official PostgreSQL volume.

If startup or the healthcheck fails, the script prints an exact command that applies the generated `rollback-image.yml` override and restores the previously running backend image by registry digest when Docker exposes one. Restore the saved configuration or PostgreSQL dump separately if a database migration must also be reverted.
