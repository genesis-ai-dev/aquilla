#!/usr/bin/env bash
# Privileged half of the aquilla-migrate install. Run AFTER install.sh, AS
# ROOT (`sudo bash install-system.sh [env-file]`) — this box requires an
# interactive sudo password, so it can't be folded into a non-interactive
# SSH install run.
#
# Installs the systemd unit, the env file (if given), the logrotate
# stanza, and enables (but does not start) the service. Idempotent — safe
# to re-run.
#
# Usage: install-system.sh [local-env-file]
#   local-env-file  path to a real env file to install as
#                   /etc/aquilla-migrate/env (optional — if omitted,
#                   instructions are printed instead)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "!! must be run as root: sudo bash $0 [env-file]" >&2
  exit 1
fi

ENV_FILE="${1:-}"
MIGRATE_HOME="/home/clear/aquilla-migrate"
UNIT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> systemd unit"
install -m 644 "$UNIT_SRC_DIR/aquilla-migrate.service" /etc/systemd/system/aquilla-migrate.service

echo "==> Environment file"
mkdir -p /etc/aquilla-migrate
if [ -n "$ENV_FILE" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "!! env file '$ENV_FILE' not found — skipping" >&2
  else
    install -m 600 -o clear -g clear "$ENV_FILE" /etc/aquilla-migrate/env
    echo "   installed -> /etc/aquilla-migrate/env"
  fi
else
  echo "   no env file given — populate /etc/aquilla-migrate/env manually, e.g.:"
  echo "     install -m 600 -o clear -g clear deploy/migrate-daemon/env.example /etc/aquilla-migrate/env"
  echo "     sudoedit /etc/aquilla-migrate/env"
fi

echo "==> logrotate"
tee /etc/logrotate.d/aquilla-migrate > /dev/null <<'EOF'
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
systemctl daemon-reload
systemctl enable aquilla-migrate

cat <<EOF

==> Privileged install complete. Next steps:
  1. Confirm /etc/aquilla-migrate/env is populated (DRY_RUN=1 for the initial
     dry-run window) — see deploy/migrate-daemon/env.example.
  2. Start the service:  systemctl start aquilla-migrate
  3. Watch logs:         tail -f $MIGRATE_HOME/daemon.log
  4. Check status (as clear): cd ~/aquilla && pnpm migrate:daemon status
EOF
