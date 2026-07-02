#!/usr/bin/env bash
# Guards against deploying a dist/ built for the WRONG environment.
#
# VITE_AUTH_BASE is baked into the JS bundle at build time, and dist/ is a
# shared, mutable dir with no tag on it — a stray bare `wrangler deploy`
# (skipping the matching build step) silently ships the last build's API
# target to whichever worker you point it at.
#
# Checks the *env var used for this build*, not the bundle text: auth.ts /
# sync-worker-host.ts hardcode api.aquilla.app as a runtime fallback string,
# so that literal shows up in every bundle regardless of build target —
# grepping dist/ for host strings gives false positives. Checking
# $VITE_AUTH_BASE directly is deterministic.
#
# Usage: export VITE_AUTH_BASE=... && npm run build && verify-dist-host.sh <expected-host>
set -euo pipefail

expected="$1"
actual="${VITE_AUTH_BASE:-}"

if [ -z "$actual" ]; then
  echo "ABORT: VITE_AUTH_BASE is not set in this shell." >&2
  echo "Re-run the matching 'npm run deploy:aquilla:*' script — don't call wrangler deploy directly." >&2
  exit 1
fi

case "$actual" in
  https://"$expected"*)
    echo "OK: VITE_AUTH_BASE=$actual matches expected host $expected"
    ;;
  *)
    echo "ABORT: VITE_AUTH_BASE=$actual does not match expected host '$expected'." >&2
    echo "This dist/ was built for a different environment. Re-run the matching 'npm run deploy:aquilla:*' script." >&2
    exit 1
    ;;
esac
