#!/usr/bin/env bash
# Register N GitHub Actions runners on this box. GitHub is the webhook and
# the job queue; these processes are only the compute.
#
# Create a registration token (repo admin):
#   gh api -X POST repos/genesis-ai-dev/aquilla/actions/runners/registration-token \
#     --jq .token
#
# Then, from your laptop:
#   ssh root@HETZNER "bash -s -- --token $TOKEN --count 1" \
#     < scripts/hetzner-ci/install-runners.sh
#
# One runner is enough for e2e: `pnpm test:e2e:smoke` already fans out 3
# isolated stacks on the same machine. Add more runners later if you move
# unit/lint jobs here and want them to overlap.
set -euo pipefail

REPO_URL=https://github.com/genesis-ai-dev/aquilla
RUNNER_TOKEN=""
COUNT=1
CI_USER=ci
LABELS=hetzner,e2e
BASE_DIR=/opt/actions-runners

usage() {
  cat <<'EOF'
Usage: install-runners.sh --token TOKEN [--count 1] [--user ci] [--labels hetzner,e2e]

  --token TOKEN   GitHub runner registration token (expires ~1 hour)
  --count N       How many runner processes to register (default 1)
  --user NAME     Account that runs the service (default ci)
  --labels LIST   Extra labels besides the implicit self-hosted/linux/x64
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) RUNNER_TOKEN="$2"; shift 2 ;;
    --token=*) RUNNER_TOKEN="${1#--token=}" ; shift ;;
    --count) COUNT="$2"; shift 2 ;;
    --count=*) COUNT="${1#--count=}" ; shift ;;
    --user) CI_USER="$2"; shift 2 ;;
    --user=*) CI_USER="${1#--user=}" ; shift ;;
    --labels) LABELS="$2"; shift 2 ;;
    --labels=*) LABELS="${1#--labels=}" ; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "install-runners.sh must run as root." >&2
  exit 1
fi

if [ -z "$RUNNER_TOKEN" ]; then
  echo "--token is required. Mint one with gh api .../actions/runners/registration-token" >&2
  exit 2
fi

if ! [[ "$COUNT" =~ ^[1-8]$ ]]; then
  echo "--count must be an integer 1-8" >&2
  exit 2
fi

if ! id -u "$CI_USER" >/dev/null 2>&1; then
  echo "user $CI_USER does not exist. Run bootstrap.sh first." >&2
  exit 1
fi

log() { printf '[hetzner-ci] %s\n' "$*"; }

arch="$(uname -m)"
case "$arch" in
  x86_64) runner_arch=x64 ;;
  aarch64) runner_arch=arm64 ;;
  *) echo "unsupported arch $arch" >&2; exit 1 ;;
esac

release_json="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
tag="$(printf '%s' "$release_json" | jq -r .tag_name)"
version="${tag#v}"
asset="actions-runner-linux-${runner_arch}-${version}.tar.gz"
url="https://github.com/actions/runner/releases/download/${tag}/${asset}"

log "downloading GitHub Actions runner $tag"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "$url" -o "$tmpdir/$asset"

mkdir -p "$BASE_DIR"
chown "$CI_USER:$CI_USER" "$BASE_DIR"

for i in $(seq 1 "$COUNT"); do
  dest="$BASE_DIR/runner-$i"
  if [ -x "$dest/run.sh" ] && [ -f "$dest/.runner" ]; then
    log "runner-$i already configured — skipping"
    continue
  fi
  log "configuring runner-$i labels=$LABELS"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tmpdir/$asset" -C "$dest"
  chown -R "$CI_USER:$CI_USER" "$dest"
  sudo -u "$CI_USER" -H "$dest/config.sh" \
    --unattended \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "hetzner-e2e-$i" \
    --labels "$LABELS" \
    --work _work \
    --replace
  (
    cd "$dest"
    ./svc.sh install "$CI_USER"
    ./svc.sh start
  )
done

log "registered $COUNT runner(s). Confirm: GitHub → Settings → Actions → Runners"
log "do not enable pull_request on e2e-hetzner.yml until a runner shows Idle"
