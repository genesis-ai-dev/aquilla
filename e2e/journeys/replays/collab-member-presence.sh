#!/usr/bin/env sh
# Replay of collab-member-presence.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
NAME="Presence Journey $(date +%H%M%S)"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null

abA open "$BASE/orgs/$ORG/projects" >/dev/null && abA wait --load networkidle >/dev/null
abA find role button click --name "New Project" >/dev/null || fail "New Project button"
abA wait --text "Create New Project" >/dev/null || fail "create dialog"
abA find label "Project title" fill "$NAME" >/dev/null || fail "title field"
abA find label "Source Language" fill "en" >/dev/null || fail "source field"
abA find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
abA find role button click --name "Create Project" >/dev/null || fail "Create Project button"
abA wait --text "Open project" >/dev/null || fail "overview did not load"
url=$(abA get url)
projectId=$(echo "$url" | sed -n 's#.*/projects/##p')
[ -n "$projectId" ] || fail "no project id in overview url: $url"

# Project settings > Members > Add a member. "Project settings" is a link on
# the overview page - clicked by ref, `find role link --name` misses it.
settingsRef=$(abA snapshot -i -c | grep -o 'link "Project settings"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$settingsRef" ] || fail "Project settings link not in snapshot"
abA click "@$settingsRef" >/dev/null || fail "click Project settings"
# "Project settings" text is already on the overview page (the link's own
# label), so waiting for it is a false-pass trap. Wait for text unique to the
# settings panel's sidebar instead.
abA wait --text "Roles & invites" >/dev/null || fail "settings panel"
membersRef=$(abA snapshot -i -c | grep -o 'link "Members[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$membersRef" ] || fail "Members link not in snapshot"
abA click "@$membersRef" >/dev/null || fail "click Members"
abA wait --text "Add a member" >/dev/null || fail "members page"
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
# The username field's accessible name comes from its `placeholder`
# attribute, not visible label text, so `wait --text "Aquilla username"`
# never matches (wait --text is visible-rendered-text only). Wait for the
# input element itself.
abA wait 'input[placeholder="Aquilla username"]' >/dev/null || fail "add member dialog"
# The field has no real <label> element either (name comes from the
# placeholder), so `find label` can't locate it - pull its ref and fill.
userRef=$(abA snapshot -i -c | grep -o 'textbox "Aquilla username"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$userRef" ] || fail "username field not in snapshot"
abA fill "@$userRef" "bob" >/dev/null || fail "username field"
cb=""
i=0
while [ "$i" -lt 10 ]; do
  cb=$(abA snapshot -i -c | grep -o 'checkbox "bob"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
  [ -n "$cb" ] && break
  sleep 1
  i=$((i + 1))
done
[ -n "$cb" ] || fail "bob suggestion checkbox never rendered"
abA check "@$cb" >/dev/null || fail "check bob suggestion"
# `find role button --name "Add"` is unreliable here - it can match or land
# on the wrong "Add"-ish control (the dialog also has an "Add a member"
# trigger and a disabled "Add" state moments earlier). Pull the enabled
# submit button's ref from the snapshot and click that.
addRef=$(abA snapshot -i -c | grep -o 'button "Add"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$addRef" ] || fail "Add button not in snapshot"
abA click "@$addRef" >/dev/null || fail "click Add button"
# "Contributor" is already visible as the dialog's default role selector
# before submit, so it would false-pass. Wait for bob's email, which only
# appears once his row lands in the table.
abA wait --text "bob@local.test" >/dev/null || fail "bob row did not appear"
rows=$(abA snapshot -i -c -s table | grep -c 'cell "bob')
[ "$rows" -ge 1 ] || fail "no bob row in members table"
closeRef=$(abA snapshot -i -c | grep -o 'button "Close"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$closeRef" ] || fail "Close button not in snapshot"
abA click "@$closeRef" >/dev/null || fail "close members dialog"

# Both sessions open the same project's editor so they share the live socket.
abA open "$BASE/project/$projectId/editor" >/dev/null && abA wait --load networkidle >/dev/null
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null
abB open "$BASE/project/$projectId/editor" >/dev/null && abB wait --load networkidle >/dev/null

# Presence over the socket usually lands within a second or two; under load
# (several agents on one stack) it can take longer. Poll for the trigger for
# up to 30 s, then reload alice once and poll again, noting the reload.
find_trig() {
  abA snapshot -i -c -s main | grep -o 'button "BO bob"[^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1
}
poll_trig() {
  i=0
  while [ "$i" -lt 30 ]; do
    trig=$(find_trig)
    [ -n "$trig" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}
reloaded="no reload needed"
trig=""
if ! poll_trig; then
  abA reload >/dev/null 2>&1 || abA open "$BASE/project/$projectId/editor" >/dev/null
  abA wait --load networkidle >/dev/null
  reloaded="alice reloaded once"
  poll_trig || fail "presence trigger 'BO bob' never appeared for alice, even after a reload"
fi

abA click "@$trig" >/dev/null || fail "click presence trigger"
sleep 1
# The popover is a `dialog` node that -i (interactive-only) snapshots miss;
# a plain snapshot scoped to main is needed to see it.
dlg=$(abA snapshot -c -s main | grep -c 'dialog "1 online"')
[ "$dlg" -ge 1 ] || fail "presence popover 'dialog \"1 online\"' not found"
item=$(abA snapshot -c -s main | grep -c 'button "BO bob online"')
[ "$item" -ge 1 ] || fail "'BO bob online' entry not inside the popover"

abA press Escape >/dev/null
sleep 1
gone=$(abA snapshot -c -s main | grep -c 'dialog "1 online"')
[ "$gone" -eq 0 ] || fail "popover still present after Escape"

pass "popover 'dialog \"1 online\"' with 'BO bob online' shown for project $projectId, closed on Escape ($reloaded)"
