# Operational Security Review — 2026-11-23

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-11-16.md`.
New findings continue the **OPS-n** series at **OPS-58**._

**Scope for this pass: authentication & session management** — the Monday slot.

1. **Three concurrent pen-test passes landed since 11-16, and for once none of
   them collides with this one.** [FACT] `be5c0aa9` and `ef841e5c` (11-17,
   Authorization) touched `routes/orgs.ts`, `routes/projects.ts` and
   `services/user-lookup.ts`; `a63c8af5` (11-19, API security & data exposure)
   touched no route module at all. None wrote a review document, so as with the
   eleven before them their findings carry no OPS-n — that part of §0's
   diagnosis is unchanged, and this is now the **thirteenth, fourteenth and
   fifteenth** such pass. What is different is that the ledger pointed this
   pass at `knowledge.ts`, which none of them opened, so for the first time
   since 09-07 no file had to be avoided. That is the scheduling fix §0 asked
   for arriving by accident: **a queue that names the next file is also a
   collision-avoidance mechanism**, because two passes reading the same ledger
   take different rows rather than the same obvious route.

   `knowledge.ts` itself was last written on 11-19 by AQU-2594 (`04f0afc5`,
   `8e0fc81d` — the 25 MB upload cap and the truncation notice), which is
   ordinary feature work, not an auth pass; this change builds on it and the
   new suite exercises the post-AQU-2594 upload path.

2. **This pass read what the ledger told it to read — the third finding in the
   series located that way, and the ledger's own ranking was wrong.** 11-16
   left `knowledge.ts` as the head of the undecided queue, annotated
   *"OPS-48: 2 writes"*. It is **six** writes, across **two** routers: the
   project router and the org router each carry upload / delete / reindex,
   behind two different floors (`ROLE.PROJECT_LEAD` 500 and `ROLE.MAINTAINER`
   600) resolved by two different resolvers (`resolveProjectRole` and
   `getEffectiveOrgRole`). OPS-48 counted the project router only. The ledger
   row is corrected in this change, as 11-16 corrected its own.

3. **One finding came from running the fix's own test, not from reading code,
   and it is the transferable one.** The reproduction for OPS-58 seeded a live
   downstream project so the propagation amplifier could be asserted. That
   test made `propagateKnowledgeDocs` run for the first time in any suite in
   this repo with a **real uploader** rather than a numeric fixture id — and
   it immediately printed `invalid input syntax for type bigint: "tenant-lead"`
   to stderr, on the happy path, for the tenant's own legitimate upload.
   OPS-59 is that: a write that has been failing silently in production on
   every knowledge-doc propagation since the feature shipped. **A security
   test that seeds a realistic actor finds correctness bugs that a security
   review reading the same file does not** — nothing in `knowledge.ts` or
   `inherited-settings.ts` looks wrong when read; the types agree, and the
   failure is a runtime cast inside a `catch` that logs and returns `false`.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-58 — Six un-elevated writes plant, destroy and re-index knowledge-base documents on any project and any org on the platform — and the planted document copies itself across tenant boundaries — **FIXED** [FACT]

**The mechanism, in one line.** `resolveProjectRole` pushes
`{ source: "platform", level: 700 }` for every platform operator
(`auth-worker/src/services/project-permissions.ts`) and `getEffectiveOrgRole`
returns `Math.max(membership ?? 0, 700)` for the same principal
(`auth-worker/src/services/org-permissions.ts`). `ROLE.PROJECT_LEAD` is **500**
and `ROLE.MAINTAINER` is **600** (`auth-worker/src/types.ts`). So in
`auth-worker/src/routes/knowledge.ts` both gates:

```ts
if (!role || role.level < floor) { … 403 … }   // requireRole
if (role == null || role < floor) { … 403 … }  // requireOrgRole
```

were cleared by the admin contribution's own value, on every project in every
org, with no elevation asserted and no genuine grant required. Six routes sat
behind them:

| Router | Route | Floor |
|---|---|---|
| project | `POST /:projectId/knowledge` | PROJECT_LEAD (500) |
| project | `DELETE /:projectId/knowledge/:docId` | PROJECT_LEAD (500) |
| project | `POST /:projectId/knowledge/:docId/reindex` | PROJECT_LEAD (500) |
| org | `POST /:orgId/knowledge` | MAINTAINER (600) |
| org | `DELETE /:orgId/knowledge/:docId` | MAINTAINER (600) |
| org | `POST /:orgId/knowledge/:docId/reindex` | MAINTAINER (600) |

**Why this is not "six more un-gated writes".** Three reasons, and the second
is the one that makes this finding different from its five predecessors.

* **A knowledge doc is retrieved content, not a setting.** The upload's text
  lands in `knowledge_docs.extracted_text` and comes back out through
  `searchKnowledge` (`db/shared/knowledge.ts`) and the section-tree reads.
  `extractStyleRulesFromDoc` (`src/lib/rules/style-rule-extractor.ts`) then
  feeds those sections to a completion whose job is to *"extract every concrete
  rule, convention, or constraint a translator (or an AI drafting assistant)
  should follow"*, and the caller posts the survivors as `proposed` rules with
  `source: { kind: "knowledge-doc", docId, nodeId, quote }`. An operator who
  can plant a document plants text the tenant's own tooling later reads back as
  the team's own guidance. [FACT for the pipeline; **JUDGMENT** that a planted
  document is a practical route to influencing drafted output — the extraction
  is human-initiated from a dialog and its candidates are reviewed, so this is
  a weakened channel, not a direct one.]

* **The document replicates itself across tenant boundaries, and revoking the
  operator reaches none of the copies.** Both writes call
  `propagateKnowledgeDocs` (`db/shared/inherited-settings.ts`), which walks
  `listLiveDownstreams`:

  ```sql
  SELECT id, source_link_consumes, source_link_lane_id
    FROM projects
   WHERE source_project_id = ? AND source_link_mode = 'live'
  ```

  — **no org predicate** — and `syncKnowledgeDocs` copies the row *and its R2
  blob* into every receiving downstream, then recurses to `MAX_CHAIN = 16`. One
  `POST` therefore lands rows and blobs in projects belonging to orgs the
  operator never named and holds no grant on. This is the category OPS-44 named
  for a PAT, OPS-49 for an integration link, OPS-51 for a source link, OPS-53
  for a termbase subscription and OPS-56 for a lane grant, a **sixth** time —
  and the first where the artefact **makes copies of itself**, so an elevation
  check at use time cannot reach it and neither can deleting the original.

* **The DELETE is irreversible and takes the only copy of the bytes.**
  `handleDelete` drops the row, then `await bucket.delete(meta.r2Key)` destroys
  the original upload — a style guide, a licensing agreement, a consultant's
  notes — and propagation then removes the downstream copies too. There is no
  trash and no undo on this path.

**The fix.** Platform power is stripped unless the session is elevated, then
each route's own floor is re-applied to what genuinely remains — the OPS-53 /
OPS-56 shape, in two gates rather than one because this file has two resolvers:

```ts
const effective = await roleWithoutUnelevatedAdmin(c, user, projectId, role)
if (!effective || effective.level < floor) { … 403 "elevation required to …" … }
```

```ts
const effective = await orgLevelWithoutUnelevatedAdmin(c, orgId, user, gate.role)
if (effective == null || effective < floor) { … 403 "elevation required to …" … }
```

Both gates check the **genuine floor first**, so a contributor's refusal is
byte-identical to the pre-OPS-58 wording and only the operator sees the new
message. An operator who genuinely leads the project — or genuinely maintains
the org — is unaffected, which both controls pin.

**The reads are deliberately left open**, on `requireRole` / `requireOrgRole`
as before. AQU-2003 priced un-elevated platform access as read-only on our own
content rather than refused, and 11-09 and 11-16 left their reads open on the
same grounds. This pass does not overrule that, but **records the disagreement
for whoever revisits it**: the project read floor is VIEWER and the org read
floor is `0`, and what those routes return is not metadata — it is
`/:docId/original`, the tenant's uploaded file, served whole from R2. Of every
read surface this series has waved through, this is the one that most resembles
document exfiltration rather than operator support. Deciding it is a product
call about what platform support is for, not a patch. **[JUDGMENT]**

---

### OPS-59 — Every knowledge-doc propagation has been failing its bookkeeping write since the feature shipped, so an upstream delete never reaches the copies it made in other orgs — **FIXED** [FACT]

**The mechanism.** `project_settings.updated_by` is `BIGINT`
(`db/postgres/schema.sql`), and `UpdateProjectSettingsInput.updatedBy`
documents itself as *"Writer's user id (numeric, or its string form)"*
(`db/shared/projects.ts`). But `handleUpload` builds its actor as

```ts
return handleUpload(c, { projectId }, user.username ?? String(user.id))
```

— a **username**, correctly, because it feeds the `TEXT`
`knowledge_docs.created_by` column — and then forwarded that same value as
`updatedBy` into `propagateKnowledgeDocs`. `handleDelete` did the same with
`meta.createdBy`, and `lib/knowledge/index-doc.ts` with `doc.meta.createdBy`.

Postgres answers `22P02 invalid input syntax for type bigint: "tenant-lead"`.
`writeDownstreamSettings` catches it, returns `false` after both attempts, and
`syncKnowledgeDocs` returns having already inserted the copy rows — so the
`knowledgeDocCopies` map, which is written in that same final settings write,
was **never persisted**. Two consequences, both reproduced:

1. **An upstream delete never reached a downstream copy.** The delete arm
   iterates exactly that map:

   ```ts
   for (const [upstreamId, downstreamId] of Object.entries(copies)) {
     if (seen.has(upstreamId)) continue
     const removed = await db.prepare(
       `DELETE FROM knowledge_docs WHERE id = ? AND project_id = ? RETURNING r2_key`)
   ```

   An empty map deletes nothing. A document a tenant deleted — the operation a
   user performs *because* the document should not exist any more — lived on
   indefinitely in every downstream project, which per OPS-58's second bullet
   can be in another org, with its R2 blob. That is a data-retention failure
   across a tenant boundary, and it is why this is in an OPSEC review rather
   than filed as a bug.

2. **Every propagation re-copied every upstream doc as a new row.** With no map
   to consult, `syncKnowledgeDocs` takes the `existingId`-absent arm every
   time: a fresh `crypto.randomUUID()`, a fresh R2 key, a fresh `copyBlob`. The
   duplicates accumulate in the downstream's document list, its search results
   and its R2 usage, with no bound other than how often the upstream is
   written.

**A trap inside that fix, worth recording because it is the same failure mode
one level up.** [FACT] The obvious patch is `updatedBy: c.get("user").id`. It
is wrong: `handleUpload` is **shared** with `routes/knowledge-internal.ts`, the
shared-secret server-to-server route behind the external Agent API's
`/knowledge` surface, which runs no `authMiddleware` at all and names its
principal in an `x-acting-user-id` header. There `c.get("user")` is
`undefined`, so the patch throws — **inside the same `try/catch` that logs
`[inherited-settings] knowledge propagate failed` and moves on.** The route
still answers `201`, every existing `knowledge-internal` test still passes, and
the propagation silently stops: the identical shape as the bug being fixed,
introduced by the fix. `propagationWriterId` therefore reads the session when
there is one and the acting-user header when there is not, and the new suite
pins the internal path explicitly — asserting **before** the background indexer
settles, because the indexer's own later propagate repairs the bookkeeping and
would otherwise mask the regression. Confirmed by reverting the helper to the
naive form: the pin fails, and the whole-suite result does not change.

**The fix.** The call sites in `routes/knowledge.ts` now resolve a numeric
writer for the bookkeeping write, keeping the username for
`knowledge_docs.created_by` where it belongs — and on the delete path the actor
performing the deletion is the more correct attribution anyway. Under them,
`writeDownstreamSettings` coerces: `settingsWriterId` accepts a number or
its string form and yields `null` otherwise, and `updatedBy` is widened to
`number | string | null` through the propagation module and in
`UpdateProjectSettingsInput` — and, for consistency, in its sibling
`PatchProjectSettingsInput`, which describes the same nullable column and whose
callers all pass a real id today. The column is a nullable BIGINT, so a caller that
still gets it wrong — such as the background indexer at
`lib/knowledge/index-doc.ts`, which has only the username in hand — now loses
the *attribution* rather than the *write*. Failing closed on attribution and
open on the write is the right way round here: the map is what deletion
correctness depends on.

---

## Residuals

1. **A check-then-act race between the two propagation calls, reported not
   fixed.** [FACT, reproduced] `handleUpload` calls `propagateKnowledgeDocs`
   itself, and the background indexer calls it again from
   `lib/knowledge/index-doc.ts` once the model round-trip finishes. Each does
   load-settings → insert-copy → write-settings with an optimistic version
   guard on the last step only, so two that overlap both insert before either
   records the map, and one copy is orphaned. In this harness they land in the
   same tick and the duplicate is reliable; in production they are a model
   round-trip apart, so the second finds the map OPS-59 now persists and
   updates in place. The new suite therefore asserts the map and the
   direction of the row count rather than an exact `0`, and says so at the
   assertion. Fixing it properly means making the copy insert and the map
   write one atomic step, which is a redesign of `syncKnowledgeDocs`, not a
   same-day patch — the OPS-24 and OPS-32 precedent for reporting a race with
   its mechanics traced rather than patching it badly.
2. **`_contextual-helpers.ts` carries its own `requireRole`** with the same
   shape this pass just fixed in `knowledge.ts` — `resolveProjectRole`, a
   floor compare, no elevation symbol anywhere in the file — and is
   `undecided` in the ledger. **Five** route modules import from it. [FACT] It is a shared helper rather than a router, so promoting it is a
   bigger decision than one route's floor: whoever takes it should establish
   whether its callers want the read/write split OPS-58 drew here.
   `team-handoffs.ts` is the new nominal head of the ledger queue (1 write),
   but `_contextual-helpers.ts` is the one with leverage.
3. **The org knowledge read floor is literally `0`** —
   `requireOrgRole(c, orgId, 0)`, so `role < 0` is unreachable for any
   resolvable membership. Any org member of any level reads every org
   knowledge document including `/original`. That is probably intended (org
   docs are org-wide by design) but it is a floor written as a number that
   can never bite, which is the shape that survives a later refactor by
   accident. Worth an explicit constant. **[JUDGMENT]**
4. **This change IS walkable on a branch preview, and the route to walk it is
   short.** [FACT] `scripts/cloudflare-stack-preview.mjs` still sets
   `ADMIN_EMAILS = "qa-admin@local.test"` (AQU-1353) and
   `ADMIN_REQUIRE_ELEVATION: "true"` on `aquilla-auth-preview`, and
   `isPlatformAdminEmail` is an OR over the allowlist and the `platform_admins`
   table, so no table row is needed — the correction 11-16 made to the
   series' long-stale "not QA-walkable" claim still holds at this commit. As
   `qa-admin@local.test`, on a project that account holds no grant on:
   `POST /api/v2/projects/:id/knowledge` should answer **403 "elevation
   required to upload a knowledge document to a project with platform-admin
   access"**; redeem the step-up code and the same upload should succeed. The
   org router is the same walk against `/api/v2/orgs/:id/knowledge` with the
   org wording. Nothing here crosses the sync->auth seam, so the preview
   limitation in `docs/DEPLOYMENT-ENVIRONMENTS.md` does not apply to this
   change.
5. **Still outstanding and unchanged from earlier passes:** 10-26's audit of
   `integration_connections` / `integration_links` for rows written on platform
   authority; the `desktop-release-signing` Environment's required reviewers
   (OPS-40).

6. **OPS-55 has reversed, and this PR's own run is the evidence.** [FACT] Every
   pass since 11-07 has carried some form of *"the adversarial gate is green
   while its attacks are dark"*, worsening from **3 inconclusive / 15 passed**
   (11-07) to **14 / 4** (11-09) to **17 dark / 1 passed** (11-16). The
   Adversarial Jev run on this change's own head (`4bb78e8e`, run
   45208146214) reports **no evidence: 1 · inconclusive: 3 · passed: 14** —
   and, directly to the point of this series, **both cross-project
   authorization attacks ran and passed**: `redteam.edit-other-project` and
   `redteam.viewer-wipe-file`, which 11-09 and 11-16 recorded as not having
   run on any commit since 11-07.

   **The provider is NOT restored, and this pass nearly said it was.** The
   first draft of this section read *"the provider outage is evidently over,
   so tightening the threshold is now cheap."* Forty minutes later the **next**
   commit on this same branch — `d6e2199a`, a **documentation-only** change
   with no code in it at all — came back **HARNESS UNAVAILABLE, canary health
   check failed (2 of 2)**, and took the `pr` check red with it (run
   45216519763). The next commit after *that* — `13120da4`, documentation
   only again — came back **16 passed, 2 inconclusive, nothing dark** (run
   45218649841), and the `pr` check went green with it.

   So the three runs this PR happened to trigger, all within 55 minutes, on a
   branch whose only changes between them were prose:

   | Head | Time (UTC) | Result |
   |---|---|---|
   | `4bb78e8e` | 15:56 | 14 passed · 3 inconclusive · 1 no-evidence |
   | `d6e2199a` | 16:36 | **HARNESS UNAVAILABLE** (canary 2 of 2) |
   | `13120da4` | 16:49 | 16 passed · 2 inconclusive |

   The provider is **flapping**, not recovered and not down — and a single
   green run is not evidence that it recovered, which is the same error in
   miniature that OPS-55 is about, made here by this pass and caught only
   because a docs commit happened to re-trigger the suite. Three runs are a
   small sample and they are only the ones this PR caused; the point is the
   variance, not the ratio.

   **What that costs the recommendation.** "Tighten the threshold now" was
   wrong for exactly the reason 11-09 and 11-16 gave: with a flapping
   provider, a stricter gate turns PRs red unpredictably, on infrastructure
   rather than on their diffs. The order they set stands unchanged — **restore
   the provider, then tighten** — and "restored" has to mean a run of runs,
   not one. Flapping also reframes the remediation: the question is not
   *"is the provider back up"* but *"why does it fail two runs in three
   minutes apart"*, which is a reliability question for whoever owns that
   integration, not a threshold question.

   **What does survive, and it is worth having.** Those 14 passes were real
   and they were against *this* change: `redteam.edit-other-project` and
   `redteam.viewer-wipe-file`, the suite's only cross-project authorization
   attacks and the two most relevant to every finding in this series, ran
   green on `4bb78e8e`. That is positive adversarial evidence for OPS-58
   specifically, and the first such evidence any pass in this series has had
   since 11-07.

   **And one refinement to OPS-55 itself.** [FACT] The `d6e2199a` run reported
   **HARNESS UNAVAILABLE** rather than going green — so a *total* outage is
   caught correctly, by the canary check, on a different code path from the
   `attacks.every(…)` predicate. OPS-55's flaw is therefore narrower than the
   series has been stating it: it is about **partial** outages, where some
   attacks return and the `every` predicate lets one passing attack certify
   the rest, not about the harness being wholly down. That makes the finding
   more precise, not less serious — a partial outage is the harder case to
   notice, and it is the one the gate still mishandles.

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before
the fix was applied — the series' standard decisive check.

* `auth-worker`: `src/__tests__/knowledge-elevation.test.ts` — **22 passing**
  (new file). Pre-fix (source changes stashed, suite unchanged): **8 failed, 13
  passed**, and the eight are the two findings:
  - `POST /api/v2/projects/kb/knowledge` returned **201** to an un-elevated
    platform admin on a tenant project they hold no grant on;
  - the same upload with a live downstream seeded landed the document in the
    other org's project as well;
  - `DELETE /api/v2/projects/kb/knowledge/:docId` returned **200** and removed
    the R2 original;
  - `POST …/reindex` returned **202**;
  - all three org-router writes returned **201 / 200 / 202** on a tenant org;
  - and the OPS-59 assertion: `knowledgeDocCopies` was `{}` after a
    legitimate tenant upload where it should name the copy.

  (The 22nd assertion is the `knowledge-internal` pin described under OPS-59;
  it is a pin on the fix rather than on the finding, so it is not among the
  eight and passes pre-fix.)

  The **13 that passed pre-fix are the controls, and still pass**: the tenant's
  own project lead uploads, deletes and reindexes; the tenant org's own owner
  uploads; an operator who genuinely leads their own org's project uploads
  un-elevated, and one who genuinely maintains their own org does too (the "do
  not lock the operator out" guard, OPS-51's lesson applied before it could
  bite); a contributor gets the byte-identical pre-OPS-58 wording; an
  *elevated* admin is admitted on both routers and the write then does happen;
  and all five project reads plus both org reads stay open to an un-elevated
  admin.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **22 passing** (ledger row promoted, its write-count comment corrected from
  2 to 6, tally updated to 18/3/31). Verified the census bites: with the route
  fix stashed, `every module recorded as deciding still makes a decision` fails
  with `knowledge.ts: NO DECISION`.
* `auth-worker`: the four neighbouring knowledge suites — `knowledge-routes`,
  `knowledge-shared`, `knowledge-internal`, `knowledge-gate` — **44 passing, 0
  failures.** These are what would break if the gates changed behaviour for an
  ordinary lead or an org maintainer.
* `auth-worker`: the eleven elevation suites — `source-linking-elevation`,
  `merge-sibling`, `credentials`, `admin-membership-elevation`,
  `changeset-approval-elevation`, `integration-guard-elevation`,
  `admin-elevation`, `org-members-admin-elevation`,
  `agent-connect-admin-elevation`, `termbase-subscription-elevation`,
  `member-scopes-elevation` — **237 passing, 0 failures.** The two helpers this
  pass reuses are unchanged and their other callers are unaffected.
* `auth-worker`: the suites over the shared propagation module OPS-59 touches —
  `inherited-settings`, `access-attacks-inheritance`, `project-settings` —
  **19 passing, 2 expected-fail**, the same two the series has recorded since
  09-28; and all **18** `source-linking-*` suites — **137 passing, 0
  failures** — which are the heaviest users of `writeDownstreamSettings` and
  the real test of widening `updatedBy`.
* Root: `npx vitest run --project app src/lib/sync/inherited-settings.test.ts`
  — **5 passing.**
* `sync-worker`: `external-patch-settings`, `commands-patch-settings-validate`
  and `external-project-setup` — **111 passing, 0 failures** (243 s). This
  package is the *other* consumer of the two `db/shared` files OPS-59 touches,
  and `updateProjectSettingsShared` is on its external-command write path, so
  widening `updatedBy` had to be shown safe here and not only in `auth-worker`.
  `npm install` in `sync-worker` succeeds in this container (80 packages); note
  that it rewrites `package-lock.json`, which is an environment artefact and
  should not be committed.
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28 through 11-16).
* Root `npx tsc -b --force`: **exit 0, no diagnostics** — this pass changes
  `db/shared/projects.ts` and `db/shared/inherited-settings.ts`, which the SPA
  compiles and `auth-worker`'s own `tsc` does not fully cover, so this check is
  load-bearing here rather than a formality.
* `npx eslint` on all five changed/new files: **0 errors, 0 warnings.**
* `pnpm run check:doc-pins`: **190 pins resolve across 417 docs.**
* Full `auth-worker` suite (`npx vitest run`): **420 files, 5105 passing, 2
  expected-fail, 0 failures** (1551 s). Nothing red remains in this package to
  distinguish from the change under review — the condition that makes a suite
  run worth anything as evidence — and it is clean for the sixth pass running.
  11-16 measured 414 files / 4960 passing; the 6 new files and 145 new tests
  since include this pass's own 22, and the two expected-fails are the same
  two.
* **CI on the PR head** (`4bb78e8e`, PR #2173): **all 15 checks green**, PR
  `mergeable_state: clean`. That includes `auth-worker-tests`, `lint`,
  `sync-worker-tests`, `agent-worker-tests` and all three `unit` shards, run
  in a clean container rather than this one — which is the stronger form of
  the two suite runs above. Note for whoever repeats this: a docs-only push
  while CI is mid-run **cancels** the in-flight jobs (it cancelled eight on
  the previous head here), so batch documentation fixes rather than pushing
  them one at a time against a running gate.

Environment note, for whoever re-runs this: dependencies are **not** installed
in this container at session start. Use **`pnpm install --ignore-scripts`** at
the repo root and **`pnpm install`** in `auth-worker` (it is its own pnpm
workspace root); the root install is required even for auth-worker's own
suites, because `auth-worker` imports from `../src` and `../db`. Both succeeded
here, as on 11-16.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/knowledge-elevation.test.ts src/__tests__/knowledge-routes.test.ts
src/__tests__/inherited-settings.test.ts`._
