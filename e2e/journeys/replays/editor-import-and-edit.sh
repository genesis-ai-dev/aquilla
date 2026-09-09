#!/usr/bin/env sh
# Replay of editor-import-and-edit.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
NAME="Journey editor $(date +%H%M%S)"
TEXT="Hello agent $(date +%H%M%S)"
FIXTURE="$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md"
login alice || fail "login"
ab open "$BASE/orgs/9/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait --text "Create New Project" >/dev/null || fail "dialog"
ab wait 'input' >/dev/null; ab wait 300 >/dev/null
ab find label "Project title" fill "$NAME" >/dev/null && ab find label "Source Language" fill "en" >/dev/null && ab find label "Target language(s)" fill "fr" >/dev/null || fail "fill"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview"
ab find role button click --name "Open project" >/dev/null || fail "Open project button"
ab wait --load networkidle >/dev/null
ab find role button click --name "Import" >/dev/null || fail "Import button"
ab wait --text "Upload files" >/dev/null || fail "import dialog"
ab find role button click --name "Upload files" >/dev/null || fail "Upload files card"
ab upload "input[type=file]:not([webkitdirectory])" "$FIXTURE" >/dev/null || fail "select sample.md"
ab wait --text "Confirm import" >/dev/null || fail "import preview"
ab find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
ab wait "[data-cell-id]" >/dev/null || fail "editor did not show cells"
cells=$(ab get count '[data-cell-id]'); [ "$cells" -ge 1 ] || fail "no cells"
# Click the first row's read view, wait for the editor to mount, type by ref.
ab click "[data-cell-id]:first-of-type [data-target-read-view]" >/dev/null || fail "click read view"
ab wait '[data-cell-id]:first-of-type [data-cell-type=target] [contenteditable="true"]' >/dev/null || fail "editable field did not mount"
ref=$(ab snapshot -i -c -s "[data-cell-id]:first-of-type [data-cell-type=target]" | grep -o 'textbox [^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$ref" ] || fail "no textbox ref in first row"
ab focus "@$ref" >/dev/null; ab type "@$ref" "$TEXT" >/dev/null || fail "type"
ab click "aside" >/dev/null && ab wait --load networkidle >/dev/null
got=$(ab get text "[data-cell-id]:first-of-type [data-cell-type=target]")
case "$got" in *"$TEXT"*) ;; *) fail "after blur, cell 1 reads: $got";; esac
url=$(ab get url)
ab reload >/dev/null && ab wait --load networkidle >/dev/null && ab wait "[data-cell-id]" >/dev/null || fail "reload"
got2=$(ab get text "[data-cell-id]:first-of-type [data-cell-type=target]")
case "$got2" in *"$TEXT"*) ;; *) fail "after reload, cell 1 reads: $got2";; esac
pass "'$TEXT' committed in cell 1 of $cells and survived reload at $url"
