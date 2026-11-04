# Optional analytics consent and account ownership

AQU-2381 and AQU-2242 are one release dependency: do not ship either half without
verifying the combined client and identity worker. Google login is out of scope.

## Permission and migration

The signup switch is initially checked. This is a draft, not permission.
“Agree and continue” records a provisional choice; “Continue without sharing”
records refusal. Successful registration binds that choice only to its returned
JWT. A normal login clears the draft and uses that account's server decision.

`GET/PUT /api/v2/auth/me/analytics-consent` uses the authenticated immutable user
ID, never a caller-supplied account ID. Writes carry the disclosure version and
expected revision. The worker stamps the time/revision and rejects conflicts.
Generic preference endpoints cannot forge or delete this reserved preference.

Only an authenticated, hydrated, displayed, approved account can collect.
Unknown, expired, offline, hidden, transitioning, or failed hydration means off.
Legacy browser-wide true does not grant approval. Legacy false suppresses every
account until that account explicitly confirms; approving A never overrides B.
A failed refusal remains suppressed locally. There is no persistent yes cache.

Visible, online sessions revalidate every minute; permission expires after 75
seconds without verification. Same-browser notifications and visibility changes
invalidate earlier. Cross-device revocation is therefore bounded, not instant.

## SDK and producers

No SDK import, configuration contact, identity or optional queue is created
before eligibility. Each account generation uses a new SDK instance, an
origin/account hash, memory-only storage and a separate recording session.
Old callbacks, replay buffers, event queues, retries and unload sends cannot
borrow a later generation's permission. Requests already sent cannot be recalled.

React producers use `useAccountAnalytics`; asynchronous non-React operations
capture `posthog.scope()` before work begins, supplying the operation owner when
available. Pass that same lease through later helpers. Do not capture a new lease
at completion. Inactive-account outbox uploads still run but do not emit analytics.
Unowned download telemetry is dropped unless its caller supplies a lease.

Global exception auto-capture, console recording and performance/network history
are disabled: they cannot reliably distinguish inactive-account work. Explicit
owned errors remain eligible. Replay inputs/cell text stay masked; credential URL
redaction and EU host resolution remain. Remote network/body/header recording
cannot override explicit client refusal to capture those fields.

The locked SDK's rate-limiter dispatch seam guards sends as well as capture;
upgrade it only with the real-SDK retry/unload and browser network tests passing.
Teardown uses discard-before-shutdown because SDK shutdown ordinarily flushes.

## Verification and rollout

- Controller tests exercise legacy migration, delayed responses, refusal failure,
  lease expiry, visibility/offline and denied storage.
- Worker tests exercise two-account authorization, revision conflicts and generic
  preference endpoint protection.
- React account integration checks the displayed DOM identity before eligibility.
- Real-SDK tests check pre-approval traffic, retries and unload after withdrawal.
- `e2e/privacy/README.md` describes the isolated network/replay suite and positive
  controls; the ordinary onboarding smoke checks real signup and Back/login flows.

Deploy the identity endpoint before or with the complete client. A missing endpoint
fails closed. Rollback must disable optional analytics, not restore the old
browser-wide default-on collector. Preview verification is required before release.

Necessary authentication/security/operational traffic and Cloudflare RUM are
separate paths, unchanged here. These tests do not establish overall GDPR
compliance, provider retention/deletion, contracts, lawful bases or disclosures.

## Local verification — 2026-11-04

- Production build, TypeScript, bundle/SPA checks and i18n validation passed.
- Changed-file lint passed with no errors (existing warnings remain).
- Full root unit run: 25,894 passed, one failed on an obsolete browser-wide
  approval expectation. After correcting that test and tightening the agent
  forwarding ownership check, all 582 tests in 64 affected files passed.
  The entire root suite was not rerun afterward.
- Auth-worker consent API integration passed against the locked dependencies.
- Two onboarding browser tests passed, including the checked draft, explicit
  approval, legacy refusal override, Back/login and denied storage behavior.
- All six privacy browser cases passed: two each in Chromium, Firefox and WebKit.
  The real SDK sent positive-control events and masked replay to a local collector;
  unapproved, inactive, withdrawn and offline event canaries were absent.
  Separate identities/recording sessions and cross-tab withdrawal were verified.
- Earlier combined runs hit unstable pointer interaction with the synthetic
  account menu. The final fixture seeds both accounts before approval and uses
  keyboard menu selection. Pointer switching was not reverified by this run.
- These are local automated browser engines, not native Safari or Firefox Private
  window verification. No deployed preview or production verification was run.

Test setup and collector are under `e2e/privacy`; no real user project or existing
content was edited. Preserve the combined-preview release gate described above.
