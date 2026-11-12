# Operational Security Review — 2026-10-19

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-10-12.md`.
New findings continue the **OPS-n** series at **OPS-47**._

**Scope for this pass: authentication & session management** — the Monday slot.
Two things decided where it looked, and the first is the same one the last three
passes recorded:

1. **A parallel auth/session pen-test pass ran again this morning.** Commit
   `7455641c5` ("[Pen test] Auth & session: logout revokes the whole refresh
   chain (session family id)") landed on `dev` at 09:09 UTC — six hours before
   this pass started — and touched `auth-worker/src/routes/auth.ts`,
   `middleware/auth.ts`, `auth/jwt.ts`, `utils/token-revocation.ts` and
   `types.ts`. Like `87397102` and `b225cb40` before it, it wrote no review
   document, so its findings carry no OPS-n. **This pass therefore avoids those
   five files.** That is the **sixth** concurrent-pass collision the series has
   recorded, and the third on `routes/auth.ts` in fifteen days. §0's numbering
   note remains the right diagnosis and scheduling remains the fix; for the
   Monday slot the collision is now simply the standing condition.

2. **The last pass in this slot named what to read next.** OPS-45 measured that
   of the 44 auth-worker route modules resolving a role a platform admin can
   win, 8 make an elevation decision and 36 make none, and singled out one:
   *"`changeset-approvals.ts` (the human gate in front of agent writes) flagged
   as the one most likely to be wrong next."* It was reported, not fixed, with
   the right unit of work named as one recorded decision per route.

So: that prediction, tested. It was correct, and the reason it matters is
sharper than "another un-gated route" — **the approval surface is the one human
gate in front of an agent's writes, and the write it releases lands on a
principal no elevation check can ever reach.** That is OPS-47. Checking the rest
of the undecided set against the same categorical test is OPS-48.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-47 — The human approval gate in front of agent writes was satisfied by un-elevated platform-admin power, on every tenant — **FIXED** [FACT]

**What the gate is.** `auth-worker/src/routes/changeset-approvals.ts` is the
one-time human approval assertion for ask-mode changesets (AQU-533 §3), mounted
at `/api/v2/changesets`. Its own header states the invariant it exists to keep:
*"an agent proposes, a human approves — approval still consumes a browser
session, and no agent surface can mint a confirmation."* `POST /:id/approve`
inserts a `changeset_confirmations` row; `POST /:id/reject` discards a staged
plan; `POST /:id/assign` routes one.

**What authorised it.** AQU-CMDREG-P1 §2.1 moved this surface from identity to
**authority**: a caller may act when their live project role is at or above the
floor recomputed from the plan's stored commands (`lib/changeset-floor.ts`).
`authorityDenied` implemented that with `resolveProjectRole`, which contributes
`{ source: "platform", level: 700 }` for every platform admin on **every project
in every org** (`services/project-permissions.ts:351`).

**700 is `ROLE.OWNER`** (`types.ts:595`) — the highest floor any plan can carry.
So an un-elevated platform admin cleared *every* floor on *every* tenant's
changeset, including `UNREADABLE_PLAN_FLOOR`, the deliberate owner-only
fail-closed the floor module applies to a corrupt or unrecognised plan
(`lib/changeset-floor.ts:41`). The route made no elevation decision at all — it
was one of OPS-45's 36.

**Why this is categorically worse than an un-gated write, and why AQU-2003 did
not already cover it.** On 2026-10-16 Ryder and Matthew narrowed the platform
posture deliberately (AQU-2003, recorded in 10-12's update): an un-elevated,
platform-only caller gets a **read-only** Viewer sync token, and
`sync-worker/src/events/authorize.ts` gained an explicit rule refusing any
`src: "platform"` token below Contributor whatever an org's floors say. The
accepted residual risk was cross-tenant **reads**.

Approval escapes that decision completely, because **the write that follows is
not made by a platform-sourced token at all.** The confirmation is consumed by
the *agent's* credential: `receiptOnlyGates` matches on
`(changeset_id, credential_id, digest)` and never looks at who approved or what
authority they held (`sync-worker/src/external/commit-gates.ts:128-141`). So the
cross-tenant write lands on the agent's PAT, the one principal none of the
sync-worker's `src: "platform"` rules can see. An un-elevated admin JWT — the
attacker OPS-35 was written for, and the one AQU-2003 priced as read-only —
released real writes into any tenant's project by approving them.

The asymmetry is what makes it a mistake rather than a policy: **the sync-worker
half of this same gate already ignores platform power.**
`changesetAuthorityDenied` resolves the caller with
`resolveProjectRoleShared(db, { id: cred.userId }, cs.projectId)` — no email, no
`adminEmails` — so no platform contribution exists on that path and a
platform-only caller resolves `null` and is refused
(`sync-worker/src/external/authority.ts:77`). Two implementations of one gate,
disagreeing about whether admin power counts.

**The fix.** De-escalation, not refusal — for the reason `elevation-gate.ts`
already gives and OPS-44 established: platform's 700 outranks every genuine
grant below owner, so `source === "platform"` also describes an operator who
really is a Maintainer of this project's own org, and a flat 403 on the source
would lock operators out of their *own* projects. The three writes now pass the
caller's role through `roleWithoutUnelevatedAdmin` and re-apply the same floor to
what survives; `assign` narrows at its own call site because it resolves its own
floor (the org's assignment policy, AQU-1037). Elevation restores the admin path
in full.

**The read is deliberately left open**, which is the AQU-2003 decision applied
here rather than a second judgment of my own: a platform admin can still open
the approval page for another tenant's plan, as they can already open that
project read-only. Narrowing cross-tenant reads is the product call AQU-2003
settled on 10-16, and re-opening it is not this pass's to make.

### OPS-48 — Of OPS-45's 36 undecided route modules, ten perform writes an un-elevated admin reaches — **REPORTED, NOT FIXED** [FACT for the measurement, JUDGMENT for the ranking]

OPS-45 counted route *modules* that make no elevation decision. It did not
separate reads (whose openness AQU-2003 has since made deliberate) from writes
(which that decision did not license). Applying OPS-44's own categorical test —
*does what this hands out survive or escape the session?* — to the undecided set
gives ten modules that resolve a platform-winnable role, make no elevation
decision, and write:

| Writes | Module | Why it is on the list |
|---|---|---|
| 14 | `source-linking.ts` | Structural: binds a project to an upstream source. AQU-2003 already noted `/link/sync` takes any valid project token with no role floor. |
| 11 | `monday.ts` | **Acts on a tenant's stored third-party credential.** The Monday token is decrypted server-side and used, never returned — so this is not OPS-44(c)'s disclosure, but it does let an un-elevated admin drive another tenant's Monday workspace on that tenant's own credential. |
| 7 | `termbase-subscriptions.ts` | Project content/config writes. |
| 2 | `member-scopes.ts` | Touches the membership graph (D3) — adjacent to the eleven AQU-1322 *did* gate. |
| 2 | `knowledge.ts` | Reference-document corpus writes. |
| 1 each | `team-handoffs.ts`, `project-settings.ts`, `ai-smart-edits.ts`, `ai-interventions.ts`, `agent-artifacts.ts` | Content, settings and artifact writes. |

Reported rather than patched, deliberately. The posture for each of these is the
kind of decision AQU-2003 demonstrated goes to humans — Ryder and Matthew traded
QA practicality against cross-tenant reach and chose read-only — and gating ten
route modules blind in one afternoon is precisely what OPS-44's "one recorded
decision per route" was written to replace. `monday.ts` and `source-linking.ts`
are where I would start: the first acts on someone else's credential against an
external system, the second changes a project's structure.

---

## Reviewed, no new finding

* **`sync-worker/src/external/session-routes.ts` (the in-app commit path).** The
  SPA commits a session-staged changeset through sync-worker's session-token
  routes, not auth-worker, so it is a second way to reach the same engine. It
  fails closed against platform power for the reason given above —
  `changesetAuthorityDenied` re-resolves the caller by user id with no admin
  lookup. Worth recording that `sessionPrincipal` hardcodes `access: 'write'`
  with an AQU-1242 comment whose premise — *"the read-only ceiling is a property
  of a MINTED token, and there is none here"* — **stopped being true on
  2026-10-16**, when AQU-2003 minted exactly such a token. Nothing on the commit
  path consults `cred.access` (its only consumers are `read-routes.ts`,
  `token-bridge.ts` and the MCP handlers), so the stale premise gates nothing and
  the DB re-resolution is the control that holds. Documentation drift behind a
  live second control, not a finding — but the comment should be corrected before
  someone relies on it.
* **Living Memory auto-accept (`sync-worker/src/external/commands-memory.ts:541`).**
  `approverWithReviewFloor` decides whether an approved memory write lands
  `accepted` or `proposed` by re-resolving the *approver's* role. It too passes
  `{ id: approverId }` with no email, so platform power cannot reach it and a
  platform admin's approval leaves the write `proposed` for in-app review. Fails
  closed, correctly — though by the same accident of omission as the path above
  rather than by an explicit decision.
* **The creator-scoped branch of `authorityDenied`.** Tenant-creation and
  org-membership plans keep the creator rule, which is identity (`created_by_user_id
  === user.id`), so platform power never applied there. Unchanged.
* **`changeset-floor.test.ts` is green again.** 10-12 recorded it as one of
  three pre-existing red files in this package (`requiredRoleForChangeset`
  returning 500 where the test expected 600). It passes at this commit, so that
  red has been fixed on `dev` in the week since.

---

## Residual risk and operator actions

Both are out-of-band, in the spirit of every GitHub/Cloudflare-side control this
series flags rather than assumes.

1. **Audit `changeset_confirmations` for rows minted on platform authority.**
   The fix stops new ones; it does not retract what was approved. A row whose
   `user_id` holds no genuine grant at or above the plan's floor on that
   project was mintable un-elevated before today, and the changeset it released
   has already committed. There is no evidence any were minted abusively —
   nothing in this repo can tell us — so this is hygiene following a closed gap,
   not incident response. The query needs the floor recomputed per row, so it is
   a script rather than one SELECT.
2. **Decide the ten routes in OPS-48**, in the order argued there. One recorded
   decision per route, as OPS-44 framed it.

Still outstanding and unchanged from earlier passes: the QA-walker identity
question 10-12 left open (platform admin paths are not QA-walkable on any
preview, because `scripts/cloudflare-stack-preview.mjs` sets no `ADMIN_EMAILS`
and no `platform_admins` row exists on development storage), and the
`desktop-release-signing` Environment's required reviewers (OPS-40).

**OPS-46 is closed, and this pass checked rather than assumed it.** 10-12
reported that `adversarial-jev.yml` was the only workflow with a
`pull_request:` trigger, so nothing gated a PR. AQU-1551 (#1275, 2026-10-13 —
the day after that pass) wired `ci.yml` to `pull_request: branches: [dev]`, and
its header now names the required contexts: `lint`, `unit`,
`schema-migrations`, `auth-worker-tests`, `sync-worker-tests`,
`agent-worker-tests`. So this change does receive a real gate, and the
`auth-worker-tests` job covers the suites below. Two caveats worth carrying
forward rather than re-deriving next week: **`typecheck` deliberately stays
`workflow_dispatch`** (AQU-564 — Cloudflare Workers Builds compiles the
preview), so the local `tsc` run remains the only typecheck evidence for a PR;
and `enforce_admins` is false by that header's own account, so a red run is
still mergeable by an admin.

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was restored (`git stash` of the one source file, re-run) — the series'
standard decisive check:

* `auth-worker`: `src/__tests__/changeset-approval-elevation.test.ts` — **8
  passing** (new file). Pre-fix: **4 failed**, which is the finding:
  - `POST /:id/approve` succeeded on another tenant's changeset and **minted the
    confirmation row** (0 expected, 1 found);
  - `POST /:id/reject` discarded another tenant's staged plan;
  - `POST /:id/assign` routed it;
  - the **owner-only `UNREADABLE_PLAN_FLOOR`** was cleared too, since platform
    contributes exactly 700.
  The four that passed pre-fix are the controls that must not regress, and do
  not: elevation restores the admin path, an operator's *genuine* org-Maintainer
  grant on their own org's project still needs no elevation, an ordinary
  Contributor who holds the floor is unaffected, and the approval **read** stays
  open to a platform admin per AQU-2003.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **14 passing** (2 new: the `DE_ESCALATED` ledger entry and a pin that the
  three writes narrow while the read does not). Verified the guard bites: with
  the route change stashed, both new assertions fail.
* `auth-worker`: the four pre-existing changeset suites —
  `changeset-approvals.test.ts`, `changeset-assign.test.ts`,
  `changeset-floor.test.ts`, `changeset-approval-changes-import-origin.test.ts`
  — plus the new file: **71 passing, 0 failures.**
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28, 10-05 and 10-12).
* `npx eslint` clean on all three changed files.
* Full `auth-worker` suite (`npx vitest run`): **351 files, 4102 passing, 2
  expected-fail, 0 failures** (955 s).

  **That closes a flag 10-12 raised.** That pass found *"7 failures in 3 files —
  all pre-existing"* and recorded them as a regression `dev` had acquired since
  10-05 (`rls-backstop.test.ts` ×5 from AQU-1611's dropped `target_lang` column,
  `changeset-floor.test.ts` ×1, `source-linking-cycle.test.ts` ×1), reported
  rather than fixed because none of it was auth/session work. All three are
  green at this commit, so `dev` has repaired them in the week since, and this
  package is clean again as it was on 10-05. Nothing red remains here to
  distinguish from the change under review — which is the condition that makes
  a suite run worth anything as evidence.

Environment note, for whoever re-runs this: **no dependencies were installed in
this container at session start**, and `npm ci`/`npm install` in `auth-worker`
both abort with npm's `Cannot read properties of null (reading 'edgesOut')`.
`pnpm install` is the working path (auth-worker is its own pnpm workspace root,
by the deliberate `pnpm-workspace.yaml` there), and the repo root needs
`--ignore-scripts` because `onnxruntime-node`'s postinstall binary download
dies on `ECONNRESET` behind the proxy.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/changeset-approval-elevation.test.ts
src/__tests__/changeset-approvals.test.ts src/__tests__/changeset-assign.test.ts
src/__tests__/changeset-floor.test.ts`._
