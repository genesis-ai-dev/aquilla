# Verified account email changes (AQU-957)

## Identity and storage

`users.email` in the identity Postgres database is the account's canonical email. It is not the only email-bearing record. Verification/reset tokens, pending social-login flows, invitations and email-based access grants also depend on addresses.

Google's link is `provider_identities(provider='google', subject, user_id)` in Postgres. Cloudflare holds the application-wide Google client secret, not a per-user account directory. Existing linked Google sign-in resolves the stable Google subject to the same user ID before consulting email. Changing the Aquilla email therefore does not disconnect that Google identity. If the user later disconnects Google, reconnecting through the existing linking flow still requires matching emails and Aquilla password proof.

Platform admin grants are keyed by email in `platform_admins`. The optional `ADMIN_EMAILS` environment setting is a separate bootstrap mechanism. The dev/preview allowlist is keyed by email in Cloudflare KV and managed through Aquilla's admin console; it survives refreshes of the development Postgres branch. Organization and project memberships remain attached to the unchanged user ID.

## Self-service contract

1. The selected account supplies its Aquilla password or a fresh PKCE-bound Google handoff whose subject is already linked to that account. No provider is contacted just by opening settings.
2. The destination must be unused and cannot inherit an existing platform-admin grant. On restricted deployments it must already be allowed by the dev access list, unless the existing database admin grant will move with the account. Bootstrap administrators require operator coordination instead of an automatic environment edit.
3. Database administrators must have an active admin elevation. The destination receives a random verification code. Only its hash is stored, bound to the old email and session generation, for 15 minutes. Failed delivery removes that request. The old address need not be reachable.
4. Confirmation requires an authenticated, freshly resolved session and the mailbox code. A single database statement compares the original email and session generation, changes the email, marks it verified, moves an existing database admin grant, increments session generation, invalidates old email/reset capabilities and elevations, and revokes API credentials. Google identity, username, user ID and memberships stay intact.
5. Log in again after success. Concurrent updates invalidate the proof; a replacement email request supersedes the previous code. The normal cross-isolate session-cache revocation window is up to 30 seconds. Email-change requests bypass that cache.

TOTP factors are keyed by user ID and remain enrolled. The authenticator app's displayed label may still contain the previous email; that label does not affect generated codes. Email-based outstanding invitations are not rewritten: correct/reissue those separately. Analytics choices are unchanged.

## Manual database edits

Do not simply edit `users.email` in the Neon console. Such an edit skips mailbox verification, token invalidation, session-generation changes and admin/dev-access coordination. It can leave stale email recovery capabilities or accidentally alter email-based privileges. Editing the Google client secret does not repair any of these records and would affect all Google users.

Use the verified application flow. An exceptional operator recovery needs a separately reviewed, audited transaction with identity proof, uniqueness checks, grant handling and revocation; this feature does not provide an unrestricted administrator email editor. Do not change Google's `subject` or repoint its `user_id` to make emails match.

Development changes are not production changes; the development database is refreshed from production. Verify the environment before any operator action.

## Verification boundaries

Worker tests use the production SQL adapter against PGlite/Postgres semantics and cover mailbox proof, Google-only proof, replay, expiry, concurrency, destination collisions, delivery failure, admin-grant preservation and dev restrictions. Browser tests exercise settings interaction and no pre-click provider requests. A simulated Google handoff is not evidence of a live Google account verification or a real email inbox delivery; hosted testing must separately verify configured mail delivery and real provider redirects before release.
