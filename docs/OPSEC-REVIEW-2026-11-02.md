# Operational Security Review — 2026-11-02

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-10-26.md`.
New findings continue the **OPS-n** series at **OPS-51**._

**Scope for this pass: authentication & session management** — the Monday slot.

1. **A parallel auth/session pen-test pass ran again this morning.** Commit
   `cf042e21` ("[Pen test] Auth & session: close reset-request timing oracle,
   share login lockout across username/email, cap PATCH /me preferences")
   landed on `dev` at 09:12 UTC — seven hours before this pass started — and
   touched `auth-worker/src/routes/auth.ts` and the `/me` handler. Like
   `87397102`, `b225cb40`, `7455641c5` and `12a56f19` before it, it wrote no
   review document, so its findings carry no OPS-n. **This pass therefore
   avoids `routes/auth.ts` and the `/me` surface.** That is the **eighth**
   concurrent-pass collision the series has recorded, and the fifth in
   twenty-eight days. §0's numbering note remains the right diagnosis and
   scheduling remains the fix; for the Monday slot the collision is simply the
   standing condition.

2. **10-26 named what to read next, and it was the right call for a reason it
   did not state.** OPS-48's remaining eight were ranked by write count, led by
   `source-linking.ts` (14 writes), and 10-26's residual-risk list made it item
   2: *"it changes a project's structure."* It does — but the finding is not in
   any of those fourteen writes' shapes. It is in the one route on that router
   whose floor is **OWNER**, which is the level the platform contribution
   itself is, so the strictest gate on the router is the one that cannot hold.
   That is OPS-51.

3. **The third item on that list is the one that stops this ledger decaying.**
   OPS-50 §1 asked for the elevation census to become "an assertion that fails
   when a new undecided module appears" rather than a number re-derived by hand
   each pass. That is OPS-52, and it is why this document reports a count it did
   not compute itself.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-51 — An owner-only gate that every platform admin passes by definition, in front of an unrecoverable project delete — and the cross-tenant link IDOR an earlier pen test closed, reopened for one principal and made permanent — **FIXED** [FACT]

**The mechanism, in one line.** `roleFromGrantPaths` pushes
`{ source: "platform", level: 700 }` for every platform operator
(`auth-worker/src/services/project-permissions.ts:348-350`), and
`ROLE.OWNER` is **700**. So in `routes/source-linking.ts`:

```ts
if (role.level < ROLE.OWNER) {
  return c.json({ error: "only owners can delete a project" }, 403)
}
```

`700 < 700` is false. The strictest floor on the router is not a floor at all
for a platform admin — it is satisfied by the admin contribution's own value,
on every project in every org on the platform, with no elevation asserted. What
sits behind it is `DELETE FROM projects WHERE id = ?` with every cell, event,
file, comment and audio row cascading after it. There is no Trash step and no
undo: `POST /:projectId/archive` is the reversible operation, in the *other*
router.

**Why this is not "one more un-gated write".** Three things in the repo already
decided it, each of them louder than the last:

* **`routes/projects.ts` is the sibling router on the same mount.** Both are
  `app.route("/api/v2/projects", …)` (`auth-worker/src/index.ts:338-343`).
  That one calls `projectElevationDenial` at six sites — to remove **one**
  member, to revoke **one** invite, to delete **one** file (AQU-1322). Deleting
  the entire project, from the file next door, asked for nothing.
* **`routes/merge-sibling.ts` wrote down the rule that settles it.** OPS-44's
  own comment: *"folding is irreversible and cross-tenant … AQU-1322 already
  requires elevation to add one member to one project; destroying a donor
  project outranks that."* The fold is gated on both sides. The route that
  destroys a project outright, without a donor and without a host, was not.
* **AQU-2003 priced un-elevated platform access as read-only.** It re-minted
  the un-elevated platform sync token as Viewer (100) specifically so an
  operator could *open* another tenant's project without writing to it. A
  hard delete is the furthest thing from that posture that exists in the
  product.

**The second half: the link IDOR, restored and made standing.**
`POST /:projectId/link-source` carries an explicit cross-tenant check with the
exploit spelled out in its own comment (`routes/source-linking.ts`, the
`[Pen test] AQU authz review` block):

> *without this check, any user who owns (or leads) some project of their own —
> trivially true for every authenticated user, since creating a project grants
> owner (700) — could link it to ANY other project id on the platform and
> clone/mirror its source cells, with no membership, invite, or interaction
> from the target project.*

`src/__tests__/source-linking-idor.test.ts` is that exploit, closed. Platform
power satisfies the check it installed — on **both** the downstream and the
upstream side, since the same resolver answers 700 for both — which is the same
IDOR, available to one principal, un-elevated. And it does not stay a single
write:

* **A live link is a standing data flow.** The sync-worker mirror keeps
  replaying the upstream's source cells into the downstream indefinitely. An
  elevation check at *use* time can never reach it, because by then the writer
  is the mirror, not a session. This is the shape OPS-44 named for a PAT and
  OPS-49 named for an integration link, a third time: the artefact outlives the
  authority that created it.
* **It runs in both directions.** Link a tenant's project to an attacker-chosen
  upstream and their source text is overwritten — with `replaceFiles` (AQU-1679)
  onto their *existing* file ids, so every translation, validation and comment
  stays attached to text that was swapped underneath it. Link an
  operator-controlled project to a tenant's project as upstream and that
  tenant's content mirrors out, continuously.
* **The lane wall came with it.** `resolveUpstreamLinkLane` gates which upstream
  lane a link may follow on `upstreamRole`, which was `sourceRole.level` — 700.
  The read wall `visibleTagsForMember` enforces was therefore open too.

**JUDGMENT, stated as such:** no evidence exists that any of this was used, and
nothing in this repo could tell us. `projects` has no delete audit and the link
columns record no actor. This is a closed gap, not an incident.

**The fix.** The six **writes** strip platform power unless the session is
elevated and re-apply their own floor to what remains —
`roleWithoutUnelevatedAdmin` from `services/elevation-gate.ts`, the OPS-44
helper, at seven call sites (`link-source` and `link-source/files` narrow both
the downstream and the upstream side; `link-source/files/stop`,
`detach-source` and `DELETE` narrow the one side they touch). An operator who
genuinely leads or owns the project is unaffected, which is the whole reason
the helper de-escalates rather than refusing on `source === "platform"`.

The three **reads** are left open on purpose, each recorded at its own guard:
`GET /:projectId/downstreams` (no floor of its own, and the warning surface the
delete's confirm dialog depends on — gating it would tell an operator "this has
downstreams" only *after* they elevated, inverting the order the dialog exists
for), `GET /:projectId/link-source/files`, and
`POST /:projectId/link-source/match` (a POST that writes nothing; its answer is
line counts over content AQU-2003 already lets an un-elevated operator read).

**One sharp edge the fix had to avoid.** `resolveGenuineProjectRole` returns
null for an archived project. This router resolves with
`resolveProjectRoleIncludingArchived` on purpose — an owner still owns a
trashed project — and a platform admin who *genuinely* owns a project resolves
`source: "platform"` anyway, because 700 outranks their real grant. So the
naive narrowing would have answered null for an operator deleting their **own
project out of their own Trash** and locked them out of it: a fix that protects
other tenants by breaking the operator's own most ordinary action. Both helpers
now take `{ includeArchived }`, threaded only from the call sites that resolved
that way; every pre-existing caller is byte-identical. The regression is pinned
directly (*"does not lock an operator out of their own TRASHED project"*).

### OPS-52 — The elevation census is now an assertion, so the next refactor that moves an authorization decision cannot move it out of view — **FIXED** [FACT]

OPS-45 counted how many auth-worker route modules make an elevation decision
(8 of 44). OPS-48 split their writes from their reads and ranked what to decide
next. OPS-50 then found the method's own blind spot: when AQU-804 hoisted
Monday's guards into a shared helper, *"a module that delegates its
authorization to a helper resolves no role and counts as nothing — the finding
did not shrink; it moved somewhere the measurement does not look."* Its §1
named the fix and called it "the only thing that stops this ledger decaying
between passes."

`scripts/platform-elevation-coverage.test.ts` now carries it. Every route
module that reaches a platform-winnable role — by resolving one, by delegating
to a guard that does, or by making an elevation decision about one — must
appear in a `LEDGER` with one of three states, and five assertions hold it:

| state | meaning | what is asserted |
|---|---|---|
| `decides` (13) | makes the decision itself | a decision symbol is still present |
| `delegates` (3) | its authorization is a shared guard that decides | it resolves **no** role of its own, so a new route in it cannot sidestep the guard |
| `undecided` (33) | reaches platform-winnable power, decides nothing | it still makes no decision — a module that starts deciding must be promoted |

The set assertion fails **in both directions**: a new module that reaches a
platform-winnable role is not in the ledger and fails, and a module that stops
reaching one must be removed rather than left as a stale row. A sixth assertion
pins the tally, so closing one of the 33 is a visible one-line change rather
than a number that quietly drifts.

**16 of 49** route modules now decide, against 13 of 48 that 10-26 measured by
the same method before OPS-51. The denominator grew by one and the numerator by
three — and that count is now computed by the suite, which is the point: this
document did not derive it.

**What the ledger does not claim**, written into the file so the next pass does
not misread it: that an `undecided` module is safe, or that a `decides` module
decided *correctly*. It is a coverage ledger over source text. The behavioural
evidence is the per-finding suites, which it names.

`undecided` is the open queue, not a clean bill. OPS-48's ranked remainder
carries its write counts into the ledger: `termbase-subscriptions.ts` (7),
`member-scopes.ts` (2), `knowledge.ts` (2), and one write each in
`team-handoffs.ts`, `project-settings.ts`, `ai-smart-edits.ts`,
`ai-interventions.ts` and `agent-artifacts.ts`. The other 25 are reads, AI
proxies and helpers this series has never read as elevation surfaces — which is
the state the ledger exists to keep visible.

---

## Reviewed, no new finding

* **`POST /:projectId/link-source/match`.** A POST that writes nothing — it
  carries a list, which is why it is not a GET. Its answer is per-pair line
  counts and a `canReplace` flag over two projects' cells. Left open, recorded
  at the guard: the content is already readable by an un-elevated operator
  under AQU-2003, and narrowing it would cost an operator the ability to
  diagnose a tenant's link without taking a power they do not need. The link it
  previews **is** narrowed, which is where the decision belongs.
* **The cycle check and `chainContains`.** Walks the prospective upstream's
  source chain looking for `projectId`. No role resolution and no caller
  identity, so platform power does not reach it; it runs after both role checks
  in every path. Correct as-is.
* **`archive` / `unarchive`.** In `routes/projects.ts`, not here, and that
  router already decides (AQU-1322). Archive is reversible, which is the
  distinction that makes the delete above worth a gate the archive does not
  need.
* **`DELETE /:projectId`'s downstream block.** The "cannot delete: project has
  linked-target downstreams" 409 is a data-integrity rule, not an authorization
  one, and the fix deliberately narrows **before** it so an un-elevated admin
  does not learn a cross-tenant project's downstream list as a side effect of
  being refused.
* **`forgetProjectRole` and the role memo.** The genuine lookup memoises in its
  own slot (`role-genuine:…`), separate from the platform-inclusive
  `role:…` slot, so threading `includeArchived` cannot cause the de-escalated
  answer to be served where the full one was asked for. The archive check runs
  *before* `memoize` in both resolvers, so the shared slot is sound — the same
  argument `resolveProjectRoleInternal` already documents for its own pair.

---

## Residual risk and operator actions

1. **Decide `termbase-subscriptions.ts`** (7 writes), now the head of OPS-48's
   remaining eight. The ledger carries the queue, so this no longer depends on
   a document being re-read.
2. **There is no audit trail on a project delete.** This pass closed the gate;
   it cannot tell anyone what went through it. `DELETE FROM projects` writes no
   row anywhere naming the actor, and the cascade removes the project's own
   history with it — so a project deleted on platform authority before today is
   indistinguishable from one its owner deleted, and from one that never
   existed. Recording deletes in `admin_audit` (the table
   `services/admin-audit.ts` already writes) is the smallest honest fix, and it
   is the one control here that a closed gate does not provide.
3. **Still outstanding and unchanged from earlier passes:** 10-26's audit of
   `integration_connections` / `integration_links` for rows written on platform
   authority; the QA-walker identity question 10-12 left open (platform-admin
   paths are not QA-walkable on any preview — `scripts/cloudflare-stack-preview.mjs`
   sets no `ADMIN_EMAILS` and no `platform_admins` row exists on development
   storage, so this change is one more thing a preview cannot exercise); and the
   `desktop-release-signing` Environment's required reviewers (OPS-40).

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was restored (`git stash` of the source file, re-run) — the series' standard
decisive check.

* `auth-worker`: `src/__tests__/source-linking-elevation.test.ts` — **17
  passing** (new file). Pre-fix: **6 failed**, one per narrowed write, and the
  headline is the first of them:
  - `DELETE /api/v2/projects/proj-t` returned **200** to an un-elevated
    platform admin on a tenant project they hold no grant on, and
    `SELECT 1 FROM projects WHERE id = 'proj-t'` came back empty afterwards —
    the project was gone.
  - `POST /proj-t/link-source` with `sourceProjectId: proj-u` linked one
    tenant's project to a *second* tenant's, neither of them the operator's.
  - the same request with only the **upstream** side resting on admin power
    (root genuinely owns the downstream) also went through, which is why both
    sides narrow.
  - `detach-source`, `link-source/files` and `link-source/files/stop` each got
    past their floor.

  The **11 that passed pre-fix are the controls, and still pass**: an ordinary
  owner deletes their own project; an operator deletes a project they genuinely
  own; an operator deletes their own **trashed** project (the `includeArchived`
  regression guard); a lead with genuine access to both sides links them; every
  elevated path is restored; a member below the floor still gets the
  byte-identical pre-OPS-51 `"only owners can delete a project"` wording; and
  all three reads stay open to an un-elevated admin.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **22 passing** (5 new). Verified the new census bites, both arms:
  - with the route fix stashed, `every module recorded as deciding still makes
    a decision` fails with `source-linking.ts: NO DECISION`;
  - with one row deleted from the ledger, `every route module that reaches
    platform-winnable power has a recorded state` fails naming the orphan
    (`+ "knowledge.ts"`).
  The existing `the de-escalation helpers only ever NARROW, never widen` pin
  also fired on the helper's new signature before it was updated — the drift
  guard catching its own subject, which is the behaviour it was written for.
* `auth-worker`: all 16 `source-linking-*` suites — **131 passing, 0 failures.**
* `auth-worker`: the six elevation suites plus `merge-sibling.test.ts` and
  `credentials.test.ts` (the other callers of the helper this pass touched) —
  **172 passing, 0 failures.**
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28, 10-05, 10-12,
  10-19 and 10-26).
* `npx eslint` on all five changed files: **0 errors.** One pre-existing
  `no-useless-assignment` warning on `seeded` in `source-linking.ts` moved from
  line 441 to 485 with the inserted guard; confirmed present on `origin/dev` by
  stashing the change and re-running.
* Full `auth-worker` suite (`npx vitest run`): see the note below.

Environment note, for whoever re-runs this: **no dependencies were installed in
this container at session start.** `pnpm install` in `auth-worker` (its own pnpm
workspace root) works; the repo root needs `--ignore-scripts`, and the root
install is required even for auth-worker's own suites, because `auth-worker`
imports from `../src` and `../db`. Unchanged from 10-26.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/source-linking-elevation.test.ts src/__tests__/merge-sibling.test.ts
src/__tests__/credentials.test.ts`._
