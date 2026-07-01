#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

for variable in PANEL_DOMAIN SUB_PUBLIC_DOMAIN; do
  case "$variable" in
    PANEL_DOMAIN) value=${PANEL_DOMAIN:-} ;;
    SUB_PUBLIC_DOMAIN) value=${SUB_PUBLIC_DOMAIN:-} ;;
  esac
  case "$value" in
    ''|*[^A-Za-z0-9.-]*|.*|*..*|*.)
      echo "$variable must be a DNS name without scheme, port, path, or wildcard" >&2
      exit 1
      ;;
  esac
done

output=dynamic/remnawave.yml
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

sed \
  -e "s/__PANEL_DOMAIN__/$PANEL_DOMAIN/g" \
  -e "s/__SUB_PUBLIC_DOMAIN__/$SUB_PUBLIC_DOMAIN/g" \
  dynamic/remnawave.yml.template > "$temporary"
mv -f "$temporary" "$output"
trap - EXIT HUP INT TERM
