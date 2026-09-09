#!/usr/bin/env sh
# Replay of projects-settings-rename.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
NAME="Journey settings $(date +%H%M%S)"
RENAMED="$NAME renamed"

# Pull a ref out of the snapshot for a link/button `find` misses (sidebar-style
# icon+text controls). Usage: ref_for 'link "Project settings"'
# Note: piping the snapshot through `head -1` before grepping the ref out
# corrupts the line (the agent-browser CLI seems to retry its write on the
# broken pipe, splitting one line into two). Use `grep -m1` instead, which
# stops after one match without breaking the pipe early.
ref_for() {
  line=$(ab snapshot -i -c | grep -F -m1 "$1")
  printf '%s\n' "$line" | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p'
}

login alice || fail "login"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait "#pname, textbox" >/dev/null 2>&1
ab find label "Project title" fill "$NAME" >/dev/null || fail "title field"
ab find label "Source Language" fill "en" >/dev/null || fail "source field"
ab find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"

ref=$(ref_for 'link "Project settings"')
[ -n "$ref" ] || fail "Project settings link not in snapshot"
ab click "@$ref" >/dev/null || fail "click Project settings"
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */settings*) ;; *) fail "url after Project settings click: $url";; esac

ref=$(ref_for "link \"General $NAME\"")
if [ -n "$ref" ]; then
  ab click "@$ref" >/dev/null || fail "click General"
  ab wait --load networkidle >/dev/null
fi
ab wait "#pname" >/dev/null || fail "General pane (Project title field) did not load"

ab fill "#pname" "$RENAMED" >/dev/null || fail "fill Project title"
ab fill "#sl" "English (US)" >/dev/null || fail "fill Source Language"
ab find role button click --name "Save changes" >/dev/null || fail "Save changes button"

saving=1
i=0
while [ "$i" -lt 20 ]; do
  n=$(count 'button "Save changes"')
  [ "$n" -eq 0 ] && { saving=0; break; }
  i=$((i + 1))
  sleep 0.5
done
[ "$saving" -eq 0 ] || fail "Save changes button still visible after save"

title_val=$(ab get value "#pname")
[ "$title_val" = "$RENAMED" ] || fail "Project title after save: got '$title_val'"
source_val=$(ab get value "#sl")
[ "$source_val" = "English (US)" ] || fail "Source Language after save: got '$source_val'"

ab reload >/dev/null
ab wait "#pname" >/dev/null || fail "General pane did not reload"
title_after_reload=$(ab get value "#pname")
[ "$title_after_reload" = "$RENAMED" ] || fail "Project title after reload: got '$title_after_reload'"

pass "renamed to '$RENAMED', source language 'English (US)' saved, title survives reload"
