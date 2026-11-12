#!/usr/bin/env sh
# Replay of projects-create.md, the path found on the 2026-09-08 cold run.
# Refreshed 2026-11-02: the dialog's words follow AQU-2261 (Project name / Source
# language / Language lanes, Create project), and the Projects table pages and
# searches on the server.
. "$(dirname "$0")/_lib.sh"
NAME="Journey create $(date +%H%M%S)"
login alice || fail "login"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New project" >/dev/null || fail "New project button"
ab wait --text "Create new project" >/dev/null || fail "dialog"
ab find testid "project-source-scratch" click >/dev/null || fail "Start from scratch (AQU-2105 source step)"
ab find label "Project name" fill "$NAME" >/dev/null || fail "name field"
ab find label "Source language" fill "en" >/dev/null || fail "source field"
ab find label "Language lanes" fill "fr" >/dev/null || fail "lanes field"
ab find role button click --name "Create project" >/dev/null || fail "Create project button"
# The overview is /projects/<id>, headed by the project's name (no "Open project" text any more).
ab wait --load networkidle >/dev/null
i=0
while [ "$i" -lt 30 ]; do
  url=$(ab get url); case "$url" in */projects/*) break;; esac
  i=$((i + 1)); sleep 0.5
done
case "$url" in */projects/*) ;; *) fail "url after create: $url";; esac
ab wait --text "$NAME" >/dev/null || fail "overview did not load"
[ "$(count "heading \"$NAME\"")" -ge 1 ] || fail "overview heading is not the title"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
# The table lists ten projects at a time with a load-more, so a new project is
# not on the first page; its search box asks the server. Rows are one clickable
# element whose accessible name starts with the project's name.
ab wait 'input[placeholder^="Search projects"]' >/dev/null || fail "Search projects box"
ab fill 'input[placeholder^="Search projects"]' "$NAME" >/dev/null || fail "fill Search projects"
ab wait --load networkidle >/dev/null
rows=0
i=0
while [ "$i" -lt 20 ]; do
  rows=$(count "row \"$NAME")
  [ "$rows" -ge 1 ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$rows" -ge 1 ] || fail "no table row named $NAME"
pass "row '$NAME' in Projects table; overview url $url"
