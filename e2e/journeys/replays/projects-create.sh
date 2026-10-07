#!/usr/bin/env sh
# Replay of projects-create.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
NAME="Journey create $(date +%H%M%S)"
login alice || fail "login"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait --text "Create New Project" >/dev/null || fail "dialog"
ab find label "Project title" fill "$NAME" >/dev/null || fail "title field"
ab find label "Source Language" fill "en" >/dev/null || fail "source field"
ab find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"
url=$(ab get url); case "$url" in */projects/*) ;; *) fail "url after create: $url";; esac
[ "$(count "heading \"$NAME\"")" -ge 1 ] || fail "overview heading is not the title"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
rows=$(count "cell \"$NAME\"" "table")
[ "$rows" -ge 1 ] || fail "no table row named $NAME"
pass "row '$NAME' in Projects table; overview url $url"
