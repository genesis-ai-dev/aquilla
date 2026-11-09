# Operational Security Review — 2026-11-09

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-11-02.md`.
New findings continue the **OPS-n** series at **OPS-53**._

**Scope for this pass: authentication & session management** — the Monday slot.

1. **A parallel auth/session pen-test pass ran again this morning.** Commit
   `287f7250` ("[Pen test] Auth & session: reject invisible/control characters
   in new usernames") landed on `dev` at 09:10 UTC — six hours before this pass
   started — and touched `auth-worker/src/routes/auth.ts` and
   `src/__tests__/auth-routes.test.ts`. Like `cf042e21`, `87397102`, `b225cb40`,
   `7455641c5` and `12a56f19` before it, it wrote no review document, so its
   findings carry no OPS-n. **This pass therefore avoids `routes/auth.ts`
   entirely.** That is the **ninth** concurrent-pass collision the series has
   recorded, and the sixth in thirty-five days. §0's numbering note remains the
   right diagnosis and scheduling remains the fix; for the Monday slot the
   collision is simply the standing condition.

2. **This pass read what the ledger told it to read, and that is the point of
   OPS-52.** 11-02's residual-risk item 1 was *"Decide `termbase-subscriptions.ts`
   (7 writes), now the head of OPS-48's remaining eight. The ledger carries the
   queue, so this no longer depends on a document being re-read."* It did not:
   `scripts/platform-elevation-coverage.test.ts` carried the row, the row named
   the file, and this pass opened that file first rather than re-deriving a
   queue. That is OPS-53, and it is the first finding in the series located by
   the ledger rather than by a document.

3. **The finding is larger than "five more un-gated writes", for a reason
   specific to this surface.** `org_published_termbase` is not a setting. It is
   the *only* consent in the publish/subscribe design — both the subscribe route
   and `canReadTermbase` treat the flag as the upstream project's permission to
   be read — and a subscription row derives a standing read grant from it for
   every member of the subscriber project. So the two writes at the head of this
   router do not merely change rows: one forges the consent, the other mints the
   grant that rests on it.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-53 — The org-termbase router's maintainer floor is satisfied by un-elevated platform power on every project on the platform, so one principal could forge an org's termbase consent and mint a standing cross-project read from it — **FIXED** [FACT]

**The mechanism, in one line.** `resolveProjectRole` pushes
`{ source: "platform", level: 700 }` for every platform operator
(`auth-worker/src/services/project-permissions.ts`), and `ROLE.MAINTAINER` is
**600**. So in every one of the five writes in
`auth-worker/src/routes/termbase-subscriptions.ts`:

```ts
const role = await resolveProjectRole(c.env, user, projectId)
if (!role) return c.json({ error: "no access to project" }, 403)
if (role.level < ROLE.MAINTAINER) {
  return c.json({ error: "role >= maintainer (600) required" }, 403)
}
```

`700 < 600` is false. The floor was cleared by the admin contribution's own
value, on every project in every org, with no elevation asserted and no genuine
grant required.

**What the five writes are, and why two of them are not ordinary rows.**

* **`POST /:id/termbase/publish` — the consent, forged.**
  `org_published_termbase` is the whole of the upstream's permission. The
  subscribe route reads it (*"termbase is not published to this org"*), and
  `canReadTermbase` re-reads it on every read so that *"a subscription left
  dangling after an unpublish is inert — the grant evaporates the moment
  publishing stops"* (`services/org-permissions.ts`). There is no second check
  anywhere: the design deliberately performs **no `project_members` write** for
  the implicit grant (the Q19 note in the router's own header), so the flag is
  not one signal among several — it is the signal. An operator who can set it
  has published a tenant's terminology to that tenant's org on their own
  authority.
* **`POST /:id/termbase/subscriptions` — the grant, minted, and standing.**
  The row confers the Q19 implicit **viewer** read on the upstream termbase,
  derived at resolve time, with no floor above *any* role on the subscriber. So
  every viewer (100) of the subscriber project reads the upstream's whole
  termbase — source terms, every rendering in every lane, every note — for as
  long as the row lives. This is the category OPS-44 named for a PAT, OPS-49 for
  an integration link and OPS-51 for a source link, a **fourth** time: the
  artefact outlives the authority that created it, so an elevation check at use
  time can never reach it. `canReadTermbase` has no actor to check — by then the
  reader is an ordinary member of the subscriber project, which is precisely
  what the row made them.
* **`DELETE /:id/termbase/publish`** revokes the sharing for the whole org at
  once. Every subscriber's enforcement terminology disappears — silently, since
  the subscription rows survive and the listing still reports them — and no
  subscriber can restore it, because the flag lives on the upstream.
* **`PATCH /:id/termbase/subscriptions`** sets `priority`, which decides *which
  subscribed rendering wins* in the enforcement merge. A reorder rewrites what a
  project's rules say about a term without touching a rule.
* **`DELETE /:id/termbase/subscriptions/:termbaseProjectId`** removes the grant.

**Chained, the first and second are one exploit.** Publish tenant project A,
subscribe tenant project B to it, and B's members hold a permanent read of A's
terminology — both projects in an org the operator holds no membership in,
neither row recording an actor. The new suite reproduces exactly this: the
un-elevated publish returned **200** and
`SELECT org_published_termbase FROM projects WHERE id = 'tb'` came back **true**;
the un-elevated subscribe returned **200** and wrote the row; and then
`GET /api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer` as an
ordinary *contributor* of the subscriber project returned **200** instead of the
`403 { error: "no termbase read access" }` it answers with no subscription. The
grant was real, and it was reachable by someone who had never been near an
admin session.

**Why the elevation rule reaches here.** The same three arguments 11-02 used,
and they land the same way:

* **`routes/project-settings.ts` and `routes/projects.ts` are siblings on the
  same `/api/v2/projects` mount.** AQU-1322 requires elevation to remove **one**
  member or revoke **one** invite. Publishing a tenant's terminology to their
  whole org, and granting a second project a standing read of it, outranks
  removing one member.
* **AQU-2003 priced un-elevated platform access as read-only.** It re-minted the
  un-elevated platform sync token as Viewer (100) so an operator could *open*
  another tenant's project without writing to it. Flipping the org's consent
  flag is the opposite posture.
* **The series has already decided the category.** OPS-44: "paths that hand out,
  or disclose, something that OUTLIVES or ESCAPES the session." A subscription
  row is that, by the router's own design note.

**JUDGMENT, stated as such:** no evidence exists that any of this was used, and
nothing in this repo could tell us. `project_termbase_subscriptions` records no
actor and `projects.org_published_termbase` is a bare boolean with no history, so
a termbase published on platform authority is indistinguishable from one its own
maintainer published. This is a closed gap, not an incident.

**The fix.** One guard in the file — `requireTermbaseWriteRole` — at all five
write sites. It resolves the role, applies the route's own floor **first**, then
strips un-elevated platform power with `roleWithoutUnelevatedAdmin` (the OPS-44
helper) and re-applies the floor to what remains. Because the floor is checked
before narrowing, a genuine contributor and a non-member keep their
byte-identical pre-OPS-53 refusals (`"role >= maintainer (600) required"`,
`"no access to project"`); only a caller who cleared the floor on platform power
alone sees `"elevation required to <act> with platform-admin access"`. The helper
de-escalates rather than refusing on `source === "platform"`, so an operator who
genuinely maintains the project is unaffected — that is the whole reason OPS-44
built it that way.

**No `includeArchived` here, deliberately.** OPS-51 had to thread that option
because its router resolves with `resolveProjectRoleIncludingArchived`. This one
resolves with plain `resolveProjectRole`, which already answers null for an
archived project, so the narrowed genuine lookup and the original resolution
agree on the archive rule and the default opts are correct. Passing
`{ includeArchived: true }` here would have *widened* the narrowed answer
relative to the floor it re-applies — the opposite of the helper's contract.

**The upstream side needs no role check of its own**, and this is worth stating
because OPS-51 narrowed *both* sides of its link. There, the upstream's exposure
rested on a role resolution (`sourceRole`), so platform power satisfied it
directly. Here the upstream's exposure rests on the published flag, which is a
tenant decision and is now itself narrowed at the publish route. The subscribe
route only ever *reads* that flag, so there is no second resolution for platform
power to win.

**The three reads are left open on purpose**, each recorded at its guard:
`GET /:orgId/published-termbases` (an org-member listing of what the org itself
chose to publish), `GET /:id/termbase/subscriptions` (the subscription list, with
its `published` flag), and `GET /:termbaseProjectId/termbase/concepts` (which
now requires a subscription row the tenant made itself). All three stay open to
an un-elevated operator under AQU-2003, and the suite pins all three.

**Ledger.** `termbase-subscriptions.ts` moves from `undecided` to `decides`, and
the OPS-52 tally moves to **decides 14 / delegates 3 / undecided 33** — 17 of 50.
This document did not compute that; the suite did.

### OPS-54 — The subscription reorder turned an uncapped caller array into one atomic transaction of N serial statements on the shared Hyperdrive pool — **FIXED** [FACT]

Found while reading the five writes above for OPS-53, and fixed with them
because the fix is a cap.

```ts
const reorderBody = z.object({ order: z.array(z.string().min(1)) })
…
const stmts = order.map((termbaseProjectId, index) => c.env.AQUILLA_PG.prepare(…))
if (stmts.length > 0) await c.env.AQUILLA_PG.batch(stmts)
```

Neither the array nor its elements were bounded. `batch()` in
`db/shim/postgres.ts` is **not** the pipelined variant — its own comment is
*"One batch = one atomic transaction"* and its body is `for (const s of stmts)
out.push(await …)`, one awaited round trip per statement inside a single
`begin()`. So an authenticated maintainer of any project could post an array of
arbitrary length and hold one pooled Postgres connection inside an open
transaction for that many sequential Hyperdrive round trips, against a shim
whose `batchPipelined` doc records the measured cost of exactly this shape
("~21 stmts/s through Hyperdrive↔Neon — the original migrate-ingest symptom").
Nothing commits until all of them land, so the cost is paid whole.

**Why this is a finding and not a style note.** The convention is already the
repo's own: **42 of the 57** `z.array(…)` schemas in this worker's route modules
carry a `.max()` bound (on the array, its elements, or both). More pointedly,
this worker has exactly **three** `batch()` sites that build one statement per
element of a caller-supplied array, and the other two are capped — 1000 in
`routes/langquest.ts` (`upserts` / `removed`), 60 in `routes/ai-interventions.ts`
(`cells`, via `MAX_CELLS`). The remaining `batch()` calls take fixed literal
arrays (`routes/merge-sibling.ts`, `routes/orgs.ts`) or statements derived from a
server-side query (`routes/org-settings.ts`), so they carry no caller bound to
miss. This was the one array that mapped one-to-one onto statements with no
bound anywhere in the path.
`routes/member-scopes.ts` (`scopes: z.array(scopeSchema)`, no cap) is the next
one of these, and it is already the head of the remaining `undecided` queue for
OPS-53's reason too; it is noted in the ledger rather than changed here.

**The fix.** `MAX_SUBSCRIPTION_ORDER = 500` and `z.string().min(1).max(256)` per
id, so `zValidator` answers 400 before the handler runs and nothing is batched.
The bound is far above anything real: the client sends the project's own
subscription list (`src/lib/terminology/subscriptions-api.ts`), bounded by the
published termbases in one org, and the id length matches
`routes/invites.ts`'s `projectIds`.

---

## Reviewed, no new finding

* **`GET /:id/termbase/subscriptions`.** Viewer-level, and it returns the
  upstream project's `name` for a *dangling* subscription too (LEFT JOIN, no
  published/org filter), with `published: false`. The router's header comment
  claimed *"the listing hides them"* — it does not; the client does. The grant
  itself is correctly inert (`canReadTermbase` re-checks the flag), and a
  same-org project name is already visible to org members, so this is a comment
  that had drifted from its code rather than a disclosure. **The comment is
  corrected in this change**, since the block is labelled the client-facing API
  contract and is mirrored in `docs/swarm/TERM3-ORG-API.md`.
* **The double mount.** The router is mounted at both `/api/v2/orgs` (before
  `orgsRoutes`) and `/api/v2/projects` (before `projectsRoutes`), so every path
  answers under both prefixes — `POST /api/v2/orgs/:id/termbase/publish` reaches
  the same handler with the same guard, and `GET /api/v2/projects/:n/published-termbases`
  resolves `n` as an org id. Checked for shadowing in both directions: no route
  in `orgs.ts`, `org-settings.ts`, `org-access.ts`, `access-audit.ts`,
  `knowledge.ts` or `projects.ts` declares a path matching `/:param/termbase/…`
  or `/:param/published-termbases` (zero hits in each), and every duplicate path runs the same
  authorization as its intended spelling. Harmless, and the header's "the two
  path-spaces are disjoint" claim holds.
* **`POST /:id/termbase/subscriptions`'s cross-org rule.** Re-read for the
  null-org case, which is the one an org check usually gets wrong: a personal
  (`org_id IS NULL`) subscriber cannot subscribe to anything, because the
  upstream's own `org_id == null` arm refuses first and a non-null upstream fails
  the `!==` compare. Correct as-is.
* **`canReadTermbase`'s viewer floor, and AQU-626 deep links.** The Q19 grant
  needs only *some* role on the subscriber, and an access-link account
  (`routes/access-links.ts`: PIN-only credential, 90-day reusable, minted for an
  untrusted fresh browser in a diode zone, membership ensured at mint and capped
  at contributor) is an ordinary member — so it inherits a read of every upstream
  termbase the project subscribes to. That is the documented Q19 design applied
  consistently, not a gap, but it is the widest audience the grant reaches and
  it is recorded below rather than left unsaid.
* **`GET /:termbaseProjectId/termbase/concepts`.** Reads the upstream directly
  rather than round-tripping its own concepts route — deliberately, since the
  caller holds no role there — and re-applies `canReadTermbase`'s published /
  unarchived / same-org gate. No role resolution on the upstream, so platform
  power does not reach it. Correct as-is.

---

## Residual risk and operator actions

1. **Neither termbase write records an actor.** `project_termbase_subscriptions`
   has `project_id`, `termbase_project_id`, `priority`, `created_at` and no
   `created_by`; `projects.org_published_termbase` is a bare boolean with no
   history. This pass closed the gate and cannot say what went through it.
   This is 11-02's residual item 2 in a second place — *"the one control here
   that a closed gate does not provide"* — and the smallest honest fix is the
   same one: write these through `services/admin-audit.ts`, which already has
   the table.
2. **`member-scopes.ts` is the new head of the queue** (2 writes), for both of
   this pass's reasons at once: it is `undecided` in the elevation ledger, and
   its `scopes: z.array(scopeSchema)` is the next uncapped caller array that
   becomes per-element work. The ledger carries both notes, so the next pass does
   not need this document.
3. **The Q19 grant's floor is a product decision, not a bug.** A viewer of a
   subscriber project — including an AQU-626 deep-link account provisioned for an
   untrusted browser — reads the upstream termbase in full. If any org wants
   termbase reads held to a higher floor than project membership, that is a
   setting to add beside `rosterViewMinRole` / `exportMinRole`, not a patch.
4. **Still outstanding and unchanged from earlier passes:** 10-26's audit of
   `integration_connections` / `integration_links` for rows written on platform
   authority; the QA-walker identity question 10-12 left open (platform-admin
   paths are not QA-walkable on any preview — `scripts/cloudflare-stack-preview.mjs`
   sets no `ADMIN_EMAILS` and no `platform_admins` row exists on development
   storage, so this change is one more thing a preview cannot exercise); and the
   `desktop-release-signing` Environment's required reviewers (OPS-40).

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was applied — the series' standard decisive check.

* `auth-worker`: `src/__tests__/termbase-subscription-elevation.test.ts` —
  **23 passing** (new file). Pre-fix: **8 failed, 15 passed**, and the eight are
  the finding:
  - `POST /api/v2/projects/tb/termbase/publish` returned **200** to an
    un-elevated platform admin on a tenant project they hold no grant on, and
    `org_published_termbase` was **true** afterwards.
  - `DELETE /api/v2/projects/tb/termbase/publish` returned **200** and
    un-published a termbase the tenant's own owner had published.
  - `POST /api/v2/projects/consumer/termbase/subscriptions` returned **200** and
    wrote the row, across two projects in a tenant org.
  - and then the chained read: an ordinary **contributor** of the subscriber
    project got **200** from
    `GET /api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer`
    instead of `403 { error: "no termbase read access" }` — the Q19 grant the
    refused write would have minted, exercised by someone with no admin access
    at all. This is the one that makes the finding a disclosure rather than a
    tampering.
  - `DELETE …/subscriptions/tb` and `PATCH …/subscriptions` each got past their
    floor.
  - the two OPS-54 cap pins (501 ids, and a 257-char id) both returned **200**.

  The **15 that passed pre-fix are the controls, and still pass**: the tenant's
  own maintainer performs all five writes; every elevated path is restored; an
  operator who genuinely maintains a project in their own org publishes and
  subscribes it un-elevated (the "do not lock the operator out" guard, OPS-51's
  lesson applied before it could bite); a contributor and a non-member get the
  byte-identical pre-OPS-53 wordings; all three reads stay open to an
  un-elevated admin; and a 500-id reorder still succeeds.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **22 passing** (ledger row promoted, tally updated; no new assertion needed,
  which is OPS-52 working as designed). Verified the census bites: with the route
  fix stashed, `every module recorded as deciding still makes a decision` fails
  with `termbase-subscriptions.ts: NO DECISION`.
* `auth-worker`: all four `termbase-*` suites together — **55 passing, 0
  failures** (`termbase-subscriptions`, `termbase-subscription-gate`,
  `termbase-subscribed-concepts`, and the new file).
* `auth-worker`: the nine elevation suites — `source-linking-elevation`,
  `merge-sibling`, `credentials`, `admin-membership-elevation`,
  `changeset-approval-elevation`, `integration-guard-elevation`,
  `admin-elevation`, `org-members-admin-elevation`,
  `agent-connect-admin-elevation` — **189 passing, 0 failures.** The helper this
  pass reuses is unchanged, and its other callers are unaffected.
* Root: `npx vitest run --project app src/lib/terminology` — **312 passing, 0
  failures** across 20 files. The client contract did not change: the cap is
  above every path the client can produce.
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28 through 11-02).
* `npx eslint` on all three changed/new files: **0 errors, 0 warnings.**
* Full `auth-worker` suite (`npx vitest run`): see the note appended below.

Environment note, for whoever re-runs this: **no dependencies were installed in
this container at session start**, and `npm install` in `auth-worker` now fails
with `ERESOLVE` — use **`pnpm install`** there (it is its own pnpm workspace
root). The repo root needs `pnpm install --ignore-scripts`, and the root install
is required even for auth-worker's own suites, because `auth-worker` imports from
`../src` and `../db`. The `npm`→`pnpm` detail is new since 10-26.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/termbase-subscription-elevation.test.ts
src/__tests__/termbase-subscriptions.test.ts
src/__tests__/termbase-subscription-gate.test.ts
src/__tests__/termbase-subscribed-concepts.test.ts`._
