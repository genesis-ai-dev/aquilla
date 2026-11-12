# CI preview access

AQU-2555 extends the development access policy to `aquilla-auth-preview`.
Password authentication, signup, Google signup/linking/login, authenticated API
requests and new sync-token issuance use the same check as development.

Allowed users are database platform admins or emails present in the shared
`DEV_ACCESS_LIST` KV namespace. A preview-only `ADMIN_EMAILS` QA bootstrap entry
does not bypass this login policy: list the fixture explicitly if it is needed.
Being an organization owner does not grant platform administration.

The list remains managed on **dev → Admin → Platform → Dev access**. Preview
admins cannot edit the shared list through the preview. Preview admin step-up
remains enabled; extending login eligibility must not extend dev's separate
step-up exemption. Missing KV or failed reads deny non-admins.

This inherits the existing dev policy's consistency limits: KV changes propagate
eventually, and sync tokens already minted can remain usable until their expiry
(up to 15 minutes). It is not an instantaneous global connection-kill mechanism.

Google's button still requires that preview's OAuth client configuration and an
exact registered callback URL. Access-list eligibility does not enable Google
login or copy a client secret into a new deployment.

## Existing-preview rollout

Changing the generator protects only deployments rebuilt with this code. It does
not update previously deployed Workers. An inventory on 2026-11-12 found 125 web,
125 identity and 99 sync previews; nine web aliases matched open PRs and 116 did
not. These counts are a snapshot, not a cleanup authorization.

1. Inventory all three preview parents through the Cloudflare Previews API and
   map aliases to open PR branches using `workersBuildPreviewAlias`.
2. Merge this change and update/rebuild active PR branches without replacing
   their feature code. Verify both allowed and denied sign-in, existing-session
   rejection, KV binding presence and continued admin step-up on each target.
3. Review unmatched aliases with their owners. Retiring a sync preview deletes
   Durable Object storage, and removing an auth preview can lose its individual
   secret configuration. Do not blanket-delete them as a security workaround.
4. Until old aliases have been updated or explicitly retired, report them as
   outstanding; do not claim that every live CI URL is restricted.
5. Prevent builds from outdated branches from recreating unguarded previews by
   requiring this access-policy change before publishing their next preview.

An isolated Neon copy also snapshots its `platform_admins` rows. If exact live
admin revocation must apply across long-lived isolated databases, use an
operator-approved central eligibility source rather than treating an old clone
as the current admin roster. Ordinary previews share the live dev database.
