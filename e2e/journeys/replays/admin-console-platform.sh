#!/usr/bin/env sh
# Replay of admin-console-platform.md (AQU-1353).
#
# Not yet calibrated: a story earns trust only after five green runs in a row on
# a build known to be good (streak.sh). Until then a red here means this script
# or the fixture is wrong, not the app — cold-walk the story before reporting.
. "$(dirname "$0")/_lib.sh"

login_admin
case $? in
  0) ;;
  2) fail "no platform-admin fixture for this target — set AQUILLA_QA_ADMIN_USER and AQUILLA_QA_ADMIN_PASSWORD (harness gap, not an app finding)";;
  *) fail "login as the platform-admin fixture";;
esac

ab open "$BASE/admin" >/dev/null && ab wait --load networkidle >/dev/null

# The step-up gate, when this target has elevation on. Report "open" or
# "elevated" in the evidence so a reviewer can see which path ran.
gate=$(elevate_admin) || fail "admin step-up gate: $gate"

# A non-admin is redirected away, so the URL alone separates "no fixture" from
# "console broken". Check it before looking for anything on the page.
url=$(ab get url)
case "$url" in
  */admin) ;;
  *) fail "redirected off /admin to $url — the account is not on this target's ADMIN_EMAILS";;
esac

[ "$(count 'heading "Admin console"')" -ge 1 ] || fail "no Admin console heading"

for t in Overview Retention Migration Tenants Teams People Projects Activity Platform; do
  [ "$(count "\"$t\"" 'main')" -ge 1 ] || fail "tab strip is missing $t"
done

# Sidebar links miss find-by-role (see README harness notes); click by href.
[ "$(ab get count 'a[href$="/admin"]')" -ge 1 ] || fail "no Admin link in the sidebar"

ab click 'button[role="tab"]:has-text("Platform")' >/dev/null 2>&1 || {
  r=$(ab eval 'const el=[...document.querySelectorAll("[role=\"tab\"]")].find(e=>e.textContent.trim()==="Platform"); el ? (el.click(), "clicked") : "missing"')
  case "$r" in *clicked*) ;; *) fail "Platform tab ($r)";; esac
}
ab wait --load networkidle >/dev/null

for t in "AI settings" "AI credits" Billing; do
  [ "$(count "\"$t\"" 'main')" -ge 1 ] || fail "Platform tab is missing the $t sub-tab"
done

# An admin fetch that 403s renders an error line instead of a section, so an
# empty-but-green tab is not a pass.
ab get text "main" | grep -qi "elevation required" && fail "a section reported elevation required after the gate"

pass "admin console reached (gate: $gate) with all nine tabs; Platform shows AI settings, AI credits, Billing"
