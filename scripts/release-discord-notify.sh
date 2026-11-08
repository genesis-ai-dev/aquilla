#!/usr/bin/env bash
# Post one line to the #aquilla-alerts Discord channel, the same channel
# monitor-worker pages when production is down. Used by release-deploy.yml
# for the three things worth a human's glance: a release went live (and its
# calver), a deploy failed, or the open release is stuck behind a red
# `release-verify` check. The hourly "nothing to deploy" is not posted.
#
# Usage: release-discord-notify.sh "<message>"
# Needs DISCORD_RELEASE_WEBHOOK_URL (repository secret: a webhook on that
# channel). Unset, it warns and exits 0 — a missing notice must never fail
# a deploy that already went live.
set -euo pipefail
message="${1:?message required}"
if [ -z "${DISCORD_RELEASE_WEBHOOK_URL:-}" ]; then
  echo "::warning::DISCORD_RELEASE_WEBHOOK_URL is not set; not posting: $message"
  exit 0
fi
payload="$(node -e 'process.stdout.write(JSON.stringify({ content: process.argv[1], allowed_mentions: { parse: ["roles"] } }))' "$message")"
curl -sS --fail-with-body --max-time 20 \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$DISCORD_RELEASE_WEBHOOK_URL" > /dev/null \
  || echo "::warning::Discord post failed"
