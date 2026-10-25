#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly PROJECT_ROOT

for required_command in docker openssl python3; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
        echo "${required_command} is required for the isolated database verification." >&2
        exit 1
    fi
done

if ! docker compose version >/dev/null 2>&1; then
    echo 'Docker Compose is required for the isolated database verification.' >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo 'The Docker daemon is unavailable; database runtime verification cannot run.' >&2
    exit 1
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/repoexplorer-db-verify.XXXXXX")"
readonly TEST_ROOT
readonly ENV_FILE="${TEST_ROOT}/.env"
readonly PROJECT_NAME="repoexplorer-db-verify-$$-$(openssl rand -hex 4)"
readonly MARKER='issue-56-database-volume-persistence-check'
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
while [[ "${APPLICATION_PASSWORD}" == "${ADMIN_PASSWORD}" ]]; do
    APPLICATION_PASSWORD="$(openssl rand -hex 32)"
done
HOST_PORT="$(python3 -c 'import socket; sock = socket.socket(); sock.bind(("127.0.0.1", 0)); print(sock.getsockname()[1]); sock.close()')"

umask 077
cat >"${ENV_FILE}" <<EOF
POSTGRES_USER=repoexplorer_verify_admin
POSTGRES_PASSWORD=${ADMIN_PASSWORD}
PGDATABASE=repoexplorer_verify
PGUSER=repoexplorer_verify_app
PGPASSWORD=${APPLICATION_PASSWORD}
PGPORT=${HOST_PORT}
EOF

# Make the temporary values come only from this test's env file.
unset POSTGRES_USER POSTGRES_PASSWORD PGDATABASE PGUSER PGPASSWORD PGPORT

compose config --quiet
STACK_STARTED=1
compose up --build --detach --wait --wait-timeout 120 db

compose exec --no-TTY db sh -eu -c \
    'PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1' \
    <"${PROJECT_ROOT}/scripts/db/verify.sql"

compose exec --no-TTY db sh -eu -c '
    application_user="$PGUSER"
    application_password="$PGPASSWORD"
    PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
        APPLICATION_USER="$application_user" APPLICATION_PASSWORD="$application_password" \
        psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$PGDATABASE" \
            -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/010-setup.sql
    PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
        APPLICATION_USER="$application_user" \
        psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$PGDATABASE" \
            -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/020-schema.sql
    PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" \
        APPLICATION_USER="$application_user" \
        psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$PGDATABASE" \
            -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/repository-scraping.sql
'

cat >"${TEST_ROOT}/marker.sql" <<EOF
INSERT INTO public.repositories (
    university, id, owner, fork, size, stargazers_count, watchers_count, forks_count,
    open_issues_count, watchers, release_downloads, contributor_count, subscribers_count,
    affiliation_prediction_gpt5_mini, contributors
)
VALUES (
    'Issue 56 Verify', 9876543210999, 'verify-owner', 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, '${MARKER}'
);
EOF

compose exec --no-TTY db sh -eu -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$PGDATABASE" -v ON_ERROR_STOP=1' \
    <"${TEST_ROOT}/marker.sql"

compose restart db

DATABASE_READY=0
for attempt in $(seq 1 45); do
    if compose exec --no-TTY db sh -eu -c \
        'pg_isready --username "$POSTGRES_USER" --dbname "$PGDATABASE"' >/dev/null 2>&1; then
        DATABASE_READY=1
        break
    fi
    sleep 2
done
if [[ "${DATABASE_READY}" -ne 1 ]]; then
    echo 'Isolated PostgreSQL service did not become ready after restart.' >&2
    exit 1
fi

cat >"${TEST_ROOT}/marker-check.sql" <<EOF
SELECT count(*)
FROM public.repositories
WHERE contributors = '${MARKER}';
EOF
PERSISTED_MARKER="$(compose exec --no-TTY db sh -eu -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$PGDATABASE" -Atq' \
    <"${TEST_ROOT}/marker-check.sql")"
if [[ "${PERSISTED_MARKER}" != '1' ]]; then
    echo 'The isolated database volume did not preserve its marker row across restart.' >&2
    exit 1
fi

echo 'Database schema, application-role CRUD, bootstrap rerun, and volume persistence verified.'
