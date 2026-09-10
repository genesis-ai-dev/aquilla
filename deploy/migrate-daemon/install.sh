#!/usr/bin/env bash
# Idempotent, user-space install of the aquilla-migrate daemon. Run ON the box
# as user `clear` (e.g. `ssh clear@<box> 'bash -s' < install.sh [branch]`).
#
# This script never uses sudo — the box requires an interactive sudo
# password, so non-interactive SSH can't run privileged steps here. It
# clones/updates the repo, installs the toolchain into user-space (the
# system `node` has no bundled `pnpm`, and `corepack enable` would otherwise
# try to write shims into root-owned /usr/bin), and installs dependencies.
# The privileged half (systemd unit, env file, logrotate, enable) lives in
# install-system.sh — this script prints the exact `sudo` command to run it.
#
# Usage: install.sh [branch] [local-env-file]
#   branch          git branch to check out in ~/aquilla (default: main)
#   local-env-file  path to a real env file, forwarded into the printed
#                    install-system.sh command (optional)
#
# Repo URL: defaults to the SSH remote. Override with AQUILLA_REPO_URL to
# clone over https + a deploy token instead, e.g.
#   AQUILLA_REPO_URL="https://<token>@github.com/genesis-ai-dev/aquilla.git"
set -euo pipefail

BRANCH="${1:-main}"
ENV_FILE="${2:-}"

REPO_DIR="$HOME/aquilla"
MIGRATE_HOME="$HOME/aquilla-migrate"
REPO_URL="${AQUILLA_REPO_URL:-git@github.com:genesis-ai-dev/aquilla.git}"
LOCAL_BIN="$HOME/.local/bin"
UNIT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Repo checkout"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin
fi
git -C "$REPO_DIR" checkout "$BRANCH"
git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"

echo "==> Toolchain (user-space: system node has no bundled pnpm, and"
echo "    corepack enable would otherwise need root to write into /usr/bin)"
mkdir -p "$LOCAL_BIN"
corepack enable --install-directory "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$PATH"
corepack prepare pnpm@10.19.0 --activate

echo "==> Dependencies"
cd "$REPO_DIR"
# --ignore-scripts: onnxruntime-node's postinstall downloads a native binary and
# fails on the box, and the daemon needs no native postinstall to run.
pnpm install --frozen-lockfile --ignore-scripts

echo "==> State directory"
mkdir -p "$MIGRATE_HOME"

cat <<EOF

==> User-space install complete. Now run the privileged half AS ROOT — it
    copies the systemd unit + env file, writes the logrotate stanza, and
    enables the service, none of which this script can do without an
    interactive sudo password:

  sudo bash $UNIT_SRC_DIR/install-system.sh ${ENV_FILE:-/path/to/env}

  After that:
    1. Confirm /etc/aquilla-migrate/env is populated (DRY_RUN=1 for the
       initial dry-run window) — see deploy/migrate-daemon/env.example.
    2. Start the service:  sudo systemctl start aquilla-migrate
    3. Watch logs:         tail -f $MIGRATE_HOME/daemon.log
    4. Check status:       cd $REPO_DIR && pnpm migrate:daemon status
    5. To roll a new version later, use deploy/migrate-daemon/update.sh
       instead of restarting this script.
EOF
