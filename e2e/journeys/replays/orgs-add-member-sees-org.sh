#!/usr/bin/env sh
# Replay of orgs-add-member-sees-org.md, the path found on the 2026-09-08 cold run.
# alice creates a fresh org (she is Owner there, so "Add a member" renders),
# adds bob as Contributor, and bob's org switcher lists the org. Dev Org is
# not usable for this: "Add a member" is Owner-only and bob already has a
# Guest entry for Dev Org. Each run creates its own org, so no prior state.
. "$(dirname "$0")/_lib.sh"
abA() { agent-browser --session "$S-alice" "$@"; }
abB() { agent-browser --session "$S-bob" "$@"; }
pass() { echo "PASS: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 0; }
fail() { echo "FAIL: $*"; abA close >/dev/null 2>&1; abB close >/dev/null 2>&1; exit 1; }
# _lib.sh's count() uses the bare session; these count in alice's / bob's.
countA() { abA snapshot -i -c -s "$2" | grep -c -- "$1"; }
countB() { abB snapshot -i -c -s "$2" | grep -c -- "$1"; }

ORGNAME="Journey org $(date +%H%M%S)"

# bob first, so the switcher check can be tried live before any reload.
abB open "$BASE/__dev/login?as=bob" >/dev/null || fail "bob login"
abB wait --load networkidle >/dev/null
# `open` waits for the load event, which a hung request on the busy shared
# stack can block; the switcher rendering is what matters, so wait for that.
abB open "$BASE/" >/dev/null 2>&1
abB wait '[data-tour="org-switcher"]' >/dev/null || fail "bob home: switcher never rendered"

abA open "$BASE/__dev/login?as=alice" >/dev/null || fail "alice login"
abA wait --load networkidle >/dev/null
abA open "$BASE/orgs/9/overview" >/dev/null 2>&1
abA wait '[data-tour="org-switcher"]' >/dev/null || fail "org switcher never rendered for alice"
abA find role combobox click --name "Organization switcher" >/dev/null || fail "org switcher"
abA find role button click --name "Create" >/dev/null || fail "Create button in switcher"
abA wait --text "Create organization" >/dev/null || fail "create org dialog"
abA find label "Organization name" fill "$ORGNAME" >/dev/null || fail "org name field"
abA find role button click --name "Create organization" >/dev/null || fail "Create organization submit"
abA wait --load networkidle >/dev/null
url=$(abA get url); case "$url" in */orgs/*) ;; *) fail "url after org create: $url";; esac
orgid=$(printf '%s' "$url" | sed -n 's#.*/orgs/\([0-9]*\)/.*#\1#p')
[ -n "$orgid" ] || fail "could not parse org id from $url"

# The Members nav link is missed by `find role link`; navigate directly.
abA open "$BASE/orgs/$orgid/members" >/dev/null || fail "Members page"
abA wait --load networkidle >/dev/null
abA find role button click --name "Add a member" >/dev/null || fail "Add a member button"
abA wait --text "Add a member" >/dev/null || fail "add member dialog"
abA find placeholder "Aquilla username" fill "bob" >/dev/null || fail "username field"
abA find role combobox click --name "Role" >/dev/null || fail "Role combobox"
ref=$(abA snapshot -i -c -s '[role="listbox"]' | grep -o 'option "Contributor [^]]*ref=e[0-9]*' | grep -o 'e[0-9]*$' | head -1)
[ -n "$ref" ] || fail "no Contributor option in Role listbox"
abA click "@$ref" >/dev/null || fail "pick Contributor"
abA find role button click --name "Add" --exact >/dev/null || fail "Add submit button"
# "Copy bob@local.test" is only an accessible name, so wait --text cannot see
# it; poll the Roster table snapshot for bob's name cell instead.
i=0; rows=0
while [ "$i" -lt 15 ]; do
  rows=$(countA 'cell "Project access for bob bob"' 'table')
  [ "$rows" -ge 1 ] && break
  abA wait 1000 >/dev/null; i=$((i+1))
done
[ "$rows" -ge 1 ] || fail "no roster row for bob after Add"
[ "$(countA 'cell "Contributor"' 'table')" -ge 1 ] || fail "no Contributor role cell in Roster table"

# bob: live check first (no reload), then one reload as fallback.
how="live"
abB wait '[data-tour="org-switcher"]' >/dev/null || fail "org switcher never rendered for bob"
abB find role combobox click --name "Organization switcher" >/dev/null || fail "bob org switcher"
opt=$(countB "option \"[A-Z0-9]* $ORGNAME Contributor\"" '[role="listbox"]')
if [ "$opt" -lt 1 ]; then
  abB press Escape >/dev/null 2>&1
  abB wait 2000 >/dev/null
  abB find role combobox click --name "Organization switcher" >/dev/null || fail "bob org switcher (retry)"
  opt=$(countB "option \"[A-Z0-9]* $ORGNAME Contributor\"" '[role="listbox"]')
  how="live after 2s"
fi
if [ "$opt" -lt 1 ]; then
  abB press Escape >/dev/null 2>&1
  abB open "$BASE/" >/dev/null && abB wait --load networkidle >/dev/null
  abB find role combobox click --name "Organization switcher" >/dev/null || fail "bob org switcher (after reload)"
  opt=$(countB "option \"[A-Z0-9]* $ORGNAME Contributor\"" '[role="listbox"]')
  how="after reload"
fi
[ "$opt" -ge 1 ] || fail "'$ORGNAME Contributor' not an option in bob's switcher listbox, even after reload"

pass "alice created org $orgid '$ORGNAME' and added bob as Contributor; bob's switcher lists it ($how)"
