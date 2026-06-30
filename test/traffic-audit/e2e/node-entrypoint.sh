#!/bin/sh
set -eu

until [ -s /run/e2e/secret-key ] && [ -s /run/e2e/credential ]; do
    sleep 1
done

export SECRET_KEY="$(cat /run/e2e/secret-key)"
export TRAFFIC_AUDIT_CREDENTIAL="$(cat /run/e2e/credential)"

exec /usr/local/bin/docker-entrypoint.sh "$@"
