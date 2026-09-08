#!/usr/bin/env bash
# Idempotent install of the aquilla-migrate daemon. Run ON the box as user
# `clear` (e.g. `ssh clear@<box> 'bash -s' < install.sh [branch] [env-file]`).
#
# Does NOT start the service — the controller places the real env at
# /etc/aquilla-migrate/env and starts it explicitly (see docs/MIGRATE-DAEMON.md).
#
# Usage: install.sh [branch] [local-env-file]
#   branch          git branch to check out in ~/aquilla (default: main)
#   local-env-file  path to a real env file to install as /etc/aquilla-migrate/env
#                   (optional — if omitted, instructions are printed instead)
set -euo pipefail

BRANCH="${1:-main}"
ENV_FILE="${2:-}"

REPO_DIR="$HOME/aquilla"
MIGRATE_HOME="$HOME/aquilla-migrate"
REPO_URL="git@github.com:genesis-ai-dev/aquilla.git"
UNIT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Repo checkout"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin
fi
git -C "$REPO_DIR" checkout "$BRANCH"
git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"

echo "==> Toolchain"
corepack enable
corepack prepare pnpm@10.19.0 --activate

echo "==> Dependencies"
cd "$REPO_DIR"
pnpm install --frozen-lockfile

echo "==> State directory"
mkdir -p "$MIGRATE_HOME"

echo "==> systemd unit"
sudo install -m 644 "$UNIT_SRC_DIR/aquilla-migrate.service" /etc/systemd/system/aquilla-migrate.service

echo "==> Environment file"
sudo mkdir -p /etc/aquilla-migrate
if [ -n "$ENV_FILE" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "!! env file '$ENV_FILE' not found — skipping" >&2
  else
    sudo install -m 600 -o clear "$ENV_FILE" /etc/aquilla-migrate/env
    echo "   installed $ENV_FILE -> /etc/aquilla-migrate/env"
  fi
else
  echo "   no env file given — populate /etc/aquilla-migrate/env manually, e.g.:"
  echo "     sudo install -m 600 -o clear deploy/migrate-daemon/env.example /etc/aquilla-migrate/env"
  echo "     sudoedit /etc/aquilla-migrate/env"
fi

echo "==> logrotate"
sudo tee /etc/logrotate.d/aquilla-migrate > /dev/null <<'EOF'
/home/clear/aquilla-migrate/daemon.log {
  weekly
  rotate 8
  compress
  copytruncate
  missingok
  notifempty
}
EOF

echo "==> systemd"
sudo systemctl daemon-reload
sudo systemctl enable aquilla-migrate

cat <<EOF

==> Install complete. Next steps:
  1. Confirm /etc/aquilla-migrate/env is populated (DRY_RUN=1 for the initial
     dry-run window) — see deploy/migrate-daemon/env.example.
  2. Start the service:  sudo systemctl start aquilla-migrate
  3. Watch logs:         tail -f $MIGRATE_HOME/daemon.log
  4. Check status:       cd $REPO_DIR && pnpm migrate:daemon status
  5. To roll a new version later, use deploy/migrate-daemon/update.sh instead
     of restarting this script — it does not touch the install lifecycle.
EOF
