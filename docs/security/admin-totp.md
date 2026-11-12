# Admin authenticator operations (AQU-2553)

Email verification remains available until setup is confirmed AND the operator
acknowledges saving recovery codes. Pending setup expires after ten minutes.
Enrollment requires an email verification on the same credential within five
minutes. Enrollment does not grant platform-admin status.

An enabled factor is enforced even when ADMIN_REQUIRE_ELEVATION is false.

After activation, email issuance and redemption are refused. Existing elevations
are revoked; all elevation checks compare the current factor generation. This
also prevents a concurrently completing email verification from bypassing TOTP.
TOTP codes are six digits, SHA-1, 30-second steps with one-step clock tolerance.
Each time step and recovery code can succeed once, including concurrent requests.
Ten mutation attempts per account/deployment per five minutes are enforced by an
atomic Postgres counter. Successful operations count toward the limit.

## Deployment

Apply migration 0201 before deploying the code. Configure ADMIN_TOTP_KEY as a
random secret of at least 32 characters on each identity Worker where enrollment
is desired. Use DIFFERENT keys for production, dev, and previews. Never put this
key into Neon, source control, client bundles, logs or PR comments. There is no
fallback to SECRET_KEY. Missing configuration leaves email enrollment unchanged;
for an already enrolled user it fails closed rather than reverting to email.

Records are scoped by DEPLOYMENT_WORKER_NAME (ENVIRONMENT for local test stacks).
Do not rename that identity without migrating the matching records first: a new
name is a different factor scope. Database copies retain production-scoped rows
but development does not select or decrypt them. Preserve the key in the approved
operator secret store; replacing it without a migration would strand enrollments.

No feature enablement, production migration, or secret provisioning is performed
by the feature PR itself. Keep release approval gated on a real enrollment walk.

Do not roll back to a build predating the factor-generation gate after enrollment:
that build would accept email again. Disable new enrollment through configuration
while keeping factor-aware verification running, or ship a forward fix.

## Lost authenticator

Use an unused recovery code for admin verification. To replace the authenticator,
remove it under Platform → My admin security using a fresh TOTP or recovery code,
then verify by email and enroll again. Removal clears old recovery codes and
revokes elevations. Ordinary password/Google login is unchanged.

If BOTH authenticator and recovery codes are lost, there is intentionally no
email-only self-service reset. An authorized operator must verify the person's
identity through the organization's independent recovery process, record the
approval, and reset only the intended user/deployment. In one database transaction
remove that scoped admin_totp row, revoke that user's admin_elevations and
admin_elevation_codes, and add an admin_audit_log recovery entry. Do not grant new
admin permissions as part of recovery. Notify the account owner and require fresh
email verification and re-enrollment. Never reset merely because someone can
receive mail. This is an operator runbook, not a publicly callable reset endpoint.

## Privacy

Setup seeds, QR images, and recovery codes are returned only to the authenticated
admin, with Cache-Control: no-store. They are held only in component memory,
discarded on credential change, and the setup subtree is blocked/masked for replay.
Recovery codes contain 128 random bits and are stored only as SHA-256 digests.
TOTP seeds use AES-GCM with account/deployment-specific context. Audit events
contain action names, not secrets or submitted codes.
