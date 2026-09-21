# Operational Security Review — 2026-08-31

_Eighth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-27.md`
(OPS-22…OPS-24), `docs/OPSEC-REVIEW-2026-08-24.md` (OPS-18…OPS-21),
`docs/OPSEC-REVIEW-2026-08-20.md` (OPS-15…OPS-17),
`docs/OPSEC-REVIEW-2026-08-17.md` (OPS-11…OPS-13),
`docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-25._

**Scope for this pass: authentication & session management**, the Monday slot
in the rotating weekly cycle (**auth/session Mon**, authz/access Tue,
injection Wed, API/data exposure Thu, infra/deployment Fri). The 2026-08-24
pass (the previous Monday) closed with an explicit instruction for this one:

> **Invite tokens ride in a URL path** (`/join/:token`, `/join-org/:token`) and
> are, like the reset tokens OPS-20 just hashed, bearer credentials. This pass
> did not check how `project_invites` stores them. Same question, same table
> shape, obvious next place to look — worth an explicit item in the next
> auth/session pass rather than being folded into this one.

So this pass took the invite surface end to end: `auth-worker/src/routes/invites.ts`
(multi-project), the legacy single-project routes in `routes/projects.ts`, the
org-invite routes in `routes/orgs.ts`, the `project_invites` / `org_invites`
schema, and the session handling on all three of their public preview routes.

Every finding is labelled **FACT** (verified against a file:line or a test run
at this commit) or **JUDGMENT** (reasoned inference).

**What this pass turned up.** The invite *lifecycle* logic is in good shape —
expiry, email binding, archived-project refusal, and single-use stamping are
all present and consistent across the three surfaces (see "Reviewed, no
finding"). The two findings are on either side of it. OPS-25 is a session bug
found while reading how those routes identify their caller: three hand-written
copies of a "best-effort caller" helper that skipped **both** of this
codebase's token-revocation controls — a bypass of two prior pen-test
remediations, on a path that makes a disclosure decision. OPS-26 is the
question 08-24 actually asked, now answered: invite tokens are stored in
plaintext, and unlike OPS-20's reset tokens they cannot simply be hashed,
because three product surfaces deliberately re-display them.

---

## Findings

### OPS-25 — The public invite previews skipped both token-revocation controls — **FIXED** [FACT]

The three invite-preview routes are anonymous-reachable by design, but they do
read a caller identity when one is offered. AQU-347 added a branch where that
identity changes the answer: if the caller is the original redeemer of an
already-used invite *and* is still a member, the route returns a normal 200
preview ("you're already in — continue") instead of the terminal
`410 {code: "used"}` everyone else gets.

Each route resolved that identity through its own local `optionalCaller`
helper — three copies, in `routes/invites.ts`, `routes/orgs.ts` and
`routes/projects.ts`, whose own doc comments acknowledged the duplication
("Mirrors `optionalCaller` in routes/invites.ts"). All three were identical,
and all three did only this:

```ts
const payload = await jwtService.verifyToken(token)   // signature + exp
if (!payload) return null
const now = Math.floor(Date.now() / 1000)
if (payload.exp < now) return null
return jwtService.getUserByUsername(payload.sub)      // → full AuthUser
```

Signature and expiry, then a full user hydration. What it never did — and what
`authMiddleware` has done on every authenticated request for weeks — is check
either revocation control this codebase has built:

- **The `jti` denylist** (`utils/token-revocation.ts`, added by the
  [Pen test] Auth & session mgmt pass of 2026-08-03, migration 0073). A token
  the user explicitly logged out still resolved to that user here.
- **The `password_changed_at` cutoff** (`middleware/auth.ts`, added
  2026-07-20, migration 0066). A token minted before a password reset — i.e.
  precisely the token you reset your password to kill — still resolved to that
  user here, for the remainder of its 30-day life.

So both mechanisms the system has for saying "this credential is dead" were
enforced on every route *except* the three that had opted out of the
middleware. Verified as a real bypass, not a reading of the code: the six
regression tests below fail (200 where 410 is expected) against the pre-fix
helper on all three routes, for both controls.

**Impact, assessed rather than assumed.** This is a disclosure gap, not
privilege escalation. To use it an attacker needs *both* the invite token and
a dead-but-unexpired access token for the user who originally redeemed it, and
that user must still be a member. What it yields is the preview payload:
project name, org name, the inviter's display name, role level, expiry, lane
scopes, and (on the single-project route) the invitee's email address. That is
squarely the **D3** "translator identity + activity" linkage `docs/OPSEC.md`
§1 treats as the sensitive asset — "who is translating what, and when" — but
it is one project's worth of it, behind a two-credential precondition. **Low**
likelihood.

The reason it is worth fixing at more than its own severity is the shape, not
the blast radius. `optionalCaller` returns a full `AuthUser`, so it is a
general-purpose identity primitive with a revocation bypass baked in — any
future route that reaches for "best-effort caller identity" inherits it, for a
decision that may be larger than a preview. And the specific failure mode is
one this series has already catalogued: OPS-11 found the service-to-service
bearer compare in seven hand-written copies, one of which was not
constant-time. Same disease, same ward — a security check that lives in N
copies is a check that is correct in N−1 of them.

**Fixed:** all session checks now live in one exported `resolveSession()`
(`middleware/auth.ts:50`), which both `authMiddleware` and a single shared
`optionalCaller` (`middleware/auth.ts:138`) go through. The three route-local
copies are deleted and import the shared one
(`routes/invites.ts:271`, `routes/orgs.ts:98`, `routes/projects.ts:1526`).
`authMiddleware` maps `resolveSession`'s rejection reasons onto exactly the
status codes and response bodies it returned before — the existing
`logout`, `session-invalidation` and `auth-middleware-db-outage` suites pass
unchanged, which is the point of doing it as an extraction rather than a
rewrite. `optionalCaller` collapses every rejection to "anonymous".

Two deliberate calls worth recording:

- **A hydration failure now reads as anonymous** on the preview routes, where
  it previously threw out of the helper. `authMiddleware` still answers 503
  for it (AQU-994 — a Postgres blip must not read as a dead credential and
  force-log-out active editors). The optional path has no credential to
  impugn and no 503 to return, and anonymous is the conservative answer for a
  route where caller identity only ever *widens* what is disclosed.
- **The drift guard is the other half of the fix.** One helper is only a fix
  for as long as it stays the only one, so a test scans every file in
  `src/routes/` for a route deriving a user from a token itself, with
  `routes/auth.ts` explicitly allowlisted and justified (its login handler
  resolves a user from the *request-body username* to check a password
  against; its refresh handler echoes the caller's raw token string from
  behind `authMiddleware`). Neither derives identity from a token.

### OPS-26 — Invite tokens are stored in plaintext at rest — **NOT FIXED, reported** [FACT]

This is the question 2026-08-24 handed to this pass, and the answer is: not
hashed. `project_invites.token` and `org_invites.token` are the raw bearer
token (`db/postgres/schema.sql:196`, `:233`), and every lookup is a direct
equality match on it — `WHERE token = ?` at `routes/invites.ts:241,370`,
`routes/projects.ts:1504,1594`, `routes/orgs.ts:83,863`, plus the
revoke/stamp writes.

`docs/OPSEC.md` §1 D5 lists "invite tokens" among the bearer credentials and
annotates the row "(all hashed…)" with an explicit caveat that the claim "has
not been checked against `project_invites`". It is now checked, and for invite
tokens the claim is **false**. The D5 row is corrected in this change.

The exposure is exactly OPS-20's, one table over: a read-only copy of the DB
(a Neon snapshot, a branch, a backup, a replica, a support query) hands the
holder live, working invite links. Redeeming one is not account takeover — it
grants the invite's role on its project or org, and email-bound invites still
require a matching account email — but for an *unbound* open link it is a
silent, self-service membership grant into a translation project, which is D2
+ D3 access. It also leaves an ordinary-looking trail: the row's `used_by`
names a real account that legitimately redeemed a legitimate link.

**Why this is not fixed here, unlike OPS-20.** Reset and verification tokens
were hashable in an afternoon because nothing ever needs to display them again
— they are minted, mailed, and redeemed. Invite tokens are different: **three
product surfaces deliberately re-display a live invite token**, and each one
would break the moment the plaintext stops existing.

- `GET /api/v2/projects/:projectId/invites` returns `token` for every active
  invite to any project_lead+ (`routes/projects.ts`), so an admin can re-copy
  a link they already handed out.
- `GET /api/v2/orgs/:orgId/invites` does the same for org owners
  (`routes/orgs.ts:799`).
- `GET /api/v2/invites/mine` returns `token` to the *recipient*
  (`routes/invites.ts:161`), and the SPA's pending-invitations card links
  straight to `/join/{token}` (`src/components/org/OrgHome.tsx:870`) — the
  in-app path for an invite whose email never arrived, which is the entire
  point of AQU-326.

Hashing at rest therefore requires picking one of two real changes, both of
which are product decisions rather than security patches:

1. **Show-once, like the Agent-API PATs.** `db/shared/api-credentials.ts` is
   already the model this repo says the rest of the system should follow:
   hashed at rest, plaintext returned exactly once at mint. Applying it here
   means the admin invite lists show a non-secret display prefix and a
   "revoke / re-issue" affordance instead of a copyable link, and re-copying
   an existing link stops being possible. That is a genuine UX regression for
   the "resend the link to Wendi" workflow and needs a product call.
2. **Accept-by-id for the identified surfaces.** `/mine` and the admin lists
   could return an opaque invite id rather than the token, with acceptance for
   email-matched invites moving to an authenticated by-id route (the caller is
   already authenticated and email-matched there, so the token adds no
   authorization). Open share links would keep a token, hashed, redeemed by
   digest lookup. This preserves every workflow but touches both invite route
   files, the join page, the SPA client, and a migration with a rollover arm.

Either is a bigger change than this pass should land unannounced on a
billing-adjacent membership path, and neither is a mechanical port of OPS-20's
migration. Recorded here as a confirmed FACT with both fix shapes sketched,
per the standing practice OPS-21/OPS-24 follow, for a pass that can scope the
product decision properly.

**Two mitigations that already hold, and are why this is Medium rather than
High:** invite tokens carry 122 bits of entropy
(`crypto.randomUUID().replace(/-/g, "")` — `routes/invites.ts:119`,
`routes/orgs.ts:747`, `routes/projects.ts:1383`), so they are not guessable;
and they expire (30 days by default) and are single-use, so a stale snapshot
decays on its own in a way a password-reset table does not.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-25 | Invite previews skip the `jti` denylist and `password_changed_at` cutoff | Low — needs the invite token *and* a dead-but-unexpired token for the original redeemer | Low-Medium — D3 linkage for one project (names, inviter, invitee email); the primitive itself is a reusable identity resolver with a revocation bypass | **Low-Medium** | Fixed |
| OPS-26 | `project_invites` / `org_invites` tokens plaintext at rest | Low — needs DB read access | Medium — live membership grants into translation projects (D2+D3), redeemable silently | **Medium** | Reported, not fixed (see finding) |

---

## Countermeasures applied in this change

| Control | Where |
|---|---|
| One `resolveSession()` behind both the required and the optional auth paths, so a session check cannot be enforced on one and forgotten on the other | `auth-worker/src/middleware/auth.ts` |
| The three route-local `optionalCaller` copies deleted in favour of the shared one | `auth-worker/src/routes/invites.ts`, `routes/orgs.ts`, `routes/projects.ts` |
| Drift guard: no file in `src/routes/` may resolve a user from a token itself | `auth-worker/src/__tests__/invite-preview-revocation.test.ts` |
| `docs/OPSEC.md` D5 corrected — invite tokens are named as plaintext instead of carrying an unverified "hashed" claim | `docs/OPSEC.md` |

Every one has a test. `invite-preview-revocation.test.ts` (new, 13 tests)
runs each of the three preview routes through four cases — live token still
200, anonymous 410, logged-out token 410, password-reset-invalidated token 410
— plus the drift guard. **The six revocation cases were verified to fail
against the pre-fix helper** (200 instead of 410, on all three routes, for
both controls) and pass after; the baseline and anonymous cases pass in both
states, so the six are failing for the reason claimed and not for a broken
fixture.

Full auth-worker suite green at this commit: **151 files, 1539 tests**.
`tsc --noEmit` is clean across `auth-worker/src` (the only remaining errors
are unresolved imports from sibling packages whose deps aren't installed —
`db/shim`, `sync-worker`, root `src/lib` — unchanged by this PR), and
`eslint` reports zero errors and zero warnings on every touched file.

## Reviewed, no finding

- **Invite lifecycle checks across all three surfaces.** Expiry, single-use
  stamping, email binding and archived-project refusal are present and
  agree with each other: `routes/invites.ts:363` (multi accept),
  `routes/projects.ts:1582` (single accept) and `routes/orgs.ts:856` (org
  accept) each check expiry, compare a bound `email` case-insensitively
  against the redeemer's account email, and refuse archived projects. The
  used-stamp writes are all `UPDATE … WHERE token = ? AND used_at IS NULL`,
  so only the first of concurrent redeemers wins. No gap found.
- **Public-route registration order.** Both `orgs.ts` and `projects.ts`
  register their `invite-preview` route *before* the router-wide
  `orgs.use("*", authMiddleware)` (`orgs.ts:136`), and everything after it
  stays authed — including `POST /accept-invite`, which reads `c.get("user")`
  and would be a null-dereference if it were not. Checked explicitly because
  a route accidentally registered on the public side of that line is the
  natural way this pattern fails. It is correct as built.
- **Invite token entropy.** All three minters use
  `crypto.randomUUID().replace(/-/g, "")` — 122 bits from a CSPRNG. Not
  brute-forceable, which is also why the absence of a rate limit on the
  preview routes is not a finding.
- **Invite-list authorization.** `GET /:projectId/invites` requires
  project_lead+ (`INVITE_MIN_ROLE`) and `GET /:orgId/invites` requires org
  owner, both re-resolved per call. The tokens these return are a
  confidentiality question (OPS-26), not an authorization one.
- **`GET /invites/mine` scoping.** Matched on `LOWER(pi.email) = LOWER(?)`
  against the caller's own account email, unredeemed and unexpired only, with
  archived projects excluded. Open (un-emailed) links carry no recipient
  identity and correctly never appear. No cross-user leak.
- **`authMiddleware`'s own checks**, re-read as part of the extraction:
  no-`exp` tokens rejected, `jti` denylist, `password_changed_at` floor,
  AQU-994's 503-not-401 on hydration failure. All preserved verbatim by the
  refactor — this pass changed where they live, not what they do.

## Not fixed here — needs follow-up

- **OPS-26** — invite tokens plaintext at rest. Needs the product decision
  between show-once and accept-by-id described in the finding.
- **Post-rollover cleanup for OPS-20** — carried forward, and now overdue:
  the migration-0080 window (24h for resets, 7d for verification) has elapsed
  since 2026-08-24, so the plaintext arm can be dropped from the four lookups
  in `routes/auth.ts` and then the `token` columns themselves. Steps are in
  the migration header; the two rollover tests are commented for deletion at
  the same time. This is the cheapest open item in the series.
- **OPS-24** — the credit-guard check-then-act race. Needs a pass scoped to
  billing.
- **OPS-21's remaining blocker** — the 399 `i18n/no-unkeyed-string` errors
  gating every PR. Belongs to whoever owns the i18n gate.
- **`auth-worker` carries two lockfiles** (`package-lock.json` and
  `pnpm-lock.yaml`) resolving different `@cloudflare/workers-types` versions.
  Unchanged since 08-24; still worth deleting one.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — unchanged,
  still the highest-leverage open item across the whole series; out of scope
  for this pass's theme but re-flagged per standing practice.

---

_Re-run the mechanical parts of this review with: `cd auth-worker && npx tsc
--noEmit && npx vitest run`._
