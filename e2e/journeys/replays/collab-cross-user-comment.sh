#!/usr/bin/env sh
# Replay of collab-cross-user-comment.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }

NAME="CrossComment $(date +%H%M%S)"
FIXTURE="$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null

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
projectId=$(printf '%s' "$projectUrl" | sed -n 's#.*/projects/\([^/?#]*\).*#\1#p')
[ -n "$projectId" ] || fail "could not parse project id from $projectUrl"

# 2. Alice adds bob as a member. "Project settings" and "Members" are `link`
# roles that `find role link --name` misses even though the snapshot lists
# them; click by ref instead.
settingsRef=$(abA snapshot -i -c | grep -o 'link "Project settings" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$settingsRef" ] || fail "Project settings link not in snapshot"
abA click "@$settingsRef" >/dev/null || fail "click Project settings"
abA wait --text "Roles & invites" >/dev/null || fail "settings panel"
membersRef=$(abA snapshot -i -c | grep -o 'link "Members Roles & invites" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$membersRef" ] || fail "Members link not in snapshot"
abA click "@$membersRef" >/dev/null || fail "click Members"
abA wait --text "Add a member" >/dev/null || fail "Members page"
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
# The username field's accessible name is "Aquilla username", but `find
# label` misses it and `wait --text "Aquilla username"` never matches
# either (that string is not real rendered page text here) — fill by ref.
# The dialog itself occasionally doesn't open on the first click (a stray
# click landing before the page settles); retry once.
userRef=$(abA snapshot -i -c | grep -o 'textbox "Aquilla username" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
if [ -z "$userRef" ]; then
  sleep 1
  abA find role button click --name "Add a member" >/dev/null
  userRef=$(abA snapshot -i -c | grep -o 'textbox "Aquilla username" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
fi
[ -n "$userRef" ] || fail "Aquilla username field not in snapshot"
abA fill "@$userRef" "bob" >/dev/null || fail "type bob"
sleep 1
# Do NOT also click the "bob" suggestion checkbox before Add: typing the
# exact username is already enough to enable Add, and checkbox-then-Add is a
# race — on this stack it intermittently fires no request at all (the
# checkbox re-render can land after Add already fired, or before Add
# enables). Click Add directly off the typed username instead.
addBtn=$(abA snapshot -i -c | grep -o 'button "Add" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$addBtn" ] || fail "Add button not found or still disabled"
abA click "@$addBtn" >/dev/null || fail "click Add"
abA wait --fn "document.body.innerText.includes('bob@local.test')" >/dev/null || fail "bob not listed as a member"

# 3. Alice imports sample.md and opens it (navigating away closes the dialog).
# A click landing while the just-requested navigation is still in flight can
# abort it (net::ERR_ABORTED); retry once after a short settle.
abA open "$projectUrl" >/dev/null && abA wait --load networkidle >/dev/null
sleep 1
abA find role button click --name "Open project" >/dev/null 2>&1
abA wait --load networkidle >/dev/null 2>&1
case "$(abA get url)" in
  */editor*) : ;;
  *) sleep 1; abA find role button click --name "Open project" >/dev/null || fail "Open project button" ;;
esac
abA wait --load networkidle >/dev/null
sleep 1
abA find role button click --name "Import" >/dev/null || fail "Import button"
abA wait --text "Upload files" >/dev/null || fail "import dialog"
abA find role button click --name "Upload files" >/dev/null || fail "Upload files card"
abA upload "input[type=file]:not([webkitdirectory])" "$FIXTURE" >/dev/null || fail "select sample.md"
abA wait --text "Confirm import" >/dev/null || fail "import preview"
abA find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
abA wait "[data-cell-id]" >/dev/null || fail "editor did not show cells"

# 4. Alice expands row 1 via "Open cell details" instead of hovering it: the
# action rail (including Add comment) only renders on hover, and a hover
# command followed by a separate click command loses that hover state before
# the click lands — "Open cell details" expands the row into a persistent
# state that keeps the whole action set in the DOM with no hover needed.
# All seven rows carry an identically-named "Open cell details" / "Add
# comment" button, so `find role button --name` (and a CSS `:first-of-type`
# scope, which this snapshot tree does not support cleanly) can't target row
# 1 specifically. Rows render in document order, so the first match in a
# full snapshot is always row 1 — pull that ref out directly.
openRef=$(abA snapshot -i -c | grep -o 'button "Open cell details" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$openRef" ] || fail "Open cell details button not in snapshot"
abA click "@$openRef" >/dev/null || fail "click Open cell details"
abA wait --fn "document.body.innerText.includes('Retrieval support')" >/dev/null || fail "row did not expand"
addRef=$(abA snapshot -i -c | grep -o 'button "Add comment" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$addRef" ] || fail "Add comment button not in snapshot"
abA click "@$addRef" >/dev/null || fail "click Add comment"
abA wait "[data-testid='comments-drawer']" >/dev/null || fail "comments drawer did not open"

# 5. Alice posts a comment.
COMMENT="cross-comment-$(date +%s)"
boxRef=$(abA snapshot -i -c -s "[data-testid='comments-drawer']" | grep -o 'textbox "Start a new comment thread[^"]*" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$boxRef" ] || fail "new-thread textbox not found in drawer"
abA fill "@$boxRef" "$COMMENT" >/dev/null || fail "type comment"
postRef=$(abA snapshot -i -c -s "[data-testid='comments-drawer']" | grep -o 'button "Post" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$postRef" ] || fail "Post button not found"
abA click "@$postRef" >/dev/null || fail "click Post"
abA wait --text "$COMMENT" >/dev/null || fail "comment text never appeared in alice's drawer"
[ "$(abA get text "[data-testid='comments-drawer']" | grep -c -- "$COMMENT")" -ge 1 ] || fail "comment text not in alice's drawer"

# 6/7. Bob opens the comments page for the same project and polls for the
# text, clicking Refresh between checks since the page fetches once on
# mount with no live subscription.
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null
abB open "$BASE/project/$projectId/comments" >/dev/null
abB wait --load networkidle >/dev/null

# The comment text is real rendered text, so a plain snapshot grep sees it;
# `get text "main, body"` was unreliable here. Poll via the page's own
# Refresh button first (no reload), then fall back to one full reload and
# say so in the verdict, because "did bob need a reload" is the point.
found=0
i=0
while [ "$i" -lt 10 ]; do
  seen=$(abB eval "document.body.innerText.includes('$COMMENT') ? 1 : 0" 2>/dev/null | tr -dc '0-9')
  [ -n "$seen" ] || seen=0
  if [ "$seen" -ge 1 ]; then found=1; break; fi
  refreshRef=$(abB snapshot -i -c | grep -o 'button "Refresh" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
  [ -n "$refreshRef" ] && abB click "@$refreshRef" >/dev/null
  sleep 2
  i=$((i + 1))
done
reloaded=no
if [ "$found" -eq 0 ]; then
  reloaded=yes
  abB open "$BASE/project/$projectId/comments" >/dev/null
  abB wait --load networkidle >/dev/null
  abB wait --text "$COMMENT" >/dev/null || fail "bob's comments page never showed '$COMMENT' (even after a reload)"
fi

pass "bob's comments page shows '$COMMENT' for project $NAME ($projectId) after $i Refresh poll(s), reload needed: $reloaded"
