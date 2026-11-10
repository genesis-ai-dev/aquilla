# 0009 — Connector support access

*Decided and recorded 2026-11-10 (AQU-2504). Behaviour spec: the
aquilla-specs repo, Access Control — Permission Semantics, § Connector support
access.*

## Context

Platform admin is the cross-tenant primitive: an operator on the
`platform_admins` allowlist resolves owner-level on every project, through the
`platform` contribution in `db/shared/project-roles.ts::resolveProjectRoleShared`.
The Agent API and MCP connector deliberately never applied it. `scopeCredentialToProject`
(`sync-worker/src/external/read-auth.ts`) resolves the project role without
passing an admin allowlist, and `sync-worker/src/external/orgs-list.ts` /
`sync-worker/src/external/projects-list.ts` enumerate on membership alone — so a
support engineer's connector could not see the project a customer was messaging
them about.

The obvious fix is the wrong one. Passing the allowlist into the resolver on
that path would hand *every* connector credential of *every* platform admin
silent cross-tenant reach, permanently, with nothing to opt into, nothing to
expire and nothing recorded. The question is not whether the operator has the
power — they do, on the web — but how it gets licensed onto a long-lived token
held by a third-party MCP host.

## Decision

Support access is **a property of one credential, not of the person**, and it is
live only when three independent conditions hold at once, re-checked on every
call in `db/shared/api-credentials.ts::validateApiCredential`:

1. the credential carries the `support_access` grant, ticked at connector
   consent (`auth-worker/src/routes/mcp-oauth.ts::maySupportAccess`, which
   requires an allowlist row **and** an active step-up elevation);
2. its `support_access_until` window is still in the future — the same length as
   the console's step-up (`auth-worker/src/routes/mcp-oauth.ts::supportAccessHours`);
3. its owner is on the allowlist *now*
   (`db/shared/api-credentials.ts::isPlatformAdminUser`).

Any one lapsing returns the credential to ordinary member scope, silently and on
the next request. Two columns rather than one because the grant must outlive the
window: the token keeps working, member-scoped, and still says what it was.

Three rules follow from that, and they are the ones a reviewer should apply:

- **It widens who counts as a member, never the credential's own scope.** The
  org/project narrowing in both list queries, and steps 1–2 of the read gate,
  are untouched. A support credential is minted with no allowlist and no scope,
  so there is nothing to intersect.
- **It is tried last.** `sync-worker/src/external/read-auth.ts::claimSupportAccess`
  runs only after the live role resolved to nothing, so an operator who is a
  genuine member keeps their genuine attribution — and is not audited for
  reading their own org.
- **It is read-only, by the ceiling that already exists.** Consent forces
  `access: 'read'`, which
  `sync-worker/src/external/token-bridge.ts::assertCredentialMayWrite` and the
  `mintInternalSyncToken` backstop behind it already refuse at every write
  surface. There is no new cross-tenant write path to get wrong.

Every access that rested on support access writes one `admin_audit_log` row via
`db/shared/support-access-audit.ts::auditSupportAccessRead` — one per project
opened, one per enumeration naming everything it returned.

## Consequences

- The allowlist read for this grant is the `platform_admins` **table** only, not
  the `ADMIN_EMAILS` bootstrap that `auth-worker/src/middleware/platform-admin.ts`
  also honours. An env var is the wrong anchor for a cross-tenant read grant,
  and `db/shared` is handed no env on the validation path. A local, e2e or
  self-hosted deployment that wants support access writes the row.
- `isPlatformAdminUser` is its own guarded read rather than a subquery in the
  credential SELECT. A missing or unreadable `platform_admins` must cost one
  credential its support access, not break authentication for every token.
- MCP's `get_project` resolves the project role itself instead of going through
  `scopeCredentialToProject`, so it calls `claimSupportAccess` directly. Any new
  read surface that resolves its own role inherits that obligation — and
  inherits refusal, not access, if it forgets.
- Renewing a lapsed window means running connector consent again, elevated.
  There is no renew endpoint, so a stale window fails closed.

## Not covered yet

- **Writes.** Read-only was the decision for the first version; the shape for
  later is a staged changeset the customer's own team approves, not a wider
  ceiling.
- **Surfaces beyond listing and reading orgs and projects.** Member rosters
  (`sync-worker/src/external/members-read.ts`) and artifacts
  (`sync-worker/src/external/artifacts-route.ts`) resolve their own roles and
  stay membership-gated. That is a narrower perimeter than the grant's wording
  suggests, deliberately.
- **Whether an org owner can see support access in their own org.** The audit
  log is internal today. Nothing in this record promises otherwise.
