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

### Follow-up native-browser verification

Native Safari Private was driven through the actual UI against the same local
synthetic stack. The collector received zero requests on the initially checked
privacy screen, after toggling the draft, after “Agree and continue” without
registration, and after logging into existing Alice. Alice's Preferences remained
OFF, proving the provisional signup choice did not grant that existing account
permission. Turning sharing ON in Preferences produced a real `$pageview` and
replay requests. The captured payloads contained neither the synthetic email nor
the synthetic password.

Adding Bob through the account dialog left Bob OFF. Navigation and reload with Bob
selected produced zero collector requests. Clicking Alice in the account menu
resumed approved page views. Turning Alice OFF then navigating and reloading again
produced zero collector requests. No projects or content were created or changed.
This also exercised pointer account switching, previously unverified in the final
automated run. Native Safari's WebDriver could not create a session; the visible
Private-window test used native UI control instead.

Native Firefox UI control timed out on three attempts, so no native Firefox
Private result is claimed. Automated Firefox engine coverage remains separate.

The automated privacy matrix was repeated twice per engine: 11 passed and one
Firefox run failed during direct session insertion because a document navigation
destroyed that helper's execution context, before any consent assertions. The
withdrawal case now uses the real login form. Both repetitions of that case then
passed in all three engines (six passes); all six repeated account-isolation
cases had already passed.

The full root regression rerun passed 25,896 tests, with three audio-export
assertion failures and one unhandled timer error during test-environment teardown.
The export assertions now check the exact returned blob, filename and operation
analytics argument. The consent timer now returns safely when browser globals
have been removed, with a regression test covering that teardown.

After those corrections, the combined export/analytics regression run passed all
876 tests in 70 files (two skipped), with no unhandled errors. Type checking and
changed-file lint passed. The entire root suite was not repeated after these
small corrections; its earlier failures and their targeted rerun are reported
separately rather than describing the full run as green.
The final complete privacy matrix then passed all six cases on the corrected
code, across Chromium, Firefox and WebKit.
