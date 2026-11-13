# Google login: explicit intent and first-party session handoff

AQU-1057 adds an optional Google button to the existing login and signup forms.
It does not load Google Identity Services, One Tap, remote logos/fonts, an iframe,
preconnect or DNS-prefetch. The capability request goes only to Aquilla. Pressing
the button creates a first-party transaction and then navigates the same tab to
Google. Hovering, focusing, loading the page or choosing analytics does not do so.
Google can observe the OAuth visit after that deliberate action, including when
someone cancels. Google login is not analytics consent or a GDPR certification.

## Security and identity

The browser stores a random verifier in tab-local sessionStorage before starting;
unavailable storage fails without leaving Aquilla. The worker stores its SHA-256
challenge, a hashed state, nonce and a separate Google PKCE verifier. An exact
origin allowlist controls the return destination. No arbitrary callback URL is
accepted from the client. State is atomically consumed before provider exchange.

Google's ID token is verified with jose using pinned Google JWKS, RS256, issuer,
audience, expiration, issued-at, nonce, subject and verified-email claims. Only
openid/email scopes are requested. No access/refresh token, profile picture or
name is retained. Identity is keyed by Google's immutable subject, never email.
A third-party email's verified claim alone does not mark the Aquilla address
verified: only Gmail/Workspace authoritative claims do that. Other addresses
receive the ordinary Aquilla verification link in their welcome email.

A fresh one-use code returns in a fragment, which is removed before application
initialization. Redeeming it also requires the initiating tab's verifier. A new
account chooses its permanent username and passes the existing legacy identity
reservation check. Existing unlinked accounts require their Aquilla password;
a matching email does not silently add a login method. Linked accounts use the
normal JWT mint, session store, refresh and logout path. No JWT appears in a URL.
Creation/linking and continuation consumption are atomic Postgres statements.
Expired transaction data is pruned by the existing five-minute maintenance job.

Optional analytics remains independently gated. An existing account uses only
its saved choice. A new account can bind an explicit signup choice from the same
attempt; the initially checked toggle is never sufficient by itself.

## Configuration and rollout

The button remains visible, but login is enabled only when all four worker variables are configured:

- GOOGLE_LOGIN_CLIENT_ID: web OAuth client ID, dedicated to sign-in.
- GOOGLE_LOGIN_CLIENT_SECRET: worker secret, never a VITE variable or committed.
- GOOGLE_LOGIN_REDIRECT_URI: exact registered worker callback URI.
- GOOGLE_LOGIN_APP_ORIGINS: comma-separated exact SPA origins, no wildcards.

Register the appropriate callback in Google Cloud:

- production: https://api.aquilla.app/identity/api/v2/auth/oauth/google/callback
- development: https://api.dev.aquilla.app/identity/api/v2/auth/oauth/google/callback
- local: the local identity-worker origin followed by /api/v2/auth/oauth/google/callback

CI previews intentionally disable Google login and show that environment-specific reason. They use the same Aquilla dev access list and password login; do not register new preview callbacks.
Do not reuse Google Drive scopes, wildcard preview origins or expose a secret in
browser configuration. Apply migration 0199 before deploying the worker/client.
Configure Google branding/consent-screen publication and test users as appropriate.
Real-provider validation is still required; simulated signed responses prove the
app's handling, not Google Cloud configuration or live account eligibility.

Legal/disclosure review remains separate: explain the identity/email exchange,
provider recipients and retention in the privacy policy. This implementation
makes no claim of overall GDPR compliance. Existing operational logs/RUM are not
changed by this feature. No production configuration or deployment is implied.

Development uses the dedicated `aquilla-login-development` Google Cloud project.
The public development client configuration is in `auth-worker/wrangler.toml`;
the secret is stored on `aquilla-dev-identity`, not in the repository. These
settings take effect on the normal development deployment, not merely on push.
PR #1838 historically used independent preview bindings for provider testing. Current CI previews keep Google disabled.

Production uses the separate `Aquilla Production Login` client in the same business-owned Google Cloud project. Its public client ID, exact production callback, and SPA origin are in the production Wrangler configuration. The deployment manifest requires both `GOOGLE_LOGIN_CLIENT_SECRET` and `ADMIN_TOTP_KEY` on dev and production so a release cannot silently omit them. A staged Cloudflare secret version is not live configuration: promote only through the verified release process after database migrations and provider configuration are ready. Google branding/publication and the live signup/linking/authenticator walkthrough remain release prerequisites; committing these settings is not evidence that those checks passed.

## Live-provider verification (2026-11-05)

The configured PR preview was exercised in native Safari Private with a real
Google test account: account creation, session persistence after reload, logout,
and a second Google login all succeeded. The new account chose not to share
analytics; Preferences showed sharing off. Returning login went directly to the
requested organizations page without repeating signup.

Chromium network captures recorded zero Google requests on login (including
hover/focus), on signup after declining sharing, and after approving sharing
before authentication. Google traffic began only after the explicit Google
button action. The logo and font were served from the preview origin; the login
document had no preconnect, DNS-prefetch, or iframe elements.

The first real callback exposed a runtime compatibility bug: Workers rejects
`redirect: "error"` before sending the token request. A local workerd probe
confirmed it. Token exchange now uses `manual` and rejects non-2xx responses,
including redirects, so credentials are never forwarded to a redirect target.
Worker tests cover redirect rejection and credential-free diagnostics. The
temporary development diagnostic response used to isolate this failure was
removed before the successful live test.

## Verification recorded during implementation

- Worker integration tests use real signed OIDC tokens and Postgres semantics,
  including forged signatures, wrong claims, state/code replay, tab proof,
  expiry, concurrent creation, legacy reservations, password linking and normal
  session renewal/logout. A migration test preserves existing password hashes.
- Browser-boundary simulation passed in Chromium, Firefox and WebKit (6 tests):
  zero Google requests before activation, same-tab return, destination preservation,
  ordinary session persistence and cancellation. Google responses are simulated;
  no live Google account or client configuration was used.
- Existing onboarding, login, account switching, inactive outbox and offline
  recovery journeys passed (11 tests).
- Client tests cover explicit consent in both directions, default-on draft only,
  and refusing to transfer a signup choice to an existing account.
- The local login UI was inspected with a simulated first-party capability response.
  It is a visual preview, not a configured Google environment.

## Integration refresh (2026-11-10)

Merged current dev, retaining its dependency upgrades and development access
policy. Google exchange and completion enforce the same dev-only access list
before issuing sessions, linking identities, or creating accounts. A changed
allowlist is checked again at completion; missing/unavailable access storage
fails closed. Previews, local development and production keep their existing
policy. The client displays the existing translated dev-access refusal.

Migration 0194 conflicted with a newer base migration. Read-only dev status
confirmed the Google migration and tables were absent, so it was renumbered to
0199 and applied to shared dev; schema and ledger matched afterwards. Existing
Google test accounts from the previous preview are not assumed to survive a
shared-dev database refresh. Production was not migrated or configured.

## Managing login methods

Preferences → Account → Login methods reads connection status from the first-party
`GET /auth/oauth/google/methods` endpoint for the active authenticated account.
It never queries Google for status. Google-only users are directed to the existing
email password-reset flow; disconnect stays unavailable until a password exists.
The server independently requires a valid Aquilla password before disconnecting.

Connecting explicitly starts the same minimal-scope Google redirect, with an
account-management marker (username, never a JWT or password) in tab-local state.
The return page requires the same active account and its Aquilla password. Its
`POST /connect` consumes a verified, single-use Google handoff only if the Google
email matches the current account, without creating an account, adopting a new
session or altering analytics consent. A provider identity already owned by
another account is never transferred. Account switches require restarting.

`POST /disconnect` removes only the authenticated account's Google identity,
compares the freshly verified password hash in the delete, and cannot remove a
Google-only account's last login method. Status and disconnect remain available
if Google configuration is disabled. Management attempts are rate limited.
Disconnect does not revoke Google-side permissions or sign out existing Aquilla
sessions; users can log out separately. No Google tokens are stored or revoked.


## Audit recovery safeguards (AQU-2531–2533)

The first-party capability check and start endpoint verify the target database
before provider navigation: password hashes must be nullable and the Google
flow/identity tables and identity constraints must exist. A configured but
incompatible database returns 503, with a first-party retry on the login page.
This is read-only and never repairs or applies migrations automatically. After
applying migration 0199 and deploying identity, verify the configured preview's
`/api/v2/auth/oauth/google/config` returns 200 with `enabled: true` before the
live-provider walkthrough. A green SPA build alone is insufficient evidence.

If account creation/linking committed but session issuance failed, the response
is `session_failed` (503), not `signup_failed`. The UI removes the consumed form
and asks for a fresh, user-initiated Google login, which finds the existing link.
An uncertain network result also requires a fresh login rather than replaying a
consumed handoff. No background retry navigates to Google.

Consent writes retry up to three unrelated preference races while preserving
any newer consent revision. This addresses a reproducible race, not proof of the
cause of every historical warning screenshot. Optional analytics remains off
when approval cannot be saved. Welcome-email verification uses a task-owned
database connection. Settings password-reset emails carry the exact allowlisted
`/preferences/login-methods` destination through reset and subsequent login.

AQU-2530 and AQU-2534 bind sessions and browser data to immutable account IDs.
Merge those dependency PRs first; never merge this PR around an open parent.
