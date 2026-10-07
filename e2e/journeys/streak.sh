#!/usr/bin/env sh
# Run one story's replay N times in a row and record the streak.
#
# Usage: e2e/journeys/streak.sh <story-slug> [runs]   (default 5)
#
# A replay is the warm path an agent found on its cold run, written down as
# agent-browser commands (e2e/journeys/replays/<slug>.sh). It exits 0 on
# PASS and non-zero on FAIL, printing its evidence. This script runs it
# back to back, stops at the first failure, and appends one line per run
# to e2e/journeys/streaks.tsv so the calibration record lives in the repo.
#
# Requires the local stack on http://127.0.0.1:5173 (`pnpm dev`).
set -u
slug="$1"; runs="${2:-5}"
here=$(cd "$(dirname "$0")" && pwd)
replay="$here/replays/$slug.sh"
log="$here/streaks.tsv"
[ -f "$replay" ] || { echo "no replay for $slug at $replay"; exit 2; }
[ -f "$log" ] || printf 'date\tstory\trun\tresult\tseconds\tnote\n' > "$log"
pass=0
i=1
while [ "$i" -le "$runs" ]; do
  start=$(date +%s)
  out=$(AGENT_BROWSER_SESSION="streak-$slug-$$-$i" sh "$replay" 2>&1)
  rc=$?
  secs=$(( $(date +%s) - start ))
  note=$(printf '%s' "$out" | tail -1 | tr '\t' ' ' | cut -c1-160)
  if [ $rc -eq 0 ]; then result=PASS; pass=$((pass+1)); else result=FAIL; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$slug" "$i" "$result" "$secs" "$note" >> "$log"
  echo "[$slug] run $i: $result (${secs}s) $note"
  [ $rc -eq 0 ] || { echo "$out" | tail -20; break; }
  i=$((i+1))
done
echo "[$slug] $pass/$runs passed"
[ "$pass" -eq "$runs" ]
