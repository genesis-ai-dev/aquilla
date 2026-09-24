# Operational Security Review — 2026-09-24

_Continues the standing series. Most recent entries: `docs/OPSEC-REVIEW-2026-09-23.md`
(OPS-35…OPS-36, input validation & injection) and `docs/OPSEC-REVIEW-2026-09-17.md`
(OPS-33…OPS-34, API security & data exposure). New finding continues the **OPS-n**
series at **OPS-37** — see the numbering note in `docs/OPSEC.md` if this collides with
another concurrent pass; merge order wins, no finding is lost by a renumber.

**Scope for this pass: API security & data exposure**, the seventh pass on this theme in
the rotating weekly cycle (auth/session Mon, authz/access Tue, injection Wed, **API/data
exposure Thu**, infra/deployment Fri). Two parallel survey agents mapped the full surface:
one over `auth-worker`'s `/api/v1/*` and `/api/v2/*` routes (IDOR, PAT/credential handling,
admin gating, CORS, rate limiting, response data exposure), one over `sync-worker`'s
external Agent API, comments, audio/R2, the `ProjectSync` DO, and the in-flight
Monday.com nudge (cross-project scope checks, R2 URL guessability, service-to-service
auth). The `auth-worker` sweep found no new finding — the prior six passes on this theme
plus the auth/session and injection series have already closed rate limiting, PAT scoping,
IDOR on nested resources, admin gating, and raw-error leakage on that surface, and this
pass did not find a new instance of any of those classes. The `sync-worker` sweep found
one real gap, below.

Every finding is labelled **FACT** (verified against a file:line and a passing regression
test at this commit) or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-37 — Comment `@mention` notifications resolved emails with no project-membership check — **FIXED** [FACT]

`sync-worker/src/notification-email.ts`'s `sendCommentNotifications` (wired from every
`comment.create` event in `events/route.ts:1743`, including comments an external agent
posts via the Agent API's `EmitEvents`) builds its recipient list from two sources:

1. **Thread participants** (`getThreadParticipants`) — correctly scoped: the query filters
   `WHERE project_id = ?`, so only users who have actually authored a comment on that
   project's thread come back.
2. **`@mention`s** (`extractMentions`) — a bare regex over the comment body,
   `/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]*)/g`, with no validation of who the matched username
   is. The result fed straight into `resolveUserEmails`, which looks the username up in
   the global `users` table with no project (or org) scope at all.

**Concrete impact:** any project contributor able to post a comment — or an agent
replying through the external Agent API — could write `@anyregistereduser` in a comment
on a project that user has never been granted access to, and `resolveUserEmails` would
still resolve their real email and send them a notification containing a 200-character
excerpt of the comment body, the project's display name, and a deep link to that
project's comments page. Two effects: (a) a cross-tenant content-disclosure primitive —
comment text a user has no authorization to see lands in their inbox anyway; (b) a
username-enumeration/spam primitive — repeated `@guessedname` mentions probe which
usernames exist on the platform and can flood an arbitrary account's inbox, since nothing
rate-limits or scopes the mention set.

This is the same shape of bug as OPS-33/OPS-34 (an authorization check applied to one
sibling code path but not another that reaches the same sensitive data) — here the
sibling is "thread participants" (scoped) vs. "mentions" (unscoped), inside the same
function.

**Fix:** added `filterUsernamesWithProjectAccess(db, projectId, usernames)`, which mirrors
the grant-path union already used at the write perimeter
(`events/membership.ts`'s `checkProjectMembershipDetailed`: direct `project_members`,
project creator, `org_members` at `MAINTAINER`+, `group_project_grants`) but keyed by
username instead of user id, in one indexed query. `sendCommentNotifications` now runs
raw `@mention` matches through this filter before merging them into the recipient set —
thread participants are untouched, since they were already correctly scoped. A mention
of a real username with no grant on the project is silently dropped (no error, no
degraded email) rather than sent.

No UX/UI change: the mention *rendering* in the comment body is unaffected (any
`@username` still displays as typed) — only the *notification-email* side effect is
now access-controlled. A contributor mentioning a fellow project member sees no change
in behavior at all.

---

## Reviewed, no new finding

- **Agent API cross-project scope checks** (`read-auth.ts`, `changesets-route.ts`,
  `artifacts-route.ts`, `comments-route.ts`, `search-reads.ts`, `org-read-routes.ts`,
  `quality-routes.ts`, `memory-read-routes.ts`, `export-route.ts`, `similar-route.ts`) —
  every project-scoped handler runs through `authenticateAndScope`/`assertCredentialScope`,
  which checks the PAT's `projectId`/`orgId` against the requested resource and re-resolves
  the caller's live role; a wrong-project PAT gets `scope_denied`, not a degraded or empty
  result. Cross-project search gates every requested project before running any query
  (all-or-nothing), so it cannot be used as an existence oracle. Not a finding.
- **MCP tools-only server** (`mcp-handlers.ts`) — every tool delegates to the same REST
  route handlers via a synthetic in-process request carrying the same bearer token; no
  parallel, weaker auth path. Not a finding.
- **R2 audio route** (`audio.ts`) — PUT/GET/DELETE all require a sync-token JWT whose
  `projectId`/`fileId` claims are checked against the URL; filenames are restricted to a
  safe charset (`isPathSafeId`, closing OPS-23's class); content-type sanitized against a
  browser-renderable-type denylist. Not a finding.
- **`ProjectSync` Durable Object WS upgrade** (`project-do.ts`) — requires
  `verifyTokenForProject`; an ejected member's still-valid token is denied via a
  `removedUsers` deny-window. Service-to-service DO endpoints gate on a constant-time
  `serviceBearerMatches`. Not a finding.
- **Monday.com nudge** (in-flight, `sync-worker/src/monday-notify.ts` +
  `auth-worker/src/routes/monday.ts`) — the internal push endpoint is bearer-gated with
  `secureCompare`, and the project id it pushes about is read from the DO's own broadcast
  frame, not from anything a caller supplies — cannot be redirected to push about a
  project the triggering event didn't originate from. Not a finding.
- **PAT/credential lifecycle, admin gating, CORS, rate limiting, SQL construction**
  (`auth-worker/src/routes/credentials.ts`, `middleware/platform-admin.ts`,
  `utils/rate-limit.ts`, `lib/agent/sql-guard.ts`, `db/shim/postgres.ts`) — re-swept, all
  consistent with the fixes closed by the prior six passes on this theme. Not a finding.

## Secondary checks (confirmed still open, not re-investigated — out of this pass's theme)

- **OPS-24** (credit-guard check-then-act race) — still open, billing-scoped fix needed.
- **V7/SEC-1** (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`) — still the highest-leverage
  open item in the whole series.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-37 | `@mention` comment notifications resolved emails with no project-membership check | High — reachable by any project contributor (or an agent) via an ordinary comment, no special access or timing required | Medium — discloses comment excerpt + project name to an outsider's inbox (not account takeover), plus a username-enumeration/spam primitive | **Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| `filterUsernamesWithProjectAccess()` scopes `@mention` recipients to live project grants (direct membership, creator, org `MAINTAINER`+, group grant) before email resolution | `sync-worker/src/notification-email.ts` |
| Regression tests: an outsider mention is dropped and never emailed; each grant path (direct, creator, org-maintainer) is kept; a sub-maintainer org role is correctly rejected; thread-participant behavior is unchanged | `sync-worker/src/__tests__/notification-email.test.ts` |

## Verification

* `sync-worker`: `npx tsc --noEmit` clean on the changed file (pre-existing, unrelated
  errors elsewhere in the tree are present without this change too); `npx eslint` clean on
  both changed files (one pre-existing warning on an untouched line); targeted suite
  (`notification-email.test.ts`) green — 27 tests; full `npx vitest run` — 1893 tests
  passed, 0 failed (33 test files errored only at module-resolution time due to a missing
  root-workspace dependency in this sandbox, unrelated to this change and present on `dev`
  HEAD before it).
* No response shape or status code changed on any route. The only behavioral change is
  that a `@mention` of a user with no grant on the project no longer sends that user an
  email — thread-participant notifications and mentions of actual project members are
  unaffected. No UX/UI impact: this is a server-side, best-effort notification side effect
  with no in-app surface of its own.

---

_Re-run the mechanical parts of this review with: `cd sync-worker && npx tsc --noEmit &&
npx eslint src/notification-email.ts src/__tests__/notification-email.test.ts && npx
vitest run src/__tests__/notification-email.test.ts`._
