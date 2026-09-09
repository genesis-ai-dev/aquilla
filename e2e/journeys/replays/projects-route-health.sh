#!/usr/bin/env sh
# Replay of projects-route-health.md, the path found on the 2026-09-08 cold run.
. "$(dirname "$0")/_lib.sh"
login alice || fail "login"

# The seeded dev project has a stable slug id, so the replay survives a reset.
PID="dev-project"

check_route() {
  route="$1"
  ab open "$BASE$route" >/dev/null || fail "open $route"
  ab wait --load networkidle >/dev/null
  out=$(cat <<'EOF' | ab eval --stdin
document.body.innerText.includes("Something went wrong")
  ? "CRASH"
  : (document.querySelector("vite-error-overlay") ? "OVERLAY" : "OK")
EOF
)
  case "$out" in
    *OK*) ;;
    *) fail "route $route: $out" ;;
  esac
}

count=0
for route in \
  "/" "/projects" "/orgs/9/archived" "/orgs/9/assigned" "/orgs/9/teams" \
  "/orgs/9/members" "/orgs/9/settings" "/preferences" \
  "/project/$PID/editor" "/project/$PID/settings" "/project/$PID/settings/members" \
  "/project/$PID/settings/rules" "/project/$PID/settings/memory" "/project/$PID/rules" \
  "/project/$PID/terminology" "/project/$PID/comments" "/project/$PID/memory" \
  "/project/$PID/memory/instructions" "/project/$PID/memory/quality" "/project/$PID/voice"
do
  check_route "$route"
  count=$((count + 1))
done

pass "$count routes clean, no crash boundary or vite-error-overlay"
