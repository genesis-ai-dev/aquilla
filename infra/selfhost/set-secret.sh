#!/usr/bin/env bash
# Put the worker's OMNI_SHARED_SECRET on a self-hosted Omnilingual box, restart
# the server, and check that the public URL accepts it.
#
#   infra/selfhost/set-secret.sh [user@host] [https://public-url]
#
# The secret is read from a hidden prompt and sent over ssh's stdin, so it never
# appears in shell history, in a command line, or in this repo. It replaces only
# the OMNI_SHARED_SECRET line of ~/.config/aquilla-omni.env (mode 600).
set -euo pipefail
HOST=${1:-clear@192.168.1.80}
URL=${2:-https://omni-asr.aquilla.app}

read -rsp "OMNI_SHARED_SECRET for $HOST: " SECRET
echo
[ -n "$SECRET" ] || { echo "empty secret, nothing changed" >&2; exit 1; }

printf 'OMNI_SHARED_SECRET=%s\n' "$SECRET" | ssh "$HOST" '
  set -e; umask 077
  f=~/.config/aquilla-omni.env; tmp=$(mktemp)
  { grep -v "^OMNI_SHARED_SECRET=" "$f" 2>/dev/null || true; cat; } > "$tmp"
  mv "$tmp" "$f"; chmod 600 "$f"
  systemctl --user restart omni-asr'
echo "secret written; server restarting (loading models takes a few minutes)"

for _ in $(seq 1 90); do
  curl -sf -m 10 "$URL/healthz" >/dev/null && break
  sleep 10
done
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H @<(printf 'X-Omni-Secret: %s\n' "$SECRET") "$URL/status?model=ctc")
if [ "$code" = 200 ]; then
  echo "OK: $URL accepts the secret"
else
  echo "FAILED: $URL/status answered $code with this secret" >&2
  exit 1
fi
