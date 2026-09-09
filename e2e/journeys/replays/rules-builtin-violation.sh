#!/usr/bin/env sh
# Replay of rules-builtin-violation.md. Creates its own project first.
. "$(dirname "$0")/_lib.sh"
NAME="Journey rules-viol $(date +%H%M%S)"
FIXTURE="$(cd "$(dirname "$0")/../../fixtures" && pwd)/sample.md"
login alice || fail "login"
ab open "$BASE/orgs/9/projects" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "New Project" >/dev/null || fail "New Project button"
ab wait --text "Create New Project" >/dev/null || fail "dialog"
ab find label "Project title" fill "$NAME" >/dev/null && ab find label "Source Language" fill "en" >/dev/null && ab find label "Target language(s)" fill "fr" >/dev/null || fail "fill create-project fields"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "Open project" >/dev/null || fail "overview did not load"
url=$(ab get url)
pid=$(echo "$url" | sed -n 's#.*/projects/##p')
[ -n "$pid" ] || fail "could not read project id from $url"

# The rules page redirects to /memory/quality — the Rules region lives there.
ab open "$BASE/project/$pid/rules" >/dev/null && ab wait --load networkidle >/dev/null
# The redirect to /memory/quality can finish loading before the Rules region
# has hydrated its rows; wait for a stable landmark in that region first.
ab wait --text "Add Rule" >/dev/null || fail "Rules region did not render"
swLine=$(ab snapshot -i -c | grep -o 'switch "Extra whitespace enabled" \[checked=[a-z]*[^]]*ref=e[0-9]*\]' | head -1)
[ -n "$swLine" ] || fail "Extra whitespace enabled switch not on the page"
checked=$(echo "$swLine" | grep -o 'checked=[a-z]*' | cut -d= -f2)
if [ "$checked" != "true" ]; then
  swRef=$(echo "$swLine" | grep -o 'ref=e[0-9]*' | grep -o 'e[0-9]*')
  ab click "@$swRef" >/dev/null || fail "click Extra whitespace enabled switch"
  swLine2=$(ab snapshot -i -c | grep -o 'switch "Extra whitespace enabled" \[checked=[a-z]*[^]]*ref=e[0-9]*\]' | head -1)
  case "$swLine2" in *checked=true*) ;; *) fail "switch did not turn on" ;; esac
fi

# Back to the editor, import sample.md.
ab open "$BASE/project/$pid/editor" >/dev/null && ab wait --load networkidle >/dev/null
ab find role button click --name "Import" >/dev/null || fail "Import button"
ab wait --text "Upload files" >/dev/null || fail "import dialog"
ab find role button click --name "Upload files" >/dev/null || fail "Upload files card"
ab wait --text "Choose Files" >/dev/null || fail "choose files panel"
ab upload "input[type=file]:not([webkitdirectory])" "$FIXTURE" >/dev/null || fail "select sample.md"
ab wait --text "Confirm import" >/dev/null || fail "import preview"
ab find role button click --name "Confirm import" >/dev/null || fail "Confirm import button"
ab wait "[data-cell-id]" >/dev/null || fail "editor did not show cells"

# Cell 0 is the structural "Heading" cell; cell 1 is the first content cell
# ("Line 1"). Grab cell 1's id and click its read view by CSS, not an ordinal
# selector — nth-child does not line up with data-cell-id siblings here.
cellId=$(ab eval --stdin <<'JS'
document.querySelectorAll('[data-cell-id]')[1].getAttribute('data-cell-id')
JS
)
cellId=$(echo "$cellId" | tr -d '"')
[ -n "$cellId" ] || fail "could not find cell 1's id"
sel="[data-cell-id='$cellId'] [data-cell-type='target'] [data-target-read-view]"
ab click "$sel" >/dev/null || fail "click row 2 read view"
ab wait "[data-cell-id='$cellId'] [contenteditable='true']" >/dev/null || fail "editable field did not mount"
ab focus "[data-cell-id='$cellId'] [contenteditable='true']" >/dev/null || fail "focus editable field"
ab keyboard inserttext "this  has  double  spaces in e2e." >/dev/null || fail "insertText"
ab click "aside" >/dev/null || fail "blur to commit"

committed=$(ab eval --stdin <<JS
document.querySelector("[data-cell-id='$cellId'] [data-cell-type='target']")?.textContent
JS
)
case "$committed" in
  *"this  has  double  spaces in e2e."*) ;;
  *) fail "double space did not survive commit: $committed" ;;
esac

pillClass=$(ab eval --stdin <<JS
(() => {
  const row = document.querySelector("[data-cell-id='$cellId']")
  const pill = row.querySelector('[aria-label="Line 1"] span')
  return pill ? pill.className : ''
})()
JS
)
case "$pillClass" in
  *amber*) ;;
  *) fail "Line 1 pill did not tint amber: $pillClass" ;;
esac
pass "Extra whitespace rule flagged Line 1 amber after a double-space commit ($pid)"
