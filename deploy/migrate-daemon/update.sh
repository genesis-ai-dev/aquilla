#!/usr/bin/env bash
# Roll a new version of the aquilla-migrate daemon. Run ON the box as user
# `clear`. This is the ONLY sanctioned way to update the running daemon —
# `git pull` and `pnpm install` are deliberately kept out of the systemd unit
# (ExecStartPre) so a transient npm registry failure or a bad frozen-lockfile
# state can't put the service into a crash-restart loop; a failure here just
# leaves the currently-running version in place.
#
# Usage: update.sh [branch]
set -euo pipefail

BRANCH="${1:-main}"
REPO_DIR="$HOME/aquilla"

export PATH="$HOME/.local/bin:$PATH"

echo "==> Pulling $BRANCH"
git -C "$REPO_DIR" fetch origin
git -C "$REPO_DIR" checkout "$BRANCH"
git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"

echo "==> Installing dependencies"
cd "$REPO_DIR"
# --ignore-scripts: onnxruntime-node's postinstall downloads a native binary and
# fails on the box, and the daemon needs no native postinstall to run.
pnpm install --frozen-lockfile --ignore-scripts

echo "==> Restarting service"
sudo systemctl restart aquilla-migrate

echo "==> Done. Tail logs with: tail -f $HOME/aquilla-migrate/daemon.log"
