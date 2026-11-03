#!/usr/bin/env sh
# Replay of orgs-billing-cta.md, the path found on the 2026-09-08 cold run.
#
# Refreshed 2026-11-02: AQU-2059 (2026-10-21) replaced the Field Plan with
# Free / Team / Enterprise, so the page no longer says "Field Plan" anywhere
# and the old `grep "field plan"` failed on every PR from #1538 on. What a
# person sees now: the Current plan badge, the AI usage panel and, unless the
# workspace is on the paid Team plan, the Compare new plans group with the
# Team row (or the prices-unavailable notice) and the Enterprise row's
# Discuss your rollout link.
. "$(dirname "$0")/_lib.sh"

login alice || fail "login"
ab open "$BASE/orgs/$ORG/settings" >/dev/null && ab wait --load networkidle >/dev/null
[ "$(count 'heading "Organization settings"')" -ge 1 ] || fail "no Organization settings heading"

# Sidebar links miss find-by-role; click by href instead.
ab click 'a[href$="/settings/billing"]' >/dev/null 2>&1 || {
  # Fall back to a DOM click on the element whose text is the link label.
  r=$(ab eval 'const el=[...document.querySelectorAll("a,button")].find(e=>e.textContent.trim().startsWith("Billing")); el ? (el.click(), "clicked") : "missing"')
  case "$r" in *clicked*) ;; *) fail "Billing link ($r)";; esac
}
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */orgs/$ORG/settings/billing) ;; *) fail "url after Billing click: $url";; esac
[ "$(count 'heading "Billing"')" -ge 1 ] || fail "no Billing heading"

[ "$(ab get count '[data-testid="billing-plan"]')" -ge 1 ] || fail "billing-plan badge not present"
[ "$(ab get count '[data-testid="billing-usage"]')" -ge 1 ] || fail "billing-usage panel not present"
badge=$(ab get text '[data-testid="billing-plan"]' | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
case "$badge" in
  Free|Team|Enterprise) ;;
  *) fail "Current plan badge reads '$badge' (expected Free, Team or Enterprise)";;
esac

# The paid Team plan hides the offers; Free and Enterprise show them.
if [ "$badge" = "Team" ]; then
  pass "Billing shows the Team badge and the usage panel (a paid plan shows no offers)"
fi
# The offers are plain text and a link, so read the page text (as the old
# Field Plan check did) rather than the interactive snapshot.
text=$(ab get text "main")
printf '%s' "$text" | grep -q "Compare new plans" || fail "Compare new plans group not present"
printf '%s' "$text" | grep -q "Discuss your rollout" || fail "Discuss your rollout link not present"
# The Team row needs Stripe prices; a target without them says so instead.
if printf '%s' "$text" | grep -q "Review Team"; then
  offers="Team row"
else
  printf '%s' "$text" | grep -q "Plan prices are temporarily unavailable" || fail "neither the Team row nor the prices-unavailable notice is present"
  offers="prices-unavailable notice"
fi

pass "Billing shows the $badge badge, the usage panel, Compare new plans ($offers) and the Discuss your rollout link"
