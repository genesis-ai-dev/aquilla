#!/usr/bin/env sh
# Replay of orgs-billing-cta.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"

login alice || fail "login"
ab open "$BASE/orgs/9/settings" >/dev/null && ab wait --load networkidle >/dev/null
[ "$(count 'heading "Organization settings"')" -ge 1 ] || fail "no Organization settings heading"

# Sidebar links miss find-by-role; click by href instead.
ab click 'a[href$="/settings/billing"]' >/dev/null 2>&1 || {
  # Fall back to a DOM click on the element whose text is the link label.
  r=$(ab eval 'const el=[...document.querySelectorAll("a,button")].find(e=>e.textContent.trim()==="Billing & usage"); el ? (el.click(), "clicked") : "missing"')
  case "$r" in *clicked*) ;; *) fail "Billing & usage link ($r)";; esac
}
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */orgs/9/settings/billing) ;; *) fail "url after Billing & usage click: $url";; esac
[ "$(count 'heading "Billing & usage"')" -ge 1 ] || fail "no Billing & usage heading"

plan=$(ab get count '[data-testid="billing-plan"]')
[ "$plan" -ge 1 ] || fail "billing-plan panel not present"
usage=$(ab get count '[data-testid="billing-usage"]')
[ "$usage" -ge 1 ] || fail "billing-usage panel not present"
# The CTA is plain text, so an interactive snapshot never lists it; read the page text (case-insensitive, as the smoke spec does).
ab get text "main" | grep -qi "field plan" || fail "Field Plan text not present"

pass "Billing & usage shows plan panel, usage panel, and Field Plan CTA"
