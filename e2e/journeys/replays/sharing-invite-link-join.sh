#!/usr/bin/env sh
# Replay of sharing-invite-link-join.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }
# count(pattern, selector?) scoped to bob's session, the only one this
# script counts against.
count() { if [ -n "${2:-}" ]; then abB snapshot -i -c -s "$2" | grep -c -- "$1"; else abB snapshot -i -c | grep -c -- "$1"; fi; }

NAME="Journey invite $(date +%H%M%S)"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null

abA open "$BASE/orgs/9/projects" >/dev/null && abA wait --load networkidle >/dev/null
abA find role button click --name "New Project" >/dev/null || fail "New Project button"
abA wait --text "Create New Project" >/dev/null || fail "create dialog"
abA find label "Project title" fill "$NAME" >/dev/null || fail "title field"
abA find label "Source Language" fill "en" >/dev/null || fail "source field"
abA find label "Target language(s)" fill "fr" >/dev/null || fail "target field"
abA find role button click --name "Create Project" >/dev/null || fail "Create Project button"
abA wait --text "Open project" >/dev/null || fail "overview did not load"
# The overview keeps loading async content (Autopilot, Team) for a beat
# after "Open project" appears; a click during that reflow can land on
# nothing. Wait for the page to settle before clicking Project settings.
abA wait --text "Team" >/dev/null
abA wait --load networkidle >/dev/null

# "Project settings" and "Members Roles & invites" are links; find-by-role
# misses sidebar/nav links (see FINDINGS-2026-09-08.md), so pull the ref
# out of the snapshot and click it directly. The first click sometimes
# doesn't register (same reflow issue), so retry up to 3 times. After a
# click the settings page can take a few seconds to list its links, and
# the "Project settings" link is gone by then, so poll for the panel
# before deciding the click was lost.
opened=""
i=0
while [ -z "$opened" ] && [ "$i" -lt 3 ]; do
  snap=$(abA snapshot -i -c)
  if printf '%s' "$snap" | grep -q 'Members Roles & invites'; then opened=1; break; fi
  ref=$(printf '%s' "$snap" | grep -o 'link "Project settings" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
  if [ -n "$ref" ]; then abA click "@$ref" >/dev/null || fail "click Project settings"; fi
  j=0
  while [ -z "$opened" ] && [ "$j" -lt 6 ]; do
    sleep 1
    [ "$(abA snapshot -i -c | grep -c 'Members Roles & invites')" -ge 1 ] && opened=1
    j=$((j+1))
  done
  i=$((i+1))
done
[ -n "$opened" ] || fail "settings panel"
ref=$(abA snapshot -i -c | grep -o 'link "Members Roles & invites" \[ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$ref" ] || fail "Members Roles & invites link not in snapshot"
abA click "@$ref" >/dev/null || fail "click Members Roles & invites"
abA wait --load networkidle >/dev/null
[ "$(abA snapshot -i -c | grep -c 'Add a member')" -ge 1 ] || fail "members page"
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
abA wait --load networkidle >/dev/null
[ "$(abA snapshot -i -c | grep -c 'tab \"Invite link\"')" -ge 1 ] || fail "add-member dialog"
abA find role tab click --name "Invite link" >/dev/null || fail "Invite link tab"
abA wait --load networkidle >/dev/null
[ "$(abA snapshot -i -c | grep -c 'Create invite link')" -ge 1 ] || fail "invite link tab panel"
abA find role button click --name "Create invite link" >/dev/null || fail "Create invite link button"

url=""
i=0
while [ -z "$url" ] && [ "$i" -lt 15 ]; do
  url=$(abA get value "input[readonly]" 2>/dev/null)
  case "$url" in */join/*) ;; *) url="";; esac
  [ -n "$url" ] || sleep 1
  i=$((i+1))
done
[ -n "$url" ] || fail "no invite URL after create"
token=$(printf '%s' "$url" | sed -n 's#.*/join/##p')
[ -n "$token" ] || fail "no token parsed from $url"
abA press Escape >/dev/null

abB open "$BASE/join/$token" >/dev/null && abB wait --load networkidle >/dev/null
[ "$(count "You're invited" )" -ge 1 ] || fail "join page missing You're invited"
[ "$(count "$NAME")" -ge 1 ] || fail "join page missing project name"
[ "$(count "Invited by alice")" -ge 1 ] || fail "join page missing inviter"
abB find role button click --name "Accept invitation" >/dev/null || fail "Accept invitation button"
abB wait --load networkidle >/dev/null
burl=$(abB get url); case "$burl" in */project/*) ;; *) fail "bob url after accept: $burl";; esac

abB open "$BASE/orgs/all" >/dev/null && abB wait --load networkidle >/dev/null
rows=$(count "cell \"$NAME Shared New\"" "table")
[ "$rows" -ge 1 ] || rows=$(count "cell \"$NAME" "table")
[ "$rows" -ge 1 ] || fail "no shared row for $NAME on /orgs/all"
pass "row '$NAME' shared with bob on /orgs/all; bob project url $burl"
