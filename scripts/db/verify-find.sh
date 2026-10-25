#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly PROJECT_ROOT

for required_command in docker openssl python3 npm; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
        echo "${required_command} is required for finder database verification." >&2
        exit 1
    fi
done

if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo 'Docker and Docker Compose are required for finder database verification.' >&2
    exit 1
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/repoexplorer-find-verify.XXXXXX")"
readonly TEST_ROOT
readonly ENV_FILE="${TEST_ROOT}/.env"
readonly PROJECT_NAME="repoexplorer-find-verify-$$-$(openssl rand -hex 4)"
readonly DATABASE_NAME='repoexplorer_find_test'
readonly ADMIN_USER='repoexplorer_find_admin'
readonly APPLICATION_USER='repoexplorer_find_app'
STACK_STARTED=0

cleanup() {
    local status=$?
    trap - EXIT
    if [[ "${STACK_STARTED}" -eq 1 ]]; then
        compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    rm -rf -- "${TEST_ROOT}"
    exit "${status}"
}
trap cleanup EXIT

compose() {
    docker compose \
        --project-name "${PROJECT_NAME}" \
        --project-directory "${PROJECT_ROOT}" \
        --env-file "${ENV_FILE}" \
        --file "${PROJECT_ROOT}/compose.yaml" \
        "$@"
}

ADMIN_PASSWORD="$(openssl rand -hex 32)"
APPLICATION_PASSWORD="$(openssl rand -hex 32)"
HOST_PORT="$(python3 -c 'import socket; sock = socket.socket(); sock.bind(("127.0.0.1", 0)); print(sock.getsockname()[1]); sock.close()')"
umask 077
cat >"${ENV_FILE}" <<EOF
POSTGRES_USER=${ADMIN_USER}
POSTGRES_PASSWORD=${ADMIN_PASSWORD}
PGDATABASE=${DATABASE_NAME}
PGUSER=${APPLICATION_USER}
PGPASSWORD=${APPLICATION_PASSWORD}
PGPORT=${HOST_PORT}
EOF

unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD POSTGRES_USER POSTGRES_PASSWORD
compose config --quiet
STACK_STARTED=1
compose up --build --detach --wait --wait-timeout 120 db

APPLICATION_DATABASE_URL="postgresql://${APPLICATION_USER}:${APPLICATION_PASSWORD}@127.0.0.1:${HOST_PORT}/${DATABASE_NAME}"
ADMIN_DATABASE_URL="postgresql://${ADMIN_USER}:${ADMIN_PASSWORD}@127.0.0.1:${HOST_PORT}/${DATABASE_NAME}"
FINDER_TEST_DATABASE_URL="${APPLICATION_DATABASE_URL}" \
FINDER_TEST_ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL}" \
FINDER_TEST_APPLICATION_USER="${APPLICATION_USER}" \
FINDER_TEST_APPLICATION_PASSWORD="${APPLICATION_PASSWORD}" \
    npm --prefix "${PROJECT_ROOT}/find" run test:integration

echo 'Finder persistence verified against an isolated PostgreSQL volume.'
