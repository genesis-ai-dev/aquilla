#!/usr/bin/env sh
# Replay of projects-onboarding-wizard.md, the path found on the 2026-09-08
# cold run. This story does not call login(); it registers a fresh account.
. "$(dirname "$0")/_lib.sh"
TS=$(date +%H%M%S)
USER="wizard$TS"
PROJNAME="Journey onboarding $TS"

ab open "$BASE/onboarding" >/dev/null || fail "open /onboarding"
ab wait --load networkidle >/dev/null
ab find role button click --name "Get Started" >/dev/null || fail "Get Started button"
ab wait --text "Help us improve" >/dev/null || fail "privacy step"
ab find role button click --name "Continue" >/dev/null || fail "privacy Continue button"
ab wait --text "Create your Frontier account" >/dev/null || fail "account step"

ab find label "Username" fill "$USER" >/dev/null || fail "username field"
ab find label "Email" fill "$USER@example.test" >/dev/null || fail "email field"
ab find label "Password" fill "wizard-pw-12345" >/dev/null || fail "password field"
ab find role button click --name "Create account" >/dev/null || fail "Create account button"
ab wait --text "What should we call you?" >/dev/null || fail "registration did not advance to display-name step"

ab find label "Display name" fill "Wizard Translator" >/dev/null || fail "display name field"
ab find role button click --name "Continue" >/dev/null || fail "display-name Continue button"
ab wait --text "How will you use Aquilla?" >/dev/null || fail "usage step"
ab find role button click --name "Just me" >/dev/null || fail "Just me button"
ab wait --text "Create your first project" >/dev/null || fail "project step"

ab find label "Project Name" fill "$PROJNAME" >/dev/null || fail "project name field"
ab find label "Source Language" fill "English" >/dev/null || fail "source language field"
ab find label "Target language" fill "French" >/dev/null || fail "target language field"
ab find role button click --name "Create Project" >/dev/null || fail "Create Project button"
ab wait --text "You're all set" >/dev/null || fail "ready step did not appear"

ab find role button click --name "Start Translating" >/dev/null || fail "Start Translating button"
ab wait --load networkidle >/dev/null
url=$(ab get url)
case "$url" in
  */editor|*/editor/*|*/editor\?*) ;;
  *) fail "url after Start Translating: $url" ;;
esac

pass "signed up as $USER, project '$PROJNAME' created, landed on $url"
