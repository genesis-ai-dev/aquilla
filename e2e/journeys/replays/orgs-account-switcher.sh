#!/usr/bin/env sh
# Replay of orgs-account-switcher.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"

# Pull a ref out of the snapshot for a control `find` misses. Usage:
# ref_for 'link "Workspace'   (a leading-substring match is enough)
ref_for() {
  line=$(ab snapshot -i -c | grep -F -m1 "$1")
  printf '%s\n' "$line" | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p'
}

login alice || fail "login"
url=$(ab get url)
case "$url" in
  */login*) ab wait --load networkidle >/dev/null; url=$(ab get url) ;;
esac
start_url="$url"

# "Account menu: alice" (with the colon) is not found by `find`; the
# substring "Account menu" is.
ab find role button click --name "Account menu" >/dev/null || fail "Account menu button"
[ "$(count 'menuitem "Preferences"')" -ge 1 ] || fail "Preferences menuitem not in opened menu"
[ "$(count 'menuitem "Add another account"')" -ge 1 ] || fail "Add another account menuitem missing"

ab find role menuitem click --name "Preferences" >/dev/null || fail "Preferences menuitem click"
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */preferences) ;; *) fail "url after Preferences click: $url";; esac
[ "$(count 'heading "Preferences"')" -ge 1 ] || fail "no Preferences heading"

ref=$(ref_for 'link "Workspace')
[ -n "$ref" ] || fail "Workspace link not in snapshot"
ab click "@$ref" >/dev/null || fail "click Workspace"
ab wait --load networkidle >/dev/null
url=$(ab get url); case "$url" in */preferences/workspace) ;; *) fail "url after Workspace click: $url";; esac
[ "$(count 'heading "Workspace"')" -ge 1 ] || fail "no Workspace heading"

ab find role button click --name "Close" >/dev/null || fail "Close button"
ab wait --load networkidle >/dev/null
end_url=$(ab get url)
[ "$end_url" = "$start_url" ] || fail "did not return to $start_url, got $end_url"

pass "account menu opened, Preferences -> Workspace -> Close, back at $end_url"
