# Shared helpers for replay scripts. Source this first.
#
# Every replay: `. "$(dirname "$0")/_lib.sh"` then use `ab` for agent-browser
# with the session this run was given, `login <user>` to land in the app,
# and `fail "<why>"` / `pass "<evidence>"` to end.
BASE="${AQUILLA_BASE:-http://127.0.0.1:5173}"
S="${AGENT_BROWSER_SESSION:-replay-$$}"
ab() { agent-browser --session "$S" "$@"; }
# One retry: the first open after a session was just closed sometimes fails
# within a second or two (seen as "FAIL: login" in streaks.tsv).
login() {
  ab open "$BASE/__dev/login?as=${1:-alice}" >/dev/null || { sleep 2; ab open "$BASE/__dev/login?as=${1:-alice}" >/dev/null || return 1; }
  ab wait --load networkidle >/dev/null
}
fail() { echo "FAIL: $*"; ab close >/dev/null 2>&1; exit 1; }
pass() { echo "PASS: $*"; ab close >/dev/null 2>&1; exit 0; }
# Count snapshot lines matching a pattern (scoped to a CSS selector when given).
count() { if [ -n "${2:-}" ]; then ab snapshot -i -c -s "$2" | grep -c -- "$1"; else ab snapshot -i -c | grep -c -- "$1"; fi; }
