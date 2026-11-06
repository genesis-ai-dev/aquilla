#!/usr/bin/env bash
# Provision a native Postgres 16 cluster for the e2e suite, no Docker needed.
#
# AQU-1820: `scripts/e2e-up.ts` has always had a Docker-less reset path — it
# falls back to a local `psql` against 127.0.0.1:5432 when the `aquilla-dev-pg`
# container is not reachable. The only thing missing was a reproducible way to
# get that Postgres up, so every sandbox run re-derived the initdb + role
# incantation (or wrongly concluded "no Docker, cannot run the suite").
#
# Usage:
#   eval "$(bash scripts/e2e-pg-native.sh)"      # provision + export the admin URL
#   bash scripts/e2e-pg-native.sh --stop         # stop the cluster (data kept)
#
# Everything the script says goes to stderr; the single stdout line is the
# `export E2E_PG_ADMIN_URL=…` that `scripts/e2e-up.ts` reads. Idempotent: a
# second run against a live cluster re-prints the export and changes nothing.
set -euo pipefail

PGPORT="${E2E_PG_PORT:-5432}"
PGDATA_DIR="${E2E_PG_DATA:-/var/lib/postgresql/aquilla-e2e}"
# The role e2e-up.ts connects as, and the admin role its reset needs: DROP and
# CREATE DATABASE, plus ownership hand-off to `aquilla`. One SUPERUSER role
# named `aquilla` satisfies both, so the fallback needs no second credential.
PG_ROLE=aquilla
PG_PASSWORD=aquilla
# AQU-2107: the IPv4 literal, never `localhost` — the workers dial this over
# TCP from inside workerd and a `localhost` that resolves to ::1 first adds
# connect latency the database never sees.
ADMIN_URL="postgresql://${PG_ROLE}:${PG_PASSWORD}@127.0.0.1:${PGPORT}/postgres" # secret-scan:allow — throwaway loopback-only test cluster, same fixture credential as e2e-up.ts

log() { echo "[e2e-pg-native] $*" >&2; }

# Debian/Ubuntu keep the server binaries off PATH (only the client is linked),
# so prefer the newest /usr/lib/postgresql/<major>/bin and fall back to PATH
# (Homebrew, Arch, macOS Postgres.app all ship them linked).
find_bindir() {
  local d
  for d in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V -r); do
    [ -x "$d/initdb" ] && { echo "$d"; return 0; }
  done
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  return 1
}

BINDIR="$(find_bindir || true)"
if [ -z "$BINDIR" ]; then
  log "no Postgres server binaries found (looked in /usr/lib/postgresql/*/bin and PATH)."
  log "install a Postgres 16 server package, or use the Docker path in e2e/README.md."
  exit 1
fi

# initdb and postgres refuse to run as root. When this script is root (the
# usual case in a container), run every cluster command as the `postgres`
# system user the server package creates.
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then
    RUN_AS=postgres
  else
    log "running as root and there is no 'postgres' system user to drop to."
    log "create one (useradd -r postgres) or run this script as a normal user."
    exit 1
  fi
fi

as_pg() {
  if [ -n "$RUN_AS" ]; then
    su "$RUN_AS" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

# Unix socket dir: the packaged default when it is there, else the data dir, so
# `pg_ctl`'s own readiness probe (a socket connection) always has somewhere to go.
SOCKET_DIR=/var/run/postgresql
if [ ! -d "$SOCKET_DIR" ]; then
  SOCKET_DIR="$PGDATA_DIR"
fi

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$PGDATA_DIR/postmaster.pid" ]; then
    as_pg "'$BINDIR/pg_ctl' -D '$PGDATA_DIR' -m fast stop"
    log "stopped the cluster at $PGDATA_DIR (data kept)."
  else
    log "no cluster running at $PGDATA_DIR."
  fi
  exit 0
fi

cluster_reachable() {
  PGPASSWORD="$PG_PASSWORD" psql "$ADMIN_URL" -At -c "SELECT rolsuper FROM pg_roles WHERE rolname = '$PG_ROLE'" 2>/dev/null | grep -qx t
}

if cluster_reachable; then
  log "Postgres already serving 127.0.0.1:$PGPORT with a superuser '$PG_ROLE' role."
else
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    log "initdb → $PGDATA_DIR (using $BINDIR)"
    mkdir -p "$PGDATA_DIR"
    [ -n "$RUN_AS" ] && chown "$RUN_AS" "$PGDATA_DIR"
    # -A trust: a throwaway local cluster for tests; it listens on loopback only.
    as_pg "'$BINDIR/initdb' -D '$PGDATA_DIR' -A trust -U postgres" >&2
  fi

  if [ ! -f "$PGDATA_DIR/postmaster.pid" ]; then
    log "starting Postgres on 127.0.0.1:$PGPORT (socket dir $SOCKET_DIR)"
    as_pg "'$BINDIR/pg_ctl' -D '$PGDATA_DIR' -l '$PGDATA_DIR/server.log' -w \
      -o '-c listen_addresses=127.0.0.1 -p $PGPORT -c unix_socket_directories=$SOCKET_DIR' start" >&2
  fi

  # CREATE DATABASE is what the reset needs, so the role is a SUPERUSER; the
  # password lets the workers reach it over TCP with the URL e2e-up.ts builds.
  as_pg "'$BINDIR/psql' -h '$SOCKET_DIR' -p '$PGPORT' -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c \"DO \\\$\\\$ BEGIN
           IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$PG_ROLE') THEN
             ALTER ROLE $PG_ROLE LOGIN SUPERUSER PASSWORD '$PG_PASSWORD';
           ELSE
             CREATE ROLE $PG_ROLE LOGIN SUPERUSER PASSWORD '$PG_PASSWORD';
           END IF;
         END \\\$\\\$;\"" >&2

  if ! cluster_reachable; then
    log "the cluster is up but $ADMIN_URL still does not report a superuser '$PG_ROLE'."
    log "see $PGDATA_DIR/server.log"
    exit 1
  fi
  log "ready."
fi

log "next: eval this line, then run the suite, e.g."
log "  npx tsx scripts/e2e-up.ts -- e2e/specs/<spec>.smoke.spec.ts"
echo "export E2E_PG_ADMIN_URL=\"$ADMIN_URL\""
