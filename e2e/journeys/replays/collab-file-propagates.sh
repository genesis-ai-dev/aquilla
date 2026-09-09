#!/usr/bin/env sh
# Replay of collab-file-propagates.md. Two sessions: alice imports, bob reads.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
countA() { if [ -n "${2:-}" ]; then abA snapshot -i -c -s "$2" | grep -c -- "$1"; else abA snapshot -i -c | grep -c -- "$1"; fi; }
countB() { if [ -n "${2:-}" ]; then abB snapshot -i -c -s "$2" | grep -c -- "$1"; else abB snapshot -i -c | grep -c -- "$1"; fi; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }

NAME="Collab FP $(date +%H%M%S)"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null

# 1. Alice creates the project.
abA open "$BASE/orgs/9/projects" >/dev/null && abA wait --load networkidle >/dev/null
abA find role button click --name "New Project" >/dev/null || fail "New Project button"
abA wait --text "Create New Project" >/dev/null || fail "create dialog"
abA find label "Project title" fill "$NAME" >/dev/null || fail "title field"
abA find label "Source Language" fill "en" >/dev/null || fail "source field"
abA find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
abA find role button click --name "Create Project" >/dev/null || fail "Create Project button"
abA wait --text "Open project" >/dev/null || fail "overview did not load"
projectUrl=$(abA get url)
projectId=$(echo "$projectUrl" | sed -n 's#.*/projects/\([^/?#]*\).*#\1#p')
[ -n "$projectId" ] || fail "could not parse project id from $projectUrl"

# 2. Alice adds bob as a member. "Project settings" and "Members" are
# `link` roles inside the sidebar/settings panel; `find role link --name`
# misses them (known harness quirk), so click by ref instead.
settingsRef=$(abA snapshot -i -c | grep -o 'link "Project settings" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$settingsRef" ] || fail "Project settings link not in snapshot"
abA click "@$settingsRef" >/dev/null || fail "click Project settings"
abA wait --text "Roles & invites" >/dev/null || fail "settings panel"
membersRef=$(abA snapshot -i -c | grep -o 'link "Members Roles & invites" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$membersRef" ] || fail "Members link not in snapshot"
abA click "@$membersRef" >/dev/null || fail "click Members"
abA wait --text "Add a member" >/dev/null || fail "Members page"
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
# "Aquilla username" is the textbox's accessible name, not rendered page text,
# so `wait --text` never sees it (known harness quirk) — wait for the dialog
# heading instead, then fill the textbox by ref.
abA wait "[role=tabpanel]" >/dev/null || fail "add member dialog"
userRef=$(abA snapshot -i -c | grep -o 'textbox "Aquilla username" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$userRef" ] || fail "username field not in snapshot"
abA fill "@$userRef" "bob" >/dev/null || fail "fill username field"
sleep 1
cb=$(abA snapshot -i -c | grep -o 'checkbox "bob"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$cb" ] || fail "bob suggestion checkbox not in snapshot"
abA click "@$cb" >/dev/null || fail "click bob suggestion"
addBtn=$(abA snapshot -i -c | grep -o 'button "Add" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$addBtn" ] || fail "Add button not found or still disabled"
abA click "@$addBtn" >/dev/null || fail "click Add"
abA wait --text "Contributor" >/dev/null || fail "member row did not appear"
sleep 1
[ "$(countA "cell \"bob" "table")" -ge 1 ] || fail "bob not in Members table"
abA find role button click --name "Close" >/dev/null || fail "close Members dialog"

# 3. Alice imports sample.md.
abA open "$projectUrl" >/dev/null
abA wait --load networkidle >/dev/null
abA find role button click --name "Open project" >/dev/null || fail "Open project button"
abA wait --load networkidle >/dev/null
# The editor shows a "Loading project…" placeholder for a beat after
# networkidle fires; the Import button isn't in the DOM until that clears.
abA wait --text "Import" >/dev/null || fail "editor did not finish loading"
abA find role button click --name "Import" >/dev/null || fail "Import button"
abA wait --text "Upload files" >/dev/null || fail "import dialog"
# find role button --name fails on this control's long, punctuation-heavy
# accessible name even though the button role/name match exactly in the
# snapshot (known harness quirk) — click by ref instead.
uploadRef=$(abA snapshot -i -c | grep -o 'button "Upload files[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$uploadRef" ] || fail "Upload files card not in snapshot"
abA click "@$uploadRef" >/dev/null || fail "click Upload files card"
sleep 1
# Do not `wait` on the file input selector here: it reliably times out
# (30s) even though the input is already present, and a retry after the
# timeout can misfire into about:blank / a logged-out session (known
# harness quirk). Upload straight after the click, as the given recipe says.
abA upload "input[type=file]:not([webkitdirectory])" "$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md" >/dev/null || fail "upload sample.md"
# Parsing sample.md into an import preview can take longer than one 30s
# `wait --text` under load from the other agents sharing this dev stack —
# retry a couple of times before calling it a failure.
confirmed=0
for _ in 1 2 3; do
  abA wait --text "Confirm import" >/dev/null && { confirmed=1; break; }
done
[ "$confirmed" -eq 1 ] || fail "import preview"
abA find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
abA wait "aside" >/dev/null
sleep 1
[ "$(countA "sample.md" "aside")" -ge 1 ] || fail "sample.md not in alice's sidebar"

# 4. Bob opens the project editor directly (no prior visit, no reload after).
editorUrl="$BASE/project/$projectId/editor"
abB open "$editorUrl" >/dev/null || fail "bob open editor"
abB wait --load networkidle >/dev/null
abB wait "aside" >/dev/null
[ "$(countB "sample.md" "aside")" -ge 1 ] || fail "sample.md missing from bob's sidebar on first load"

pass "bob's sidebar shows sample.md on first visit to $editorUrl (project $NAME, id $projectId), no reload"
