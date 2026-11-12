#!/usr/bin/env sh
# Replay of projects-settings-rename.md, the path found on the 2026-09-08 cold run.
#
# Refreshed 2026-11-02 after two UI changes the replay had missed:
# - AQU-2261 renamed the New project dialog's fields to Project name / Source
#   language / Language lanes, and the General pane's field to Project name.
#   "Project title" is a retired term now (src/lib/i18n/retired-terms.ts).
# - AQU-1594 (2026-10-06) moved the source language off the General pane onto
#   the source lane: the Languages table's source line has a Change button that
#   opens the lane's Language / Name / Code fields with Save. `#sl` is gone.
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
ab find role button click --name "New project" >/dev/null || fail "New project button"
ab wait --text "Create new project" >/dev/null || fail "create dialog"
ab find testid "project-source-scratch" click >/dev/null || fail "Start from scratch (AQU-2105 source step)"
ab find label "Project name" fill "$NAME" >/dev/null || fail "name field"
ab find label "Source language" fill "en" >/dev/null || fail "source field"
ab find label "Language lanes" fill "fr" >/dev/null || fail "lanes field"
ab find role button click --name "Create project" >/dev/null || fail "Create project button"
# The overview is /projects/<id>, headed by the project's name.
ab wait --load networkidle >/dev/null
i=0
while [ "$i" -lt 30 ]; do
  url=$(ab get url); case "$url" in */projects/*) break;; esac
  i=$((i + 1)); sleep 0.5
done
case "$url" in */projects/*) ;; *) fail "url after Create project: $url";; esac
ab wait --text "$NAME" >/dev/null || fail "overview did not load"

ref=$(ref_for 'link "Project settings"')
[ -n "$ref" ] || fail "Project settings link not in snapshot"
ab click "@$ref" >/dev/null || fail "click Project settings"
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */settings*) ;; *) fail "url after Project settings click: $url";; esac

# The index lists its groups as links whose accessible name starts with the
# group's label ("General Name, languages, content structure, Bible data").
# The General pane itself (?section=general) shows #pname.
ref=$(ref_for 'link "General')
if [ -n "$ref" ]; then
  ab click "@$ref" >/dev/null || fail "click General"
  ab wait --load networkidle >/dev/null
fi
ab wait "#pname" >/dev/null || fail "General pane (Project name field) did not load"

# Name only: the language is a lane row, edited below.
ab fill "#pname" "$RENAMED" >/dev/null || fail "fill Project name"
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

name_val=$(ab get value "#pname")
[ "$name_val" = "$RENAMED" ] || fail "Project name after save: got '$name_val'"

ab reload >/dev/null
ab wait "#pname" >/dev/null || fail "General pane did not reload"
name_after_reload=$(ab get value "#pname")
[ "$name_after_reload" = "$RENAMED" ] || fail "Project name after reload: got '$name_after_reload'"

# Source language: the Languages table shows it as one line with Change, which
# opens the lane's fields; Language takes a typed name and Save writes the lane.
# The table sits below the fold on a fresh pane, so bring each control into
# view before clicking it (a click outside the viewport is refused).
# The Languages table loads after the name field, so wait for the line rather than counting it at once.
ab wait '[data-testid="source-language-line"]' >/dev/null || fail "source language line not present"
ab scrollintoview '[data-testid="source-language-change"]' >/dev/null 2>&1
ab find testid "source-language-change" click >/dev/null || fail "Change (source language) button"
ab wait '[data-testid^="lane-edit-"]' >/dev/null || fail "lane editor did not open"
ab fill '[data-testid^="lane-edit-"] [data-testid^="lane-language-"]' "English (US)" >/dev/null || fail "fill lane Language"
ab scrollintoview '[data-testid^="lane-edit-"] [data-testid^="lane-save-"]' >/dev/null 2>&1
ab click '[data-testid^="lane-edit-"] [data-testid^="lane-save-"]' >/dev/null || fail "lane Save button"
ab wait --load networkidle >/dev/null
# Persistence: the lane row, not local state, must hold the language.
ab reload >/dev/null
ab wait '[data-testid="source-language-line"]' >/dev/null || fail "source language line did not reload"
line=$(ab get text '[data-testid="source-language-line"]')
case "$line" in *"English (US)"*) ;; *) fail "source language after reload: got '$line'";; esac

pass "renamed to '$RENAMED' and it survives reload; source lane language 'English (US)' saved and survives reload"
