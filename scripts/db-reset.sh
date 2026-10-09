#!/usr/bin/env bash
# Drops and recreates this checkout's LOCAL test database, checks that it keeps UTC time, then
# applies the migrations.
#
#   scripts/db-reset.sh                      # database "holdfast" (the main tree)
#   HOLDFAST_DB=holdfast_t05 scripts/db-reset.sh
#
# HOLDFAST_DB is the single input: every local connection string is
#   postgres://postgres:postgres@localhost:5432/$HOLDFAST_DB
# The server is the one from docker-compose.test.yml. This script only ever talks to localhost and
# refuses to run when anything in the environment points a database URL somewhere else, so it
# cannot be aimed at a hosted database.
set -euo pipefail

export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

die() {
  echo "db-reset: $*" >&2
  exit 1
}

db="${HOLDFAST_DB:-holdfast}"
host="${HOLDFAST_DB_HOST:-localhost}"
port="${HOLDFAST_DB_PORT:-5432}"

# The name is spliced into SQL and into a URL.
[[ "$db" =~ ^holdfast(_[a-z0-9_]+)?$ ]] ||
  die "HOLDFAST_DB must be 'holdfast' or 'holdfast_<name>' (lowercase letters, digits, underscores); got '$db'"
[[ "$port" =~ ^[0-9]+$ ]] || die "HOLDFAST_DB_PORT must be a number"

is_local_host() {
  case "$1" in
    localhost | 127.0.0.1 | ::1 | '[::1]') return 0 ;;
    *) return 1 ;;
  esac
}

# Host part of a postgres URL (no credentials are printed).
url_host() {
  local rest="${1#*://}"
  rest="${rest%%[/?]*}"
  rest="${rest##*@}"
  if [[ "$rest" == \[* ]]; then
    echo "${rest%%]*}]"
  else
    echo "${rest%%:*}"
  fi
}

is_local_host "$host" ||
  die "refusing to run: the database host is '$host', not localhost. This script resets local test databases only."

# A shell that still carries a hosted database URL is one typo away from migrating or resetting it.
for name in DATABASE_URL_DIRECT DATABASE_URL CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  is_local_host "$(url_host "$value")" ||
    die "refusing to run: $name in this shell does not point at localhost. Unset it first (unset $name)."
done

command -v psql >/dev/null 2>&1 || die "psql not found (macOS: brew install libpq; Debian/Ubuntu: apt-get install postgresql-client)"

base="postgres://postgres:postgres@$host:$port"
url="$base/$db"
admin="$base/postgres"

# `docker compose up -d` returns before the server accepts connections.
ready=0
for _ in $(seq 1 60); do
  if psql "$admin" -Atqc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] ||
  die "no Postgres on $host:$port. Start it: docker compose -f docker-compose.test.yml up -d (on this Mac: DOCKER_CONTEXT=desktop-linux docker compose …)"

PGOPTIONS="-c client_min_messages=warning" psql "$admin" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$db\""
psql "$url" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' \
  -c 'CREATE EXTENSION IF NOT EXISTS citext'
echo "db-reset: recreated database $db on $host:$port (pg_trgm, citext)"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A new database takes the server's time zone. The auth tables store DEFAULT now() in zone-less
# columns, so on a server that is not on UTC every test would run against wrong instants. The same
# check the deploy runs before it migrates (one implementation: deploy-lib.sh utc-zone); it runs
# whether or not there are migrations yet.
DATABASE_URL_DIRECT="$url" bash "$root/.github/workflows/lib/deploy-lib.sh" utc-zone ||
  die "the local Postgres on $host:$port does not keep UTC time (lines above), so $db was NOT migrated. The compose server's default is UTC: look for TZ / PGTZ or '-c timezone=…' on the container, or a server-wide ALTER ROLE … SET timezone."
if [ -f "$root/drizzle.config.ts" ]; then
  (cd "$root" && DATABASE_URL_DIRECT="$url" npm run --silent db:migrate)
  echo "db-reset: migrations applied to $db"
else
  echo "db-reset: no drizzle.config.ts yet, migrations skipped"
fi
