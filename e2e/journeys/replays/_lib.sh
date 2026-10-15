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
#
# A story that walks the site-wide admin console uses `login_admin` and
# `elevate_admin` instead — platform admin is an email allowlist, not a role the
# ordinary QA account can reach. See those functions below.
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
# AQU-1353: sign in as the PLATFORM admin, for the stories that walk /admin.
# Platform admin is an allowlist of account emails (ADMIN_EMAILS), a separate
# axis from the org role ladder, so it is a different account from the one
# `login` reaches — not a role you can switch into.
#   local stack  the seeded `dev` user, which scripts/dev-stack.ts puts on
#                ADMIN_EMAILS; elevation is off there under WRANGLER_LOCAL=1.
#   a preview    the `qa-admin` fixture on development storage, named by the
#                preview's own one-entry allowlist (scripts/cloudflare-stack-
#                preview.mjs). Set AQUILLA_QA_ADMIN_USER / _PASSWORD. Elevation
#                IS on there — see the story for the devCode step.
# Returns 2, not 1, when the target needs admin credentials and none were
# given: that is a harness gap to report as such, never a finding against the app.
login_admin() {
  if [ -n "${AQUILLA_QA_ADMIN_PASSWORD:-}" ]; then
    AQUILLA_QA_USER="${AQUILLA_QA_ADMIN_USER:-qa-admin}"
    AQUILLA_QA_PASSWORD="$AQUILLA_QA_ADMIN_PASSWORD"
    export AQUILLA_QA_USER AQUILLA_QA_PASSWORD
    login "$AQUILLA_QA_USER"
  elif [ -n "${AQUILLA_QA_PASSWORD:-}" ]; then
    return 2
  else
    login "${AQUILLA_ADMIN_USER:-dev}"
  fi
}
# Pass the admin step-up gate if it is showing, and report what it did.
# "Admin verification required" means elevation is on (a preview; or any deploy
# with ADMIN_REQUIRE_ELEVATION=true and no WRANGLER_LOCAL). The code is emailed
# in production, but a target with no mail binding hands it back in the request
# response and the gate prints it as "Dev mode — your code is NNNNNN", so a bot
# can finish the real flow. Echoes "elevated", "open" (no gate), or "stuck".
elevate_admin() {
  if [ "$(count 'Admin verification required')" -eq 0 ]; then echo open; return 0; fi
  ab click 'button:has-text("Email me a code")' >/dev/null 2>&1 || {
    r=$(ab eval 'const el=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Email me a code"); el ? (el.click(), "clicked") : "missing"')
    case "$r" in *clicked*) ;; *) echo stuck; return 1;; esac
  }
  ab wait --text "your code is" >/dev/null 2>&1 || { echo stuck; return 1; }
  code=$(ab get text "main" | grep -o 'your code is [0-9][0-9]*' | grep -o '[0-9][0-9]*$' | head -1)
  [ -n "$code" ] || { echo stuck; return 1; }
  # The OTP field completes on the sixth digit and verifies itself; type into
  # the first slot by ref, since typing at "current focus" is lost.
  ab eval 'const i=document.querySelector("input[autocomplete=\"one-time-code\"]"); i && i.focus()' >/dev/null 2>&1
  ab type "$code" >/dev/null 2>&1 || { echo stuck; return 1; }
  ab wait --load networkidle >/dev/null
  if [ "$(count 'Admin verification required')" -gt 0 ]; then echo stuck; return 1; fi
  echo elevated
}
fail() { echo "FAIL: $*"; ab close >/dev/null 2>&1; exit 1; }
pass() { echo "PASS: $*"; ab close >/dev/null 2>&1; exit 0; }
# Count snapshot lines matching a pattern (scoped to a CSS selector when given).
count() { if [ -n "${2:-}" ]; then ab snapshot -i -c -s "$2" | grep -c -- "$1"; else ab snapshot -i -c | grep -c -- "$1"; fi; }
