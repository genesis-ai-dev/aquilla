# Operational Security Review — 2026-11-16

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-11-09.md`.
New findings continue the **OPS-n** series at **OPS-56**._

**Scope for this pass: authentication & session management** — the Monday slot.

1. **A parallel auth/session pen-test pass ran again.** Commit `a30012c3`
   ("[Pen test] Auth & session: an unclaimed admin address cannot be
   registered, access links refuse accounts with standing, the old address
   hears of an email change") landed on `dev` and touched
   `auth-worker/src/routes/auth.ts`, `routes/access-links.ts` and
   `routes/email-change.ts`. Like `287f7250`, `cf042e21`, `87397102`,
   `b225cb40`, `7455641c5` and `12a56f19` before it, it wrote no review
   document, so its findings carry no OPS-n. **This pass therefore avoids those
   three files entirely.** That is the **tenth** concurrent-pass collision the
   series has recorded. §0's numbering note remains the right diagnosis and
   scheduling remains the fix; for the Monday slot the collision is simply the
   standing condition.

2. **The ledger is now being maintained by work that is not this series, which
   is OPS-52 working better than it was designed to.** Two commits since 11-09
   added rows to `scripts/platform-elevation-coverage.test.ts` without any
   OPSEC pass asking them to: `4e12c961` (AQU-2504) recorded `mcp-oauth.ts`,
   and `53564750` (AQU-957) recorded `email-change.ts`. Both arrived already
   *deciding*. The census assertion is what forced the rows — a new route that
   reaches platform-winnable power fails the first assertion until someone
   states its state — so the queue is now kept current by whoever touches it,
   not by the next review. That is the decay OPS-50 named, closed.

3. **This pass read what the ledger told it to read — the second finding in the
   series located that way.** 11-09's residual item 2 said *"`member-scopes.ts`
   is the new head of the queue (2 writes), for both of this pass's reasons at
   once: it is `undecided` in the elevation ledger, and its `scopes:
   z.array(scopeSchema)` is the next uncapped caller array that becomes
   per-element work. The ledger carries both notes, so the next pass does not
   need this document."* Both halves were real, and this pass opened that file
   first rather than re-deriving a queue.

4. **A correction to the ledger's own row, because it understated the
   finding.** OPS-48 recorded `member-scopes.ts` as "2 writes". The file has
   **one** write *route* — the scopes `PUT`; the other three routes are reads.
   The two writes are two **tables** written by that one request:
   `project_member_scopes` and, through `syncMemberLaneGrants`,
   `project_member_lane_roles`. That is not a bookkeeping quibble — the second
   table is the one the lane read wall actually enforces, which is why this is
   a bigger finding than the count suggested rather than a smaller one. The
   ledger row is corrected in this change.

5. **One finding came from this pass's own fix rather than from the code it was
   reading, and it is the transferable lesson.** Narrowing the role at the
   floor would have been **cosmetic** here: two guards *downstream* of the
   floor read the caller's level again, and both would have kept reading the
   un-narrowed 700. Every prior de-escalation in this series (OPS-44, -47, -49,
   -51, -53) guarded routes whose floor was the *only* level read, so the
   pattern "narrow, re-apply floor, done" was sufficient and nothing forced the
   question. It is not sufficient in general, and §OPS-56 records the rule.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-56 — One un-elevated PUT rewrites the lane-grant rows the read wall enforces, on any project on the platform, in both directions — and the cheapest request is the widening one — **FIXED** [FACT]

**The mechanism, in one line.** `resolveProjectRole` pushes
`{ source: "platform", level: 700 }` for every platform operator
(`auth-worker/src/services/project-permissions.ts`), and `ROLE.PROJECT_LEAD` is
**500** (`auth-worker/src/types.ts`). So in
`auth-worker/src/routes/member-scopes.ts`:

```ts
const callerRole = await resolveProjectRole(c.env, user, projectId)
if (!callerRole) return c.json({ error: "no access to project" }, 403)
if (callerRole.level < ROLE.PROJECT_LEAD) {
  return c.json({ error: "project_lead required to manage scopes" }, 403)
}
```

`700 < 500` is false. The floor was cleared by the admin contribution's own
value, on every project in every org, with no elevation asserted and no genuine
grant required.

**Why this is not "one more un-gated write".** Three reasons, and the third is
the one that makes the exploit cheap.

* **This PUT writes authorization, not a setting.** One request replace-sets
  `project_member_scopes` *and*, through `syncMemberLaneGrants`
  (`auth-worker/src/services/lane-grants.ts`), `project_member_lane_roles` —
  the table the lane read/write wall enforces (AQU-730 / AQU-1415). The route's
  own comment says so: *"The write wall (on in dev and prod) reads lane grants,
  not scopes."*
* **A grant row is standing access that outlives the request.** The wall
  resolves a member's visible lanes from their own grant rows, carried into the
  sync token's `laneGrants` claim and read by
  `sync-worker/src/events/lane-read-wall.ts`. There is no actor in that path —
  by the time the row is used, the reader is an ordinary member of the project,
  which is exactly what the row made them. This is the category OPS-44 named
  for a PAT, OPS-49 for an integration link, OPS-51 for a source link and
  OPS-53 for a termbase subscription, a **fifth** time: the artefact outlives
  the authority that created it, so an elevation check at use time can never
  reach it.
* **`planLaneGrants` reads an empty scope set as "every lane".** So the
  cheapest possible request on this route — `PUT { "scopes": [] }`, which the
  route documents as *"An empty array clears all scopes (unscoped = today's
  behavior)"* — is the **widening** one. It hands a lane-walled member every
  target lane of the project, archived lanes included (`syncMemberLaneGrants`
  deliberately loads archived lanes, AQU-1781). No crafted payload, no decoy,
  no knowledge of the project's lane set.

**And two guards *downstream* of the floor read the level again, so both of the
route's own safety rails were open to the same principal.**

* **The self-edit refusal.** A [Pen test] fix of 2026-10-20 added

  ```ts
  if (targetUserId === user.id && callerRole.level < ROLE.MAINTAINER) {
    return c.json({ error: "you cannot change your own lane scopes" }, 403)
  }
  ```

  precisely so *"a lane-limited lead could [not] clear their OWN scopes and
  widen themselves to every lane."* `ROLE.MAINTAINER` is 600 and the admin
  contribution is 700, so an un-elevated operator cleared that guard as though
  they were a maintainer — the exact move the guard exists to stop.
* **The lane-limited merge.** `mergeLanesALimitedCallerMayGrant` enforces *"you
  can only grant lanes you hold"*, but its `lanesHeldByCaller` returns `null`
  (meaning *every* lane) at `callerLevel >= ROLE.MAINTAINER`. At 700 the whole
  rule was skipped, so a lane-limited operator could grant lanes they do not
  hold.

**Both directions were reachable, and both are tenant-visible.** Widening
defeats the read wall: a contributor walled to one language reads every
language's drafts, which is the sibling-lane disclosure AQU-1421 exists to
close. Narrowing walls a member off their own work — and per AQU-1999 a lane
removal is what closes their open assignments. The new suite reproduces both
against a tenant project the operator holds no grant on.

**The fix, and the rule it establishes.** Platform power is stripped unless the
session is elevated, then the route's own floor is re-applied to what genuinely
remains — the OPS-53 shape:

```ts
const effective = await roleWithoutUnelevatedAdmin(c, user, projectId, callerRole)
if (!effective || effective.level < ROLE.PROJECT_LEAD) {
  return c.json(
    { error: "elevation required to manage a member's lane scopes with platform-admin access" },
    403,
  )
}
```

…**and `effective.level` is threaded into both downstream guards.** This is
§0.5's lesson stated as a rule, and it is the part worth carrying forward:

> De-escalating a role at the floor is only the whole fix when the floor is the
> only place the level is read. Where a route reads the caller's level *again*
> after its floor — a self-edit rule, a "only grant what you hold" rule, a
> ceiling — every one of those reads must use the de-escalated role, or the
> narrowing is cosmetic and the route's own safety rails stay open to exactly
> the principal the gate was added for.

The floor is checked **before** narrowing, so a genuine below-floor member and
a non-member keep their byte-identical pre-OPS-56 refusals; only a caller who
cleared the floor on platform power alone sees the elevation wording. An
operator who genuinely leads the project is unaffected — and if that genuine
lead is itself lane-limited, they are now correctly held to the lanes they
hold, which the un-narrowed path let them escape.

**The three READS are deliberately left open** — AQU-2003 priced un-elevated
platform access as read-only on our own content, not refused — and the header
now says so.

### OPS-57 — The scopes payload had no cap and no value-length bound, against a handler that does two awaited inserts per element — **FIXED** [FACT]

`putBodySchema` was `z.object({ scopes: z.array(scopeSchema) })` with
`value: z.string()`. The handler then does **per-element work, serially**: one
awaited `INSERT` per stored scope, plus one awaited `INSERT` per planned grant
inside `syncMemberLaneGrants`, against the single-writer datastore. `value` is
`TEXT` with no length constraint in the schema
(`db/postgres/schema.sql`, `project_member_scopes`), so row size was unbounded
too.

This is OPS-54's category in the place 11-09 predicted it. The convention is
already the majority: **43 of the 58** `z.array()` schemas in
`auth-worker/src/routes/` now carry a `.max()`; this was one of the fifteen
that did not.

**Verified, not theorised:** pre-fix, a `PUT` of **501** file scopes returned
**200** and wrote all 501 rows one statement at a time, and a **257**-character
value was stored verbatim. Both now answer `400 { error: "invalid scopes
payload" }` — the route's existing wording, so no new error string reaches a
client — before the handler runs. Caps are `MAX_MEMBER_SCOPES = 500` and
`MAX_SCOPE_VALUE_LENGTH = 256`, mirroring OPS-54, and both sit far above every
path the client can produce: the editor sends one scope per target lane plus
the member's existing file scopes.

**One deliberate omission, recorded because it is the kind of tightening that
looks free and is not.** `value` did **not** get a `.min(1)`. The empty string
is the **legacy default-lane tag** (AQU-1607: *"an older client still sending
`''` for the default lane keeps working"*), it is still converted to a lane id
on the way in, and `src/lib/lanes/scope-ids.ts` treats it as a real tag
throughout. A non-empty rule here would have rejected, at the schema, the exact
request the route's own header promises to keep serving — and
`member-scopes.test.ts` sends it. The new suite pins `''` as still admitted so
a later tidy-up cannot quietly take it away. [JUDGMENT, on the product call;
FACT on the behaviour]

---

## Residual risk, and what the next pass should pick up

1. **The audit gap 11-09 flagged is genuinely smaller here, and that is worth
   recording rather than repeating.** Unlike the termbase tables, **both**
   tables this route writes record an actor: `project_member_scopes.created_by`
   and `project_member_lane_roles.granted_by`, and the route populates both.
   What is still missing is an `services/admin-audit.ts` entry — `member-scopes.ts`
   is not among the five routers that write one (`projects`, `orgs`,
   `access-links`, `project-members`, `invites`) — so an *elevated* operator's
   legitimate cross-tenant scope change leaves no row in the admin audit trail,
   only an actor id on the grant itself. Smaller than OPS-53's gap; same fix if
   anyone wants it closed.
2. **A `kind: "file"` scope is stored with no check that its value names a file
   of the project** — unlike a lane scope, which is resolved against the
   project's lanes and refused when it names zero or two. Post-OPS-57 it is
   length-bounded, but still arbitrary. The blast radius is limited and points
   the safe way: `sync-worker/src/events/authorize.ts` treats file scopes as an
   **additive restriction** (*"if any 'file' scopes exist the event's fileId
   must be among them"*), so a bogus value narrows a member rather than
   widening them — a denial of their own work, not a disclosure. Reported, not
   fixed: what a file scope should mean when it names nothing is a product
   question, and the lane path is the enforced one.
3. **`knowledge.ts` is the new head of the queue** (OPS-48: 2 writes). The
   ledger carries the row, so the next pass does not need this document.
4. **OPS-55 got worse while this pass was open, and this PR's own run is the
   limit case of the bug.** [FACT] The **Adversarial Jev** comment on
   `c23e802e` reports *"No failures found."* over
   **no evidence: 11 · inconclusive: 6 · passed: 1**. One attack of eighteen
   ran. The provider 404 11-09 reported (*"Model provider returned HTTP 404; no
   action executed"*) is still unfixed nine days later, and the run also shows a
   category 11-09 did not record: eleven rows with **no evidence at all**, their
   attack names rendered as `?`.

   The rule is `smart-tests/adversarial/health.ts:63`:

   ```ts
   if (attacks.length > 0 && attacks.every((entry) =>
         entry.evidence?.outcome.verdict === "inconclusive" || !entry.evidence)) {
     return { available: false, reason: "Every attack ended inconclusive." }
   }
   ```

   Because the predicate is `every`, **one** passing attack is enough to certify
   the whole run healthy — and the one that passed, `signoff.two-reviewers`, is
   among the handful needing no model agent. So the gate's own trend is
   **3 inconclusive / 15 passed** (#1927, 11-07) → **14 / 4** (11-09) →
   **17 dark / 1 passed** (this PR, 11-16), green at every step. 11-09 called a
   partial outage "indistinguishable from a healthy run"; this run shows there
   is no floor to that at all.

   Still **reported, not fixed**, for 11-09's reasons, which this pass has no
   standing to overrule: tightening the threshold turns the job red on every
   open PR until the provider is restored, and it is not auth/session code.
   Order remains: restore the provider, *then* tighten. Note for this series in
   particular — `redteam.edit-other-project` and `redteam.viewer-wipe-file`, the
   suite's only cross-project **authorization** attacks and the ones most
   relevant to every finding in this series, are among the dark rows and have
   now not run on any commit since 11-07.
5. **Still outstanding and unchanged from earlier passes:** 10-26's audit of
   `integration_connections` / `integration_links` for rows written on platform
   authority; and the `desktop-release-signing`
   Environment's required reviewers (OPS-40).
6. **Correction — the QA-walker claim this series has repeated since 10-12 is
   stale, and this change IS exercisable on a preview.** [FACT] Every pass from
   10-12 onward has carried some form of *"platform-admin paths are not
   QA-walkable on any preview — `scripts/cloudflare-stack-preview.mjs` sets no
   `ADMIN_EMAILS` and no `platform_admins` row exists on development storage."*
   The first half is no longer true: **AQU-1353** added
   `PREVIEW_ADMIN_EMAIL = "qa-admin@local.test"` and uploads it as
   `ADMIN_EMAILS` to `aquilla-auth-preview`, precisely *"so the QA bots can walk
   /admin instead of reporting NOT CHECKED for want of a fixture."* The second
   half does not rescue the claim, because `isPlatformAdminEmail`
   (`auth-worker/src/middleware/platform-admin.ts`) is an **OR**: a
   `platform_admins` row **or** the `ADMIN_EMAILS` allowlist. No table row is
   needed.

   Previews also set `ADMIN_REQUIRE_ELEVATION: "true"`, which is the other half
   of what OPS-56 needs, so the whole finding can be walked end to end on a
   branch preview as `qa-admin@local.test`: perform the scope `PUT` on a project
   that account holds no grant on, expect
   `403 "elevation required to manage a member's lane scopes with platform-admin
   access"`, redeem the step-up code, and expect the same request to succeed.
   This pass found the stale claim by grepping the preview script while ruling
   its own change out of an unrelated CI symptom — it was never re-verified
   after AQU-1353 landed, which is the same decay OPS-52 fixed for the ledger
   and nothing yet fixes for prose.

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was applied — the series' standard decisive check.

* `auth-worker`: `src/__tests__/member-scopes-elevation.test.ts` — **16
  passing** (new file). Pre-fix: **6 failed, 10 passed**, and the six are the
  two findings:
  - `PUT /api/v2/projects/ms/members/3/scopes` with `{ scopes: [] }` returned
    **200** to an un-elevated platform admin on a tenant project they hold no
    grant on, and the walled contributor's grant rows went from `['lane-es']`
    to **every** target lane.
  - the same PUT naming a different lane returned **200** and moved a tenant
    member onto a lane the tenant had not put them on.
  - an un-elevated admin scoping **themselves** on a tenant project they are
    not a member of returned **200** and wrote scope rows — the self-edit guard
    cleared by 700-as-maintainer.
  - a lane-limited operator granting a lane they do **not** hold returned
    **200** — `lanesHeldByCaller`'s MAINTAINER+ shortcut, reached at 700.
  - the two OPS-57 cap pins (501 scopes, and a 257-char value) both returned
    **200**.

  The **10 that passed pre-fix are the controls, and still pass**: the tenant's
  own project lead performs the write; an *elevated* admin performs it and the
  widening then does happen (`['lane-es','lane-fr']`); an operator who
  genuinely leads a project in their own org grants un-elevated a lane they
  hold (the "do not lock the operator out" guard, OPS-51's lesson applied
  before it could bite); a contributor and a non-member get the byte-identical
  pre-OPS-56 wordings; the legacy `''` default-lane value is still admitted; a
  500-scope save and a 256-character value still succeed; and all three reads
  stay open to an un-elevated admin.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **22 passing** (ledger row promoted and its write-count comment corrected,
  tally updated to 17/3/32; no new assertion needed, which is OPS-52 working as
  designed). Verified the census bites: with the route fix stashed, `every
  module recorded as deciding still makes a decision` fails with
  `member-scopes.ts: NO DECISION`.
* `auth-worker`: the six neighbouring lane/scope suites together — `member-scopes`,
  `member-scopes-lane-grants`, `member-lane-assignments`, `project-lane-staffing`,
  `invite-scope-lanes`, `member-direct-add-lane-grants` — **94 passing, 0
  failures.** These are what would break if the caps or the narrowing changed
  behaviour for an ordinary lead.
* `auth-worker`: the ten elevation suites — `source-linking-elevation`,
  `merge-sibling`, `credentials`, `admin-membership-elevation`,
  `changeset-approval-elevation`, `integration-guard-elevation`,
  `admin-elevation`, `org-members-admin-elevation`,
  `agent-connect-admin-elevation`, `termbase-subscription-elevation` — **221
  passing, 0 failures.** The helper this pass reuses is unchanged, and its other
  callers are unaffected.
* Root: `npx vitest run --project app src/lib/sync/member-scopes.test.ts
  src/components/MemberLaneScopeEditor.test.tsx src/lib/lanes` — **28 files, 393
  passing, 0 failures.** The client contract did not change: the caps are above
  every path the editor can produce, and `''` still round-trips.
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28 through 11-09).
* `npx eslint` on all three changed/new files: **0 errors, 0 warnings.**
* Root `npx tsc -b --force`: **exit 0, no diagnostics** — the ledger file lives
  under `scripts/`, which `tsconfig.node.json` owns rather than `auth-worker`'s
  own `tsc`, so the auth-worker typecheck above does not cover it.
* `pnpm run check:doc-pins`: **109 pins resolve across 402 docs.**
* Full `auth-worker` suite (`npx vitest run`): **414 files, 4960 passing, 2
  expected-fail, 0 failures** (1092 s). Nothing red remains in this package to
  distinguish from the change under review — the condition that makes a suite
  run worth anything as evidence — and it is clean for the fifth pass running.
  11-09 measured 407 files / 4771 passing; the 7 new files and 189 new tests
  since include this pass's own 16, and the two expected-fails are the same two.

Environment note, for whoever re-runs this: dependencies are **not** installed
in this container at session start. Use **`pnpm install --ignore-scripts`** at
the repo root and **`pnpm install`** in `auth-worker` (it is its own pnpm
workspace root); the root install is required even for auth-worker's own suites,
because `auth-worker` imports from `../src` and `../db`. Both succeeded here in
under 15 s, which is new — 11-09 recorded `npm install` failing with `ERESOLVE`.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/member-scopes-elevation.test.ts src/__tests__/member-scopes.test.ts
src/__tests__/member-scopes-lane-grants.test.ts`._
