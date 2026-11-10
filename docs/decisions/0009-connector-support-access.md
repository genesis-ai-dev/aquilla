# 0009 — Connector support access

*Decided and recorded 2026-11-10 (AQU-2504). Amended the same day to cover
WRITES — see § Writes below. Behaviour spec: the aquilla-specs repo, Access
Control — Permission Semantics, § Connector support access.*

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
- **It is tried last.** `sync-worker/src/external/support-access.ts::claimSupportAccess`
  runs only after the live role resolved to nothing, so an operator who is a
  genuine member keeps their genuine attribution — and is not audited for
  reading their own org. One consequence worth knowing: a platform admin who
  holds a *lower* genuine role somewhere (a Viewer seat in a customer's project)
  resolves on that role, not on support access, so support work there is bounded
  by the seat they actually hold. Dropping the seat restores the full grant.
- **It widens which projects a credential reaches, never what the credential
  itself may do.** A read-only credential stays read-only:
  `sync-worker/src/external/token-bridge.ts::assertCredentialMayWrite` refuses
  it at every write surface exactly as before, and
  `sync-worker/src/external/support-access.ts::claimSupportAccessForWrite`
  declines for the same reason rather than upgrading it.

Every access that rested on support access writes one `admin_audit_log` row via
`db/shared/support-access-audit.ts` — one per project opened, one per
enumeration naming everything it returned, and one per write.

## Writes

Writes were read-only in the first version and are now included (AQU-2504,
Ryder's decision of 2026-11-09: support often needs to change things). Consent
no longer forces `access: 'read'`; what bounds the cross-tenant write is the same
three live conditions, plus two additions.

**One resolver, not a check per surface.** The external write tier had nine
sites each running `resolveProjectRoleShared(db, { id: cred.userId }, projectId)`
and refusing on null — prepare, commit, the changeset authority check, the three
changesets routes and the token bridge. They now resolve through
`sync-worker/src/external/support-access.ts::resolveCallerProjectRoleForWrite`
and `::resolveCallerProjectRoleForGate`, because threading an access rule
through nine call sites by hand is how one of them ends up with a check the
others never got.

**The perimeter exemption is the load-bearing part.** A support write reaches
`POST /events` like any other external write, and the live membership re-check
there (`sync-worker/src/events/route.ts`, FRO-346) answers "revoked" for a
support engineer — correctly, since they have no membership rows in the
customer's project. The token therefore carries a new claim, `support: true`
(`SyncTokenClaims`/`EventClaims`), minted only by `mintInternalSyncToken`, and
that claim stands down **that gate and nothing else**: `src` stays `'external'`,
so every other external-token rule in `authorize.ts` still applies and the role
floors are unchanged.

This is deliberately *not* done by stamping `src: 'platform'`, which would hand
the token the blanket `ADMIN_EMAILS` exemption — the opposite of an opt-in,
time-boxed, audited grant. The revocation story the membership check exists to
enforce is preserved rather than dropped: `validateApiCredential` recomputes the
grant, the window and the `platform_admins` row on every call before the token
is minted, so revoking the row or letting the window close stops the next write
just as deleting a membership row does.

**Writes are audited fail-closed.** `auditSupportAccessWrite` inserts the row
*before* the write token exists and **throws** if the insert fails, which the
caller turns into a refusal. "Every cross-org access writes an audit row" is not
satisfied by "usually", and the cost of failing closed is a retry while the cost
of failing open is an unrecorded edit inside a customer's project. Reads keep
the opposite discipline (best-effort, after authorization) for the opposite
reason.

The early gates — prepare, commit's floor, the authority check, the changesets
routes — audit as cross-tenant **reads**, not writes. They expose project state
rather than changing it, so a prepare → commit sequence leaves one read row per
call plus one write row for the write itself, rather than one act counted three
times as three writes.

**Attribution.** `buildProvenance` (`sync-worker/src/external/commit-gates.ts`)
stamps `support_access: { platform_admin: true }` into `events.provenance`
beside the identity `human_authority` already carries, so "what touched this
cell" — the column AQU-533 made the one place to look — distinguishes a platform
admin's support write from a member's own edit. The parameter is **required**,
not optional, because there are eight provenance call sites across `commit.ts`
and the three command engines, and an optional flag is one a future site forgets
to pass, leaving a cross-tenant write indistinguishable from a member's.

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

- **Surfacing the attribution in the UI.** The marking is on the event
  (`events.provenance.support_access`), but `cell-history-read-route.ts` selects
  `author` and not `provenance`, so no client reads it yet, and neither the cell
  history panel nor the validation records render a platform-admin badge. The
  ticket's "an org owner sees a platform admin did it" is therefore satisfied in
  the data and **not yet in the interface**. That read path plus its badge is
  the remaining work.
- **Write surfaces beyond the changeset path.** The core write path — staging,
  committing and applying a changeset through `POST /events` — is covered. The
  specialised command surfaces resolve their own roles and stay
  membership-gated: `UpdateProjectSettings` (the sub-gates in `prepare.ts` and
  `commit.ts`), style rules, briefs, memory, membership and project setup. A
  support changeset containing one of those commands passes the outer gate and
  is refused by the inner one, which is the intended, narrower perimeter.
- **Read surfaces beyond listing and reading orgs and projects.** Member rosters
  (`sync-worker/src/external/members-read.ts`) and artifacts
  (`sync-worker/src/external/artifacts-route.ts`) resolve their own roles and
  stay membership-gated. Also deliberately narrower than the grant's wording.
- **Whether an org owner can see the audit log for their own org.** It is
  internal; Ryder's 2026-11-09 note settles that attribution in the normal
  places is enough and no separate owner-facing log is needed.
