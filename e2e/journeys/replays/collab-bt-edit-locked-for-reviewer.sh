#!/usr/bin/env sh
# Replay of collab-bt-edit-locked-for-reviewer.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }
countA() { if [ -n "${2:-}" ]; then abA snapshot -i -c -s "$2" | grep -c -- "$1"; else abA snapshot -i -c | grep -c -- "$1"; fi; }
countB() { if [ -n "${2:-}" ]; then abB snapshot -i -c -s "$2" | grep -c -- "$1"; else abB snapshot -i -c | grep -c -- "$1"; fi; }

NAME="BT locked $(date +%H%M%S)"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null

abA open "$BASE/orgs/$ORG/projects" >/dev/null && abA wait --load networkidle >/dev/null
abA find role button click --name "New Project" >/dev/null || fail "New Project button"
abA wait --text "Create New Project" >/dev/null || fail "create dialog"
abA find label "Project title" fill "$NAME" >/dev/null || fail "title field"
abA find label "Source Language" fill "en" >/dev/null || fail "source field"
abA find label "Target language(s)" fill "es" >/dev/null || fail "target field"
abA find role button click --name "Create Project" >/dev/null || fail "Create Project button"
abA wait --text "Open project" >/dev/null || fail "overview did not load"
abA find role button click --name "Open project" >/dev/null || fail "Open project button"
abA wait --load networkidle >/dev/null
abA wait --text "Import" >/dev/null || fail "editor toolbar did not render"

abA find role button click --name "Import" >/dev/null || fail "Import button"
abA wait --text "Upload files" >/dev/null || fail "import dialog"
uploadCard=$(abA snapshot -i -c | grep -o 'button "Upload files[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$uploadCard" ] || fail "Upload files card ref not found"
abA click "@$uploadCard" >/dev/null || fail "click Upload files card"
abA wait --text "Choose Files" >/dev/null || fail "upload panel did not open"
SAMPLE="$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md"
abA upload "input[type=file]:not([webkitdirectory])" "$SAMPLE" >/dev/null || fail "file upload"
if ! abA wait --text "Confirm import" >/dev/null; then
  # The upload occasionally lands on the input before the app has finished
  # wiring its change handler and the panel never advances. One retry clears it.
  abA upload "input[type=file]:not([webkitdirectory])" "$SAMPLE" >/dev/null || fail "file upload retry"
  abA wait --text "Confirm import" >/dev/null || fail "import preview"
fi
abA find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
abA wait "[data-cell-id]" >/dev/null || fail "cells did not render"

# Edit row 1's target cell.
# Click the read view by selector; a ref from a scoped snapshot failed to click here.
abA click "[data-cell-id]:first-of-type [data-target-read-view]" >/dev/null || fail "click row 1 target"
abA wait '[contenteditable="true"]' >/dev/null || fail "editable field did not mount"
editRef=$(abA snapshot -i -c -s "[data-cell-id]:first-of-type" | grep -o 'textbox "row 1 — empty" \[ref=e[0-9]*\]' | grep -o 'e[0-9]*' | head -1)
[ -n "$editRef" ] || fail "editable ref not found"
TRANSLATION="Traduccion prueba $(date +%H%M%S)"
abA type "@$editRef" "$TRANSLATION" >/dev/null || fail "type translation"
abA click "aside" >/dev/null || fail "commit edit"
[ "$(countA "$TRANSLATION" "[data-cell-id]:first-of-type [data-cell-type=target]")" -ge 1 ] || fail "translation not committed"

# Open cell details and generate a back-translation.
detailsBtn=$(abA snapshot -i -c -s "[data-cell-id]:first-of-type" | grep -o 'button "Open cell details" \[ref=e[0-9]*\]' | grep -o 'e[0-9]*' | head -1)
[ -n "$detailsBtn" ] || fail "Open cell details ref not found"
abA click "@$detailsBtn" >/dev/null || fail "open cell details"
abA wait --text "Back-translation" >/dev/null || fail "BT tab did not appear"
genBtn=$(abA snapshot -i -c | grep -o 'button "Generate back-translation" \[ref=e[0-9]*\]' | grep -o 'e[0-9]*' | head -1)
[ -n "$genBtn" ] || fail "Generate back-translation button not found"
abA click "@$genBtn" >/dev/null || fail "click Generate back-translation"
abA wait --text "Matches this translation" >/dev/null || fail "back-translation did not generate"

# Add bob as a Reviewer.
abA find role button click --name "Settings" >/dev/null || fail "Settings button"
abA wait --text "Project settings" >/dev/null || fail "settings page"
membersLink=$(abA snapshot -i -c | grep -o 'link "Members[^"]*" \[ref=e[0-9]*\]' | grep -o 'e[0-9]*' | head -1)
[ -n "$membersLink" ] || fail "Members link ref not found"
abA click "@$membersLink" >/dev/null || fail "open Members"
abA wait --text "Add a member" >/dev/null || fail "members page"
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
abA wait --text "Aquilla username" >/dev/null || fail "add member dialog"
abA find label "Aquilla username" fill "bob" >/dev/null || fail "username field"
bobChk=$(abA snapshot -i -c | grep -o 'checkbox "bob" \[[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$bobChk" ] || fail "bob suggestion checkbox not found"
abA click "@$bobChk" >/dev/null || fail "select bob suggestion"
roleBox=$(abA snapshot -i -c | grep -o 'combobox "Role" \[expanded=false, ref=e[0-9]*\]' | grep -o 'e[0-9]*$' | head -1)
[ -n "$roleBox" ] || fail "Role combobox ref not found"
abA click "@$roleBox" >/dev/null || fail "open Role combobox"
abA wait --text "Reviewer" >/dev/null || fail "role options did not open"
reviewerOpt=$(abA snapshot -i -c | grep -o 'option "Reviewer[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$reviewerOpt" ] || fail "Reviewer option not found"
abA click "@$reviewerOpt" >/dev/null || fail "pick Reviewer role"
abA find role button click --name "Add" >/dev/null || fail "Add button"
abA wait --text "Reviewer" >/dev/null || fail "member row did not appear"
[ "$(countA "bob" "table")" -ge 1 ] || fail "bob row not in members table"

url=$(abA get url)
projectId=$(echo "$url" | sed -n 's#.*/project/\([^/]*\)/.*#\1#p')
fileId=$(echo "$url" | sed -n 's#.*/file/\([^/?#]*\).*#\1#p')
[ -n "$projectId" ] || fail "could not extract project id from $url"
[ -n "$fileId" ] || fail "could not extract file id from $url"

# Bob opens the same file directly.
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null
abB open "$BASE/project/$projectId/editor/file/$fileId" >/dev/null || fail "bob open file"
abB wait "[data-cell-id]" >/dev/null || fail "bob's cells did not render"
[ "$(countB "$TRANSLATION" "[data-cell-id]:first-of-type [data-cell-type=target]")" -ge 1 ] || fail "bob did not see alice's translation"

bobDetailsBtn=$(abB snapshot -i -c -s "[data-cell-id]:first-of-type" | grep -o 'button "Open cell details" \[ref=e[0-9]*\]' | grep -o 'e[0-9]*' | head -1)
[ -n "$bobDetailsBtn" ] || fail "bob's Open cell details ref not found"
abB click "@$bobDetailsBtn" >/dev/null || fail "bob open cell details"
abB wait --text "Back-translation" >/dev/null || fail "bob's BT tab did not appear"

[ "$(countB "Contributor+ required to edit back-translations" "[role=tabpanel]")" -ge 1 ] || fail "locked Edit affordance not shown to reviewer"
[ "$(countB "Generate back-translation" "[role=tabpanel]")" -eq 0 ] || fail "reviewer can see Generate back-translation button"

pass "bob (Reviewer) sees locked BT edit on project $projectId, file $fileId; no generate button present"
