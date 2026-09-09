#!/usr/bin/env sh
# Replay of editor-comments-write-through.md. Creates its own project first.
. "$(dirname "$0")/_lib.sh"
NAME="Journey comments $(date +%H%M%S)"
FIXTURE="$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md"
login alice || fail "login"
ab open "$BASE/orgs/9/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait --text "Create New Project" >/dev/null || fail "dialog"
ab find label "Project title" fill "$NAME" >/dev/null && ab find label "Source Language" fill "en" >/dev/null && ab find label "Target language(s)" fill "fr" >/dev/null || fail "fill create-project fields"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"
ab find role button click --name "Open project" >/dev/null || fail "Open project button"
ab wait --load networkidle >/dev/null

# Import sample.md through Upload files -> Confirm import.
ab find role button click --name "Import" >/dev/null || fail "Import button"
ab wait --text "Upload files" >/dev/null || fail "import dialog"
ab find role button click --name "Upload files" >/dev/null || fail "Upload files card"
ab wait --text "Choose Files" >/dev/null || fail "choose files panel"
ab upload "input[type=file]:not([webkitdirectory])" "$FIXTURE" >/dev/null || fail "select sample.md"
ab wait --text "Confirm import" >/dev/null || fail "import preview"
ab find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
ab wait "[data-cell-id]" >/dev/null || fail "editor did not show cells"

# The row action rail (Add comment lives there) only renders on a fresh hover
# gesture and idle-collapses ~2.2s later even if the pointer never left the
# row (see the story's Notes for the agent). A CSS-selector `hover` on the
# row is unreliable here; move the mouse away then onto the row's own
# coordinates, then act immediately.
xy=$(ab eval --stdin <<'JS'
(() => {
  const r = document.querySelectorAll('[data-cell-id]')[0].getBoundingClientRect()
  return Math.round(r.x + r.width / 2) + " " + Math.round(r.y + r.height / 2)
})()
JS
)
x=$(echo "$xy" | tr -d '"' | awk '{print $1}')
y=$(echo "$xy" | tr -d '"' | awk '{print $2}')
[ -n "$x" ] && [ -n "$y" ] || fail "could not read row 1 position"
ab mouse move 50 400 >/dev/null
ab mouse move "$x" "$y" >/dev/null
ab find role button click --name "Add comment" >/dev/null || fail "Add comment button not revealed/clickable on row 1"
# The drawer's textbox has only a placeholder ("Start a new comment
# thread..."), not rendered text, so `wait --text` never sees it (it reads
# visible text only). Wait for the drawer container instead.
ab wait "[data-testid='comments-drawer']" >/dev/null || fail "comments panel did not open"

COMMENT="e2e-agent-comment-$(date +%H%M%S)"
boxRef=$(ab snapshot -i -c -s "[data-testid='comments-drawer']" | grep -o 'textbox "Start a new comment thread[^"]*" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$boxRef" ] || fail "new-thread textbox not found in drawer"
ab fill "@$boxRef" "$COMMENT" >/dev/null || fail "type comment"
postRef=$(ab snapshot -i -c -s "[data-testid='comments-drawer']" | grep -o 'button "Post" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$postRef" ] || fail "Post button not found"
ab click "@$postRef" >/dev/null || fail "click Post"
ab wait --text "$COMMENT" >/dev/null || fail "comment text never appeared"

# The posted comment body is plain text, not an interactive element, so it
# never shows in an `-i` snapshot (count()'s basis) even though it is on the
# page. Read the drawer's rendered text directly instead.
drawerText=$(ab get text "[data-testid='comments-drawer']")
case "$drawerText" in
  *"$COMMENT"*) ;;
  *) fail "comment text not in drawer" ;;
esac
[ "$(count "1 open comment" "[data-cell-id]:first-of-type")" -ge 1 ] || fail "row's open-comment badge did not update"
[ "$(count "Comments 1" "aside")" -ge 1 ] || fail "sidebar Comments count did not update"
pass "comment '$COMMENT' write-through: drawer, row badge, and sidebar count all updated"
