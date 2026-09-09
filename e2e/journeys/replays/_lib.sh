# Shared helpers for replay scripts. Source this first.
#
# Every replay: `. "$(dirname "$0")/_lib.sh"` then use `ab` for agent-browser
# with the session this run was given, `login <user>` to land in the app,
# and `fail "<why>"` / `pass "<evidence>"` to end.
#
# Target. AQUILLA_BASE picks the app under test:
#   unset                       the local stack, http://127.0.0.1:5173
#   https://<branch>-aquilla-web-preview.<account>.workers.dev
#                               a pull request's full-stack preview
# On the local stack `login` uses the dev login route, which only exists
# under WRANGLER_LOCAL. On a preview it signs in through the real form with
# AQUILLA_QA_USER / AQUILLA_QA_PASSWORD (a QA account on development
# storage, never a production account). Set AQUILLA_QA_PASSWORD to force the
# form even locally.
BASE="${AQUILLA_BASE:-http://127.0.0.1:5173}"
ORG="${AQUILLA_ORG_ID:-9}"
S="${AGENT_BROWSER_SESSION:-replay-$$}"
ab() { agent-browser --session "$S" "$@"; }
# One retry: the first open after a session was just closed sometimes fails
# within a second or two (seen as "FAIL: login" in streaks.tsv).
login() {
  user="${1:-alice}"
  if [ -n "${AQUILLA_QA_PASSWORD:-}" ]; then
    ab open "$BASE/login" >/dev/null || { sleep 2; ab open "$BASE/login" >/dev/null || return 1; }
    ab wait "#login-user" >/dev/null || return 1
    ab fill "#login-user" "${AQUILLA_QA_USER:-$user}" >/dev/null || return 1
    ab fill "#login-pass" "$AQUILLA_QA_PASSWORD" >/dev/null || return 1
    ab press Enter >/dev/null
    ab wait --load networkidle >/dev/null
    case "$(ab get url)" in *"/login"*) return 1;; esac
  else
    ab open "$BASE/__dev/login?as=$user" >/dev/null || { sleep 2; ab open "$BASE/__dev/login?as=$user" >/dev/null || return 1; }
    ab wait --load networkidle >/dev/null
  fi
}
fail() { echo "FAIL: $*"; ab close >/dev/null 2>&1; exit 1; }
pass() { echo "PASS: $*"; ab close >/dev/null 2>&1; exit 0; }
# Count snapshot lines matching a pattern (scoped to a CSS selector when given).
count() { if [ -n "${2:-}" ]; then ab snapshot -i -c -s "$2" | grep -c -- "$1"; else ab snapshot -i -c | grep -c -- "$1"; fi; }
