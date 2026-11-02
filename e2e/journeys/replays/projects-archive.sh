#!/usr/bin/env sh
# Replay of projects-archive.md. Creates its own project first.
. "$(dirname "$0")/_lib.sh"
NAME="Journey archive $(date +%H%M%S)"
login alice || fail "login"
ab open "$BASE/orgs/$ORG/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New project" >/dev/null || fail "New project button"
ab wait --text "Create new project" >/dev/null || fail "dialog"
ab find label "Project name" fill "$NAME" >/dev/null && ab find label "Source language" fill "en" >/dev/null && ab find label "Language lanes" fill "fr" >/dev/null || fail "fill"
ab find role button click --name "Create project" >/dev/null || fail "Create project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"
overview=$(ab get url)
# Header overflow menu, then the Archive item and its confirm dialog.
ab find role button click --name "More actions" >/dev/null || fail "More actions button"
ab find role menuitem click --name "Archive" >/dev/null || fail "Archive menu item"
ab wait --text "I understand this project will be hidden" >/dev/null || fail "confirm dialog"
# Base UI checkbox: find its ref from the snapshot and check it by ref (find-by-role misses it).
cb=$(ab snapshot -i -c | grep -o 'checkbox "I understand this project will be hidden[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$cb" ] || fail "consent checkbox not in snapshot"
ab check "@$cb" >/dev/null || fail "check consent"
btn=$(ab snapshot -i -c | grep -o 'button "Archive" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$btn" ] || fail "confirm Archive button still disabled or missing after consent"
ab click "@$btn" >/dev/null || fail "click confirm Archive"
ab wait "table" >/dev/null || fail "did not land on Projects list"
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */orgs/$ORG/projects*) ;; *) fail "url after archive: $url";; esac
[ "$(count "cell \"$NAME\"" "table")" -eq 0 ] || fail "row '$NAME' still in active table"
ab open "$BASE/orgs/$ORG/archived" >/dev/null && ab wait --load networkidle >/dev/null
[ "$(count "cell \"$NAME\"" "table")" -ge 1 ] || fail "row '$NAME' missing from Archived"
pass "'$NAME' left the active table and is listed under Archived (overview was $overview)"
