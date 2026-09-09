#!/usr/bin/env sh
# Replay of rules-custom-crud.md. Creates its own project first.
. "$(dirname "$0")/_lib.sh"
NAME="Journey rules-crud $(date +%H%M%S)"
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

# The rules page redirects to /memory/quality; wait for a stable landmark
# (network-idle can settle before the Rules region hydrates its rows).
ab open "$BASE/project/$pid/rules" >/dev/null && ab wait --load networkidle >/dev/null
ab wait --text "Add Rule" >/dev/null || fail "Rules region did not render"

# Add Rule dialog opens and Cancel dismisses it.
ab find role button click --name "Add Rule" >/dev/null || fail "Add Rule button"
ab wait --text "Create translation rule" >/dev/null || fail "create-rule dialog"
ab find role button click --name "Cancel" >/dev/null || fail "Cancel button in create dialog"
ab wait --text "Add Rule" >/dev/null || fail "dialog did not close"

# Create a rule for real.
RULENAME="TestRule $(date +%H%M%S)"
ab find role button click --name "Add Rule" >/dev/null || fail "re-open Add Rule dialog"
ab wait --text "Create translation rule" >/dev/null || fail "create-rule dialog (2nd open)"
ab find label "Rule name" fill "$RULENAME" >/dev/null || fail "fill Rule name"
ab find label "Pattern" fill "foo" >/dev/null || fail "fill Pattern"
ab find role button click --name "Create rule" >/dev/null || fail "Create rule button"
ruleText=$(ab get text "body")
case "$ruleText" in
  *"$RULENAME"*) ;;
  *) fail "'$RULENAME' not in the rules list after create" ;;
esac

# Edit rule opens an inline editor pre-filled with the name; its own Cancel
# closes it. Snapshot refs on this row go stale fast (the list re-renders on
# almost every action here), so re-query live via find/eval rather than
# reusing an earlier ref.
# A pointer click on this icon button (find role / ref / CSS) never fires its
# onClick here, while a DOM click does. Use eval until the cause is known.
ab eval 'document.querySelector("button[aria-label=\"Edit rule\"]").click(); "clicked"' >/dev/null || fail "Edit rule button"
ab wait "#re-name" >/dev/null || fail "inline editor did not mount"
preFilled=$(ab eval --stdin <<'JS'
document.querySelector('#re-name')?.value ?? ''
JS
)
preFilled=$(echo "$preFilled" | tr -d '"')
[ "$preFilled" = "$RULENAME" ] || fail "inline editor Rule name not pre-filled (got '$preFilled')"
# Two Cancel buttons exist once the editor is open; click the one inside the
# editor that owns #re-name, and use a DOM click (pointer clicks on this
# surface do not fire, see the Edit rule step above).
cancelled=$(ab eval --stdin <<'JS'
(() => {
  const name = document.querySelector('#re-name')
  let scope = name && name.closest('form')
  if (!scope) { scope = name; for (let i = 0; scope && i < 8; i++) { scope = scope.parentElement; if (scope && scope.querySelector('button') && Array.from(scope.querySelectorAll('button')).some(b => b.textContent.trim() === 'Cancel')) break } }
  const btn = scope && Array.from(scope.querySelectorAll('button')).find(b => b.textContent.trim() === 'Cancel')
  if (!btn) return 'no-cancel'
  btn.click(); return 'clicked'
})()
JS
)
case "$cancelled" in *clicked*) ;; *) fail "inline editor Cancel button ($cancelled)";; esac
ab wait 500 >/dev/null
stillOpen=$(ab eval --stdin <<'JS'
!!document.querySelector('#re-name')
JS
)
case "$stillOpen" in
  false) ;;
  *) fail "inline editor still open after Cancel" ;;
esac

# Delete: the trash-can button is icon-only (no accessible name), so find it
# by locating the rule's own <li> row and clicking the button inside it.
clicked=$(ab eval --stdin <<JS
(() => {
  const li = Array.from(document.querySelectorAll('li')).find((el) => el.textContent.includes("$RULENAME"))
  const trash = li ? li.querySelector('button:has(svg.lucide-trash-2)') : null
  if (!trash) return 'no-trash-button'
  trash.click()
  return 'clicked'
})()
JS
)
clicked=$(echo "$clicked" | tr -d '"')
[ "$clicked" = "clicked" ] || fail "could not find/click the trash-can button ($clicked)"

remaining=$(ab get text "body")
case "$remaining" in
  *"$RULENAME"*) fail "'$RULENAME' still on the page after delete" ;;
  *) ;;
esac
pass "'$RULENAME' created, edited (pre-filled + cancel), and deleted ($pid)"
