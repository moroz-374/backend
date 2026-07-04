#!/usr/bin/env bash
set -Eeuo pipefail

PROGRAM=${0##*/}
MODE=
VERSION=${REMNAWAVE_VERSION:-2.7.4-traffic-audit.3}
INSTALL_DIR=${REMNAWAVE_INSTALL_DIR:-/opt/remnawave}
ASSET_BASE_URL=${REMNAWAVE_ASSET_BASE_URL:-https://raw.githubusercontent.com/moroz-374/backend}
PANEL_DOMAIN_VALUE=
FRONT_END_DOMAIN_VALUE=
SUB_PUBLIC_DOMAIN_VALUE=
HEALTH_TIMEOUT=${REMNAWAVE_HEALTH_TIMEOUT:-300}
BACKUP_DIR=
ROLLBACK_FILE=
PREVIOUS_IMAGE=

usage() {
  cat <<EOF
Usage:
  $PROGRAM install --panel-domain DOMAIN --frontend-domain DOMAIN --subscription-domain DOMAIN [options]
  $PROGRAM upgrade [options]

Options:
  --version VERSION          Release tag (default: $VERSION)
  --install-dir PATH         Installation directory (default: $INSTALL_DIR)
  --asset-base-url URL       Source repository raw-content base URL
  --health-timeout SECONDS   Maximum healthcheck wait (default: $HEALTH_TIMEOUT)
  --panel-domain DOMAIN      PANEL_DOMAIN value (required for install)
  --frontend-domain DOMAIN   FRONT_END_DOMAIN value (required for install)
  --subscription-domain DOMAIN  SUB_PUBLIC_DOMAIN value (required for install)
  -h, --help                 Show this help
EOF
}

log() { printf '[%s] %s\n' "$PROGRAM" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$PROGRAM" "$*" >&2; return 1; }

on_error() {
  local exit_code=$?
  printf '[%s] FAILED (exit %s).\n' "$PROGRAM" "$exit_code" >&2
  if [[ -n "$BACKUP_DIR" ]]; then
    printf '[%s] Backup: %s\n' "$PROGRAM" "$BACKUP_DIR" >&2
  fi
  if [[ -n "$ROLLBACK_FILE" && -n "$PREVIOUS_IMAGE" ]]; then
    printf '[%s] Roll back the panel image to %s with:\n' "$PROGRAM" "$PREVIOUS_IMAGE" >&2
    printf 'cd %q && docker compose -f docker-compose.yml -f %q up -d --no-deps remnawave\n' \
      "$INSTALL_DIR" "$ROLLBACK_FILE" >&2
  fi
  exit "$exit_code"
}
trap on_error ERR

require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

validate_domain() {
  local name=$1 value=$2
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    fail "$name must be a domain without scheme, path, port, or trailing dot"
  [[ "$value" == *.* ]] || fail "$name must contain at least one dot"
}

validate_inputs() {
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-traffic-audit\.[0-9]+$ ]] ||
    fail "invalid release version: $VERSION"
  [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || fail "health timeout must be a positive integer"
  ASSET_BASE_URL=${ASSET_BASE_URL%/}
  [[ "$ASSET_BASE_URL" == https://* || "$ASSET_BASE_URL" == http://127.0.0.1:* || "$ASSET_BASE_URL" == http://localhost:* ]] ||
    fail "asset base URL must use HTTPS (HTTP is allowed only for local tests)"
}

preflight() {
  [[ -r /etc/os-release ]] || fail "/etc/os-release is unavailable; only Ubuntu and Debian are supported"
  local os_id
  os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  case "$os_id" in
    ubuntu|debian) ;;
    *) fail "unsupported operating system: ${os_id:-unknown}; use Ubuntu or Debian" ;;
  esac
  case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) fail "unsupported architecture: $(uname -m); use amd64 or arm64" ;;
  esac
  for command in awk chmod cp curl date docker grep head mkdir mktemp mv openssl sed sleep tar uname; do
    require_command "$command"
  done
  docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable or the current user cannot access it"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required (docker compose)"
}

set_env_value() {
  local file=$1 key=$2 value=$3 escaped
  escaped=${value//\/\\}
  escaped=${escaped//&/\&}
  escaped=${escaped//|/\|}
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

get_env_value() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file"
}

merge_missing_env() {
  local current=$1 sample=$2 key
  while IFS= read -r key; do
    grep -qE "^${key}=" "$current" || grep -E "^${key}=" "$sample" >>"$current"
  done < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "$sample")
}

generate_secret_if_empty() {
  local file=$1 key=$2 bytes=$3
  [[ -n "$(get_env_value "$file" "$key")" ]] || set_env_value "$file" "$key" "$(openssl rand -hex "$bytes")"
}

download_assets() {
  local temp_dir=$1 release_url
  release_url="$ASSET_BASE_URL/$VERSION"
  log "Downloading release assets for $VERSION"
  curl --fail --silent --show-error --location --proto '=https,http' --proto-redir '=https' --tlsv1.2 \
    "$release_url/docker-compose-prod.yml" -o "$temp_dir/docker-compose.yml"
  curl --fail --silent --show-error --location --proto '=https,http' --proto-redir '=https' --tlsv1.2 \
    "$release_url/.env.sample" -o "$temp_dir/env.sample"
  [[ -s "$temp_dir/docker-compose.yml" && -s "$temp_dir/env.sample" ]] || fail "downloaded release assets are empty"
  grep -q 'ghcr.io/moroz-374/remnawave-backend' "$temp_dir/docker-compose.yml" || fail "unexpected compose asset"
  grep -q '^REMNAWAVE_VERSION=' "$temp_dir/env.sample" || fail "unexpected environment sample"
}

resolve_previous_image() {
  local configured image_id digest
  docker container inspect remnawave >/dev/null 2>&1 || return 0
  configured=$(docker container inspect --format '{{.Config.Image}}' remnawave)
  image_id=$(docker container inspect --format '{{.Image}}' remnawave)
  digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null | head -n1 || true)
  PREVIOUS_IMAGE=${digest:-$configured}
}

create_backup() {
  local timestamp config_archive
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP_DIR="$INSTALL_DIR/backups/$timestamp"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$INSTALL_DIR/backups" "$BACKUP_DIR"
  config_archive="$BACKUP_DIR/configuration.tar.gz"
  tar -C "$INSTALL_DIR" -czf "$config_archive" docker-compose.yml .env
  chmod 600 "$config_archive"

  docker container inspect remnawave-db >/dev/null 2>&1 ||
    fail "running remnawave-db container is required for a safe upgrade"
  log "Backing up PostgreSQL"
  docker exec remnawave-db sh -ceu 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' \
    >"$BACKUP_DIR/postgresql.sql"
  [[ -s "$BACKUP_DIR/postgresql.sql" ]] || fail "PostgreSQL backup is empty"
  chmod 600 "$BACKUP_DIR/postgresql.sql"

  if [[ -n "$PREVIOUS_IMAGE" ]]; then
    ROLLBACK_FILE="$BACKUP_DIR/rollback-image.yml"
    printf 'services:\n  remnawave:\n    image: %s\n' "$PREVIOUS_IMAGE" >"$ROLLBACK_FILE"
    chmod 600 "$ROLLBACK_FILE"
  fi
}

wait_for_health() {
  local deadline status
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    status=$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' remnawave 2>/dev/null || true)
    case "$status" in
      healthy)
        log "Panel is healthy"
        return 0
        ;;
      exited|dead)
        docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" ps >&2 || true
        docker logs --tail 100 remnawave >&2 || true
        fail "panel container entered state: $status"
        ;;
    esac
    sleep 3
  done
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" ps >&2 || true
  docker logs --tail 100 remnawave >&2 || true
  fail "panel did not become healthy within ${HEALTH_TIMEOUT}s"
}

install_panel() {
  local temp_dir env_file
  [[ ! -e "$INSTALL_DIR/.env" && ! -e "$INSTALL_DIR/docker-compose.yml" ]] ||
    fail "$INSTALL_DIR already contains an installation; use upgrade"
  validate_domain PANEL_DOMAIN "$PANEL_DOMAIN_VALUE"
  validate_domain FRONT_END_DOMAIN "$FRONT_END_DOMAIN_VALUE"
  validate_domain SUB_PUBLIC_DOMAIN "$SUB_PUBLIC_DOMAIN_VALUE"
  mkdir -p "$INSTALL_DIR"
  temp_dir=$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")
  trap 'rm -rf -- "$temp_dir"' RETURN
  download_assets "$temp_dir"
  env_file="$temp_dir/.env"
  cp "$temp_dir/env.sample" "$env_file"
  set_env_value "$env_file" REMNAWAVE_VERSION "$VERSION"
  set_env_value "$env_file" PANEL_DOMAIN "$PANEL_DOMAIN_VALUE"
  set_env_value "$env_file" FRONT_END_DOMAIN "$FRONT_END_DOMAIN_VALUE"
  set_env_value "$env_file" SUB_PUBLIC_DOMAIN "$SUB_PUBLIC_DOMAIN_VALUE"
  generate_secret_if_empty "$env_file" JWT_AUTH_SECRET 64
  generate_secret_if_empty "$env_file" JWT_API_TOKENS_SECRET 64
  generate_secret_if_empty "$env_file" METRICS_PASS 32
  generate_secret_if_empty "$env_file" WEBHOOK_SECRET_HEADER 32
  generate_secret_if_empty "$env_file" POSTGRES_PASSWORD 32
  generate_secret_if_empty "$env_file" TRAFFIC_AUDIT_CLICKHOUSE_PASSWORD 32
  chmod 600 "$env_file"
  mv "$temp_dir/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  mv "$env_file" "$INSTALL_DIR/.env"
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" config --quiet
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" up -d
  wait_for_health
}

upgrade_panel() {
  local temp_dir staged_env key
  [[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/docker-compose.yml" ]] ||
    fail "$INSTALL_DIR is not an existing installation"
  resolve_previous_image
  create_backup
  temp_dir=$(mktemp -d "$INSTALL_DIR/.upgrade.XXXXXX")
  trap 'rm -rf -- "$temp_dir"' RETURN
  download_assets "$temp_dir"
  staged_env="$temp_dir/.env"
  cp "$INSTALL_DIR/.env" "$staged_env"
  merge_missing_env "$staged_env" "$temp_dir/env.sample"
  set_env_value "$staged_env" REMNAWAVE_VERSION "$VERSION"
  generate_secret_if_empty "$staged_env" TRAFFIC_AUDIT_CLICKHOUSE_PASSWORD 32
  for key in PANEL_DOMAIN FRONT_END_DOMAIN SUB_PUBLIC_DOMAIN JWT_AUTH_SECRET JWT_API_TOKENS_SECRET POSTGRES_PASSWORD METRICS_PASS WEBHOOK_SECRET_HEADER; do
    [[ -n "$(get_env_value "$staged_env" "$key")" ]] || fail "existing .env has no value for required variable $key"
  done
  chmod 600 "$staged_env"
  docker compose -f "$temp_dir/docker-compose.yml" --env-file "$staged_env" config --quiet
  mv "$temp_dir/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  mv "$staged_env" "$INSTALL_DIR/.env"
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" pull
  docker compose -f "$INSTALL_DIR/docker-compose.yml" --env-file "$INSTALL_DIR/.env" up -d --remove-orphans
  wait_for_health
}

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
MODE=$1
shift
case "$MODE" in install|upgrade) ;; -h|--help) usage; exit 0 ;; *) usage >&2; fail "unknown mode: $MODE" ;; esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION=${2:?missing value for --version}; shift 2 ;;
    --install-dir) INSTALL_DIR=${2:?missing value for --install-dir}; shift 2 ;;
    --asset-base-url) ASSET_BASE_URL=${2:?missing value for --asset-base-url}; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT=${2:?missing value for --health-timeout}; shift 2 ;;
    --panel-domain) PANEL_DOMAIN_VALUE=${2:?missing value for --panel-domain}; shift 2 ;;
    --frontend-domain) FRONT_END_DOMAIN_VALUE=${2:?missing value for --frontend-domain}; shift 2 ;;
    --subscription-domain) SUB_PUBLIC_DOMAIN_VALUE=${2:?missing value for --subscription-domain}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

validate_inputs
preflight
case "$MODE" in
  install) install_panel ;;
  upgrade) upgrade_panel ;;
esac
log "$MODE completed for version $VERSION in $INSTALL_DIR"
if [[ -n "$BACKUP_DIR" ]]; then log "Backup saved to $BACKUP_DIR"; fi
