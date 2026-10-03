#!/usr/bin/env bash
# Run Seed-VC voice conversion locally (Apple silicon / MPS) behind the same
# /convert contract as the Modal deployment. See infra/modal/seed_vc_local.py.
#
#   pnpm seed-vc:local
#
# Clones upstream Seed-VC at the commit pinned in infra/modal/seed_vc.py into
# ~/.cache/aquilla/seed-vc (override with SEED_VC_DIR), builds a Python 3.11 venv
# there with uv, and starts the server on 127.0.0.1:8791. The token defaults to
# SEED_VC_TOKEN from sync-worker/.dev.vars so the worker and server always match.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODAL_DIR="$ROOT/infra/modal"
export SEED_VC_DIR="${SEED_VC_DIR:-$HOME/.cache/aquilla/seed-vc}"
VENV="$SEED_VC_DIR/.venv-aquilla"
REQS="$MODAL_DIR/seed_vc_local.requirements.txt"

REPO="$(sed -n 's/^REPO = "\(.*\)"/\1/p' "$MODAL_DIR/seed_vc.py")"
COMMIT="$(sed -n 's/^REPO_COMMIT = "\(.*\)"/\1/p' "$MODAL_DIR/seed_vc.py")"
if [[ -z "$REPO" || -z "$COMMIT" ]]; then
  echo "seed-vc-local: could not read REPO / REPO_COMMIT from infra/modal/seed_vc.py" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "seed-vc-local: needs uv (https://docs.astral.sh/uv/) — brew install uv" >&2
  exit 1
fi

if [[ ! -d "$SEED_VC_DIR/.git" ]]; then
  echo "seed-vc-local: cloning $REPO → $SEED_VC_DIR"
  mkdir -p "$(dirname "$SEED_VC_DIR")"
  git clone -q "$REPO" "$SEED_VC_DIR"
fi
if [[ "$(git -C "$SEED_VC_DIR" rev-parse HEAD)" != "$COMMIT" ]]; then
  git -C "$SEED_VC_DIR" fetch -q origin "$COMMIT" 2>/dev/null || git -C "$SEED_VC_DIR" fetch -q origin
  git -C "$SEED_VC_DIR" checkout -q "$COMMIT"
fi

# Reinstall only when the requirements file changes.
STAMP="$VENV/.requirements.sha"
REQS_SHA="$(shasum -a 256 "$REQS" | cut -d' ' -f1)"
if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv -q --python 3.11 "$VENV"
fi
if [[ "$(cat "$STAMP" 2>/dev/null)" != "$REQS_SHA" ]]; then
  echo "seed-vc-local: installing Python deps (first run takes a few minutes)"
  uv pip install -q --python "$VENV/bin/python" -r "$REQS"
  echo "$REQS_SHA" > "$STAMP"
fi

if [[ -z "${SEED_VC_TOKEN:-}" && -f "$ROOT/sync-worker/.dev.vars" ]]; then
  SEED_VC_TOKEN="$(sed -n 's/^SEED_VC_TOKEN *= *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$ROOT/sync-worker/.dev.vars" | tail -1)"
fi
if [[ -z "${SEED_VC_TOKEN:-}" ]]; then
  cat >&2 <<'EOF'
seed-vc-local: no SEED_VC_TOKEN. Add these to sync-worker/.dev.vars, then re-run:
  SEED_VC_URL="http://127.0.0.1:8791/convert"
  SEED_VC_TOKEN="<any long random string>"
EOF
  exit 1
fi
export SEED_VC_TOKEN
# Ops upstream has no MPS kernel for run on CPU instead of crashing the request.
export PYTORCH_ENABLE_MPS_FALLBACK=1

exec "$VENV/bin/python" "$MODAL_DIR/seed_vc_local.py"
