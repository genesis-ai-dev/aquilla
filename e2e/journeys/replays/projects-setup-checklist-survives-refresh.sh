#!/usr/bin/env sh
# Replay of projects-setup-checklist-survives-refresh.md, the path found on
# the 2026-09-08 cold run.
# The post-reload drawer restore is timing-sensitive under load (parallel
# agent-browser sessions from other journeys share the daemon); give it more
# than the 25s default before calling it a failure.
export AGENT_BROWSER_DEFAULT_TIMEOUT="${AGENT_BROWSER_DEFAULT_TIMEOUT:-45000}"
. "$(dirname "$0")/_lib.sh"
NAME="Journey checklist $(date +%H%M%S)"

login alice || fail "login"
ab open "$BASE/orgs/9/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait --text "Create New Project" >/dev/null || fail "dialog"
ab find label "Project title" fill "$NAME" >/dev/null || fail "title field"
ab find label "Source Language" fill "en" >/dev/null || fail "source field"
ab find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"
ab find role button click --name "Open project" >/dev/null || fail "Open project button"
ab wait --load networkidle >/dev/null

# Chip label is "Setup: 1/4" (with bidi isolate marks around the fraction) —
# match on the stable "Setup" prefix. The chip can mount a beat after
# networkidle fires (a second async fetch for project setup state), so
# retry the find for a few seconds instead of failing on the first miss.
i=0
until ab find role button click --name "Setup" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 10 ] && fail "Setup chip"
  sleep 0.5
done
ab wait --text "Project setup" >/dev/null || fail "drawer did not open"
[ "$(count 'heading "Project setup"')" -ge 1 ] || fail "no Project setup heading after opening chip"

ab reload >/dev/null
ab wait --text "Project setup" >/dev/null || fail "drawer did not restore after reload"
[ "$(count 'heading "Project setup"')" -ge 1 ] || fail "no Project setup heading after first reload"

ab find role button click --name "Skip for now" >/dev/null || fail "Skip for now button"
i=0
while [ "$i" -lt 20 ]; do
  n=$(count 'heading "Project setup"')
  [ "$n" -eq 0 ] && break
  i=$((i + 1))
  sleep 0.5
done
[ "$(count 'heading "Project setup"')" -eq 0 ] || fail "drawer still open after Skip for now"

ab reload >/dev/null
ab wait --load networkidle >/dev/null
[ "$(count 'heading "Project setup"')" -eq 0 ] || fail "drawer reopened after skip + reload"
[ "$(count 'button "Setup"')" -ge 1 ] || fail "Setup chip missing after skip + reload"

pass "checklist restored after open+reload, stayed closed after skip+reload"
