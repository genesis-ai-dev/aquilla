#!/usr/bin/env sh
# Replay of orgs-preferences-persist.md. Leaves the switch as it found it.
. "$(dirname "$0")/_lib.sh"
login alice || fail "login"
ab open "$BASE/preferences" >/dev/null && ab wait --load networkidle >/dev/null
state() { ab snapshot -i -c | grep -o 'switch "Share usage data" \[checked=[a-z]*' | grep -o 'checked=[a-z]*'; }
before=$(state); [ -n "$before" ] || fail "switch 'Share usage data' not found"
ab click '[role=switch]' >/dev/null || fail "click switch"
ab wait 300 >/dev/null
mid=$(state); [ "$mid" != "$before" ] || fail "switch did not flip ($before -> $mid)"
ab reload >/dev/null && ab wait --load networkidle >/dev/null
after=$(state); [ "$after" = "$mid" ] || fail "reload lost the change ($mid -> $after)"
ab click '[role=switch]' >/dev/null; ab wait 300 >/dev/null
restored=$(state); [ "$restored" = "$before" ] || fail "could not restore ($restored)"
pass "switch $before -> $mid, survived reload, restored to $restored"
