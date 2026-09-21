#!/usr/bin/env bash
# Fast-forward the dedicated Hetzner daemon to the current dev commit.
# Run as root. A failed fetch, merge, or install leaves the existing service
# process running; the service restarts only after every update step succeeds.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must be run as root" >&2
  exit 1
fi

APP_DIR=/opt/aquilla-migrate/app
NODE_BIN=/opt/node22/bin
DEPLOY_KEY=/var/lib/aquilla-migrate/.ssh/aquilla_deploy
KNOWN_HOSTS=/var/lib/aquilla-migrate/.ssh/known_hosts
UNIT_SOURCE="$APP_DIR/deploy/migrate-daemon/aquilla-migrate-hetzner.service"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "$APP_DIR is not a git checkout" >&2
  exit 1
fi

if ! sudo -u aquilla-migrate git -C "$APP_DIR" diff --quiet --ignore-submodules --; then
  echo "$APP_DIR has uncommitted changes" >&2
  exit 1
fi

was_active=0
if systemctl is-active --quiet aquilla-migrate.service; then
  was_active=1
fi

git_ssh="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN_HOSTS"
sudo -u aquilla-migrate env GIT_SSH_COMMAND="$git_ssh" \
  git -C "$APP_DIR" fetch --depth 1 origin dev
# A depth-one fetch of a GitHub merge commit may omit the local commit's
# ancestry, so merge --ff-only can report unrelated histories. The checkout is
# already required to be clean; point its local dev ref at the exact fetched
# origin/dev commit instead.
sudo -u aquilla-migrate git -C "$APP_DIR" checkout -B dev FETCH_HEAD
sudo -u aquilla-migrate env PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" \
  "$NODE_BIN/pnpm" --dir "$APP_DIR" install --frozen-lockfile \
    --ignore-scripts --network-concurrency=4 --child-concurrency=1

install -m 0644 "$UNIT_SOURCE" /etc/systemd/system/aquilla-migrate.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/aquilla-migrate.service

if [ "$was_active" -eq 1 ]; then
  systemctl restart aquilla-migrate.service
fi

sudo -u aquilla-migrate git -C "$APP_DIR" rev-parse HEAD
