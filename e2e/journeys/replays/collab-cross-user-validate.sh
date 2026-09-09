#!/usr/bin/env sh
# Replay of collab-cross-user-validate.md, the path found on the 2026-09-08 cold run.
# Two sessions: alice edits a cell, bob (added as Reviewer) validates it.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
countA() { if [ -n "${2:-}" ]; then abA snapshot -i -c -s "$2" | grep -c -- "$1"; else abA snapshot -i -c | grep -c -- "$1"; fi; }
countB() { if [ -n "${2:-}" ]; then abB snapshot -i -c -s "$2" | grep -c -- "$1"; else abB snapshot -i -c | grep -c -- "$1"; fi; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }
# The shared dev stack carries load from other agents' parallel sessions, so an
# element that is genuinely on the page can still miss the first `find` or
# `snapshot` while a render settles. Retry a few times with a short pause
# before failing, rather than giving up on the first miss.
retryFind() {
  who="$1"; name="$2"; n=0
  while [ "$n" -lt 5 ]; do
    "$who" find role button click --name "$name" >/dev/null 2>&1 && return 0
    sleep 2
    n=$((n + 1))
  done
  return 1
}
# $1 = ab function name (abA/abB), $2 = grep -o pattern ending in 'ref=e[0-9]*'
# (no closing bracket — the anchor on the second grep depends on that).
findRef() {
  who="$1"; pattern="$2"; n=0
  while [ "$n" -lt 6 ]; do
    ref=$("$who" snapshot -i -c | grep -o "$pattern" | grep -o 'e[0-9]*$' | head -1)
    if [ -n "$ref" ]; then echo "$ref"; return 0; fi
    sleep 1
    n=$((n + 1))
  done
  return 1
}

NAME="CrossValidate $(date +%H%M%S)"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null

# 1. Alice creates the project.
abA open "$BASE/orgs/9/projects" >/dev/null && abA wait --load networkidle >/dev/null
retryFind abA "New Project" || fail "New Project button"
abA wait --text "Create New Project" >/dev/null || fail "create dialog"
abA find label "Project title" fill "$NAME" >/dev/null || fail "title field"
abA find label "Source Language" fill "en" >/dev/null || fail "source field"
abA find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
retryFind abA "Create Project" || fail "Create Project button"
abA wait --text "Open project" >/dev/null || fail "overview did not load"
projectUrl=$(abA get url)
projectId=$(echo "$projectUrl" | sed -n 's#.*/projects/\([^/?#]*\).*#\1#p')
[ -n "$projectId" ] || fail "could not parse project id from $projectUrl"

# 2. Alice adds bob as a Reviewer. "Project settings" and "Members" are link
# roles that `find role link --name` misses (known harness quirk) — click by ref.
settingsRef=$(findRef abA 'link "Project settings" \[ref=e[0-9]*') || fail "Project settings link not in snapshot"
abA click "@$settingsRef" >/dev/null || fail "click Project settings"
abA wait --text "Roles & invites" >/dev/null || fail "settings panel"
membersRef=$(findRef abA 'link "Members Roles & invites"[^]]*ref=e[0-9]*') || fail "Members link not in snapshot"
abA click "@$membersRef" >/dev/null || fail "click Members"
abA wait --text "Add a member" >/dev/null || fail "members page"
addMemberBtn=$(findRef abA 'button "Add a member"[^]]*ref=e[0-9]*') || fail "Add a member button not in snapshot"
abA click "@$addMemberBtn" >/dev/null || fail "click Add a member"
usernameRef=$(findRef abA 'textbox "Aquilla username" \[ref=e[0-9]*') || fail "Aquilla username field not in snapshot"
abA fill "@$usernameRef" "bob" >/dev/null || fail "fill username field"
bobChk=$(findRef abA 'checkbox "bob"[^]]*ref=e[0-9]*') || fail "bob suggestion checkbox not in snapshot"
abA click "@$bobChk" >/dev/null || fail "click bob suggestion"
sleep 0.5
roleBox=$(findRef abA 'combobox "Role"[^]]*ref=e[0-9]*') || fail "Role combobox not in snapshot"
abA click "@$roleBox" >/dev/null || abA find role combobox click --name "Role" >/dev/null || fail "open Role combobox"
reviewerOpt=$(findRef abA 'option "Reviewer[^]]*ref=e[0-9]*') || fail "Reviewer option not found"
abA click "@$reviewerOpt" >/dev/null || fail "pick Reviewer role"
addBtn=$(findRef abA 'button "Add"[^]]*ref=e[0-9]*') || fail "Add button not found or still disabled"
abA click "@$addBtn" >/dev/null || fail "click Add"
sleep 1
[ "$(countA "cell \"Reviewer\"" "table, [role=table]")" -ge 1 ] || fail "bob not listed as Reviewer in Members table"
closeRef=$(findRef abA 'button "Close"[^]]*ref=e[0-9]*') || fail "Close button not in snapshot"
abA click "@$closeRef" >/dev/null || fail "close Members dialog"

# 3. Alice imports sample.md.
abA open "$projectUrl" >/dev/null
abA wait --load networkidle >/dev/null
retryFind abA "Open project" || fail "Open project button"
abA wait --load networkidle >/dev/null
retryFind abA "Import" || fail "Import button"
abA wait --text "Upload files" >/dev/null || fail "import dialog"
uploadCard=$(findRef abA 'button "Upload files[^]]*ref=e[0-9]*') || fail "Upload files card ref not found"
abA click "@$uploadCard" >/dev/null || fail "click Upload files card"
abA upload "input[type=file]:not([webkitdirectory])" "$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md" >/dev/null || fail "upload sample.md"
abA wait --text "Confirm import" >/dev/null || fail "import preview"
retryFind abA "Confirm import" || fail "Confirm import button"
abA wait "[data-cell-id]" >/dev/null || fail "cells did not render"

# 4. Alice edits cell 0's target (the Heading row) and commits.
row0target=$(findRef abA 'textbox "row 1 — empty" \[ref=e[0-9]*') || fail "row 1 target ref not found"
abA click "@$row0target" >/dev/null || fail "click row 1 target"
abA wait '[contenteditable="true"]' >/dev/null || fail "editable field did not mount"
editRef=$(findRef abA 'textbox "row 1 — empty" \[ref=e[0-9]*') || fail "editable ref not found"
SENTENCE="Cross-validate alice translation $(date +%H%M%S)"
abA type "@$editRef" "$SENTENCE" >/dev/null || fail "type sentence"
abA click "aside" >/dev/null || fail "commit edit"
[ "$(countA "$SENTENCE" "[data-cell-id]:first-of-type [data-cell-type=target]")" -ge 1 ] || fail "sentence not committed"
[ "$(countA "Validated — row 1. Click to remove your validation." "[data-cell-id]:first-of-type")" -ge 1 ] || fail "alice's own commit did not auto-validate"

url=$(abA get url)
fileId=$(echo "$url" | sed -n 's#.*/file/\([^/?#]*\).*#\1#p')
[ -n "$fileId" ] || fail "could not extract file id from $url"

# 5. Bob opens the same file directly (no prior visit for this session).
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null
abB open "$BASE/project/$projectId/editor/file/$fileId" >/dev/null || fail "bob open file"
abB wait "[data-cell-id]" >/dev/null || fail "bob's cells did not render"

# 6. Poll for alice's sentence rather than reloading.
seen=0
i=0
while [ "$i" -lt 10 ]; do
  [ "$(countB "$SENTENCE" "[data-cell-id]:first-of-type [data-cell-type=target]")" -ge 1 ] && { seen=1; break; }
  sleep 1
  i=$((i + 1))
done
[ "$seen" -eq 1 ] || fail "bob never saw alice's sentence in cell 0"

# 7. Bob validates cell 0.
btn=$(findRef abB 'button "Validated by others[^]]*ref=e[0-9]*') || fail "'Validated by others' control not found for bob"
abB click "@$btn" >/dev/null || fail "click validation control"
sleep 1
[ "$(countB "Validated — row 1. Click to remove your validation." "[data-cell-id]:first-of-type")" -ge 1 ] || fail "validation control did not switch to 'Validated — row 1. Click to remove your validation.' for bob"

pass "bob validated cell 0 on project $projectId, file $fileId — control reads 'Validated — row 1. Click to remove your validation.'"
