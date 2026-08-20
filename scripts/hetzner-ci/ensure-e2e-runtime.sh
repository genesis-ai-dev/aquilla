#!/usr/bin/env bash
# Make sure the Docker daemon is up and the canonical e2e Postgres container
# (`aquilla-dev-pg`) is running. `scripts/e2e-up.ts` will not create that
# container — it only execs into it (or falls back to a local psql).
#
# Safe to pipe over SSH or run from a GitHub Actions step:
#
#   ssh root@HETZNER 'bash -s' < scripts/hetzner-ci/ensure-e2e-runtime.sh
#   bash scripts/hetzner-ci/ensure-e2e-runtime.sh
set -euo pipefail

PG_CONTAINER=aquilla-dev-pg
PG_IMAGE=postgres:16

log() { printf '[hetzner-ci] %s\n' "$*"; }

if command -v colima >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    log "docker socket down — starting Colima"
    # Colima is per-user. Prefer the invoking user; root cannot see ci's VM.
    if [ "$(id -u)" -eq 0 ] && id -u ci >/dev/null 2>&1; then
      sudo -u ci -H colima start
    else
      colima start
    fi
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not on PATH. Run bootstrap.sh first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not reachable. Start Docker Engine or Colima." >&2
  exit 1
fi

if docker ps -aq --filter "name=^/${PG_CONTAINER}$" | grep -q .; then
  log "starting existing ${PG_CONTAINER}"
  docker start "$PG_CONTAINER" >/dev/null
else
  log "creating ${PG_CONTAINER} from ${PG_IMAGE}"
  docker run -d \
    --name "$PG_CONTAINER" \
    --restart unless-stopped \
    -e POSTGRES_USER=aquilla \
    -e POSTGRES_PASSWORD=aquilla \
    -e POSTGRES_DB=aquilla_dev \
    -p 5432:5432 \
    "$PG_IMAGE" >/dev/null
fi

log "waiting for ${PG_CONTAINER} to accept connections"
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U aquilla >/dev/null 2>&1; then
    log "postgres ready"
    exit 0
  fi
  sleep 1
done

echo "${PG_CONTAINER} did not become ready in 60s" >&2
docker logs "$PG_CONTAINER" >&2 || true
exit 1
