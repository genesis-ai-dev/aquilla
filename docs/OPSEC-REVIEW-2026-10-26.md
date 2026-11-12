# Operational Security Review — 2026-10-26

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-10-19.md`.
New findings continue the **OPS-n** series at **OPS-49**._

**Scope for this pass: authentication & session management** — the Monday slot.

1. **A parallel auth/session pen-test pass ran again this morning.** Commit
   `12a56f19` ("[Pen test] Auth & session security review: cap access-link PIN
   guessing, require verified email for invite discovery") landed on `dev` at
   09:13 UTC — six hours before this pass started — and touched
   `auth-worker/src/routes/access-links.ts` and `routes/invites.ts`. Like
   `87397102`, `b225cb40` and `7455641c5` before it, it wrote no review
   document, so its findings carry no OPS-n. **This pass therefore avoids those
   two files.** That is the **seventh** concurrent-pass collision the series has
   recorded, and the fourth in twenty-one days. §0's numbering note remains the
   right diagnosis and scheduling remains the fix; for the Monday slot the
   collision is simply the standing condition.

2. **10-19 named what to read next.** OPS-48 separated writes from reads in
   OPS-45's undecided set and ranked ten route modules, led by `monday.ts`
   (11 writes) — *"acts on a tenant's stored third-party credential … lets an
   un-elevated admin drive another tenant's Monday workspace on that tenant's
   own credential"* — and `source-linking.ts` (14 writes). It asked for one
   recorded decision per route rather than ten blind gates.

So: the first of those ten, decided. The pass found the finding is not one
module's, and not eleven writes. **The day after OPS-48 was written, AQU-804
hoisted Monday's two guards into a shared helper and a second router started
using them; two days after that, a third did.** One guard pair is now the
*entire* authorization decision for three integration routers at 38 call sites,
and it made no elevation decision at all. That is OPS-49. What the measurement
behind OPS-45/OPS-48 can and cannot see after that refactor is OPS-50.

Every finding is labelled **FACT** (verified against a file:line or reproduced
at this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-49 — One un-gated guard pair let an un-elevated platform admin set where any tenant's project data is pushed, and on whose credential — **FIXED** [FACT]

**What the guards are.** `auth-worker/src/routes/_integration-helpers.ts`
exports `orgGuard(c, minRole)` and `projectGuard(c, minRole)`. They are the only
authorization decision made by **all three** progress-sync routers — `monday.ts`
(AQU-804), `airtable.ts` (AQU-804) and `langquest.ts` (AQU-2105) — across 38
call sites. None of those three files contains a call to `resolveProjectRole`,
`getEffectiveOrgRole` or `getOrgMemberRole`; the guards are the whole story,
which is what makes one fix sufficient and one gap total.

**What authorised it.** `orgGuard` resolved with `getEffectiveOrgRole`, which
returns `Math.max(membership ?? 0, 700)` for every platform admin on every org
(`services/org-permissions.ts:435-445`). `projectGuard` resolved with
`resolveProjectRole`, which contributes `{ source: "platform", level: 700 }` on
every project in every org (`services/project-permissions.ts:351`). Every
manage route in all three routers asks for `MANAGE_MIN_ROLE` = **600**
(`ROLE.MAINTAINER`); LangQuest's state and audio routes ask **500**
(`ROLE.PROJECT_LEAD`). 700 clears both, so an **un-elevated** platform-admin JWT
satisfied every floor in every router, on every tenant. Neither guard consulted
`hasActiveElevation`.

**Why this is not simply another un-gated write.** These floors do not protect a
row. They decide **where a project's progress leaves Aquilla, and on whose
credential**:

* The push payload is `lib/monday/metrics.ts`: project and file names, each
  language, per-lane completion and validation figures, the deadline, the
  last-activity date, a deep link into the project — and `translators`, the
  comma-joined **usernames of every member at CONTRIBUTOR+** (`metrics.ts:455`).
  That is the D2+D3 *linkage* §2 of `docs/OPSEC.md` names as the asset the
  state-actor row exists for: who is translating what, and when.
* `PUT /api/v2/airtable/orgs/:orgId/connection` **stores a caller-supplied
  personal access token** as that org's connection (`airtable.ts:240`),
  encrypted at rest and used server-side thereafter. An un-elevated admin could
  park their own credential on another tenant's org.
* `PUT /projects/:projectId/link` picks the destination base/board, and
  `POST /projects/:projectId/sync` pushes on demand.
* **It then runs by itself.** `auth-worker`'s `*/5 * * * *` cron calls
  `flushDirtyLinks(runEnv, 20)` (`wrangler.toml:169`, `src/index.ts:591`), and
  the project DO nudges `/internal/push` on edits. A link written in one
  un-elevated request keeps exporting the tenant's work **after that session
  ends and after the admin JWT is revoked.**

That is precisely OPS-44's categorical test — *does what this hands out survive
or escape the session?* — and it escapes twice over: the destination outlives
the session, and the data lands in a third party's system on the tenant's own
credential, where none of the sync-worker's `src: "platform"` rules, role floors
or lane walls can see it. It is therefore outside AQU-2003's 10-16 decision in
exactly the way OPS-47 was: that decision priced un-elevated platform access as
**read-only on our own content**, and said nothing about opening a standing
egress channel into someone else's SaaS.

**The Monday credential-planting path is closed by the same gate, and only by
it.** `POST /orgs/:orgId/connection/start` mints a 10-minute signed state JWT
carrying `orgId` (`monday.ts:245`); `/oauth/callback` takes auth entirely from
that state and trusts its `orgId`, binding only that the finisher is the user
who started it (a 2026-10-22 pen-test fix against login-CSRF, `monday.ts:296`).
So which org a Monday OAuth token lands on is decided *once*, at `start`'s
`orgGuard` — and before this change that guard was satisfied by un-elevated
admin power.

**The fix.** OPS-44's de-escalation idiom, applied once in the shared helper
rather than at 38 call sites, and stated there as a rule: **an asserted role
floor is not satisfied by platform-admin power unless the session is elevated.**
`orgGuard` runs `orgLevelWithoutUnelevatedAdmin` and `projectGuard` runs
`roleWithoutUnelevatedAdmin`, then re-applies the same floor to the genuine
grant that survives. De-escalation rather than a flat 403 on
`source === "platform"` for the reason `elevation-gate.ts` already gives:
platform's 700 outranks every genuine grant below owner, so that source also
describes an operator who really is a Maintainer of this project's own org, and
refusing them would lock operators out of their own tenancy. Elevation restores
the admin path in full.

**The member-level read is deliberately left open.** A guard called with
`minRole == null` returns before de-escalating. Those are the status reads —
`GET /orgs/:orgId/connection`, `GET /projects/:projectId/link` — that the SPA
makes on every project open (`langquest.ts:174` says so in as many words), and
leaving them is AQU-2003's decision applied here rather than a second judgment
of my own: an un-elevated operator can already open that project read-only, so
seeing *that* it is linked changes nothing. What they can no longer do is spend
the tenant's credential or change where the data goes.

**What an un-elevated operator loses, checked rather than assumed.** On another
tenant's project-settings page the vendor-backed panels (board/base pickers,
"table changed") now fail. The SPA already tolerates exactly that:
`useMondayBoardChanges` catches the failed read, sets `readFailed` and renders
the saved configuration anyway (`src/components/ProjectSettings/useMondayBoardChanges.ts:83`),
and its own test fixture notes that this is the default path. So the degradation
is a disabled panel, not a broken page.

One ordering note, not a finding: `zValidator` runs ahead of the guard, so a
malformed body still answers 400 before authorization is decided. No credential
or tenant data is disclosed by that, but it does mean an unauthorized caller can
learn a route's body schema.

### OPS-50 — The open ledger went stale in a day, and the refactor that staled it also hid three routers from the method that produced it — **REPORTED, NOT FIXED** [FACT]

OPS-45 counted route modules *that resolve a platform-admin-winnable role* and
asked which make an elevation decision. OPS-48 refined the undecided set to the
ten that write. Both numbers were correct for the tree they measured. Neither
survived the week, and the reason is worth recording because it will recur:

* At the 10-19 review commit (`103aa8ee`) `auth-worker/src/routes/` contained
  **no** `airtable.ts`, `langquest.ts` or `_integration-helpers.ts`, and
  `monday.ts` resolved both roles inline — which is why OPS-48 could see it.
* **AQU-804 merged to `dev` on 2026-10-20** (`d9b7e9a0`), one day later. It
  hoisted those guards into the shared helper and added a second router behind
  them. **AQU-2105 merged on 2026-10-22** (`ab252cb7`) and added a third.
* After that refactor none of the three routers contains a resolver call at
  all, so **the method behind OPS-45's census cannot see them.** A module that
  delegates its authorization to a helper resolves no role and counts as
  nothing. The finding did not shrink; it moved somewhere the measurement does
  not look.

Re-measured at this commit, counting a module as covered when it makes an
elevation decision itself *or* reaches a platform-winnable role only through a
guard that makes one: **13 of 48** route modules now decide, against **10 of 48**
on `origin/dev` before this change. 10-12 reported **8 of 44** by the narrower
method that counts only a module's own resolver calls. The denominator grew by
four in a fortnight while the numerator grew by three.

Two consequences, neither of them a patch:

1. **The census belongs in the drift guard, not in a document.** OPS-45 was
   right that the right unit of work is one recorded decision per route; what
   10-20 showed is that the right unit of *measurement* is the authorization
   decision, not the file. `scripts/platform-elevation-coverage.test.ts` now
   pins the three routers' delegation (they resolve no role themselves, so a
   future route in them cannot sidestep the guard), but the census itself is
   still hand-run. Making it an assertion that fails when a new undecided
   module appears is the follow-up, and it is the only thing that stops this
   ledger decaying between passes.
2. **Eight of OPS-48's ten remain**, unchanged and still a human call:
   `source-linking.ts` (14 writes) is now the head of the list, then
   `termbase-subscriptions.ts` (7), `member-scopes.ts` (2), `knowledge.ts` (2),
   and one write each in `team-handoffs.ts`, `project-settings.ts`,
   `ai-smart-edits.ts`, `ai-interventions.ts` and `agent-artifacts.ts`.

---

## Reviewed, no new finding

* **`/internal/push` and the Monday webhook.** Neither goes through the guards.
  `POST /api/v2/monday/internal/push` authenticates with a `SYNC_SECRET_KEY`
  bearer through `secureCompare`, and `POST /webhook` verifies Monday's own JWT
  against `MONDAY_SIGNING_SECRET`. Both are service-to-service and correctly
  outside the role ladder; narrowing the guards does not touch the cron path, so
  an already-configured tenant keeps pushing.
* **The Monday OAuth callback's org binding.** Worth stating that it checks out
  *given* the fix above: the callback re-derives nothing, so if `start` were
  ever reachable without authority again, the whole flow reopens. The state JWT
  is signed with `SECRET_KEY`, expires in 10 minutes, carries the PKCE verifier
  encrypted rather than in the browser, and since 2026-10-22 requires the
  finisher's session to match the starter's. The remaining weight is all on
  `start`.
* **`POST /api/v2/langquest/inspect`.** Takes a caller-supplied `lqp_` token and
  calls LangQuest `/me` with it. No project scope and no floor — but the token
  is the caller's own, the base URL comes from env (`langquestApiBase`) so it is
  not an SSRF primitive, and the response only describes the token presented.
  Correct as-is.
* **`orgLevelWithoutUnelevatedAdmin` on the hot path.** Putting a de-escalation
  helper inside a request guard would have cost every ordinary member an
  `admin_elevations` read and a second `org_members` read to be told what they
  were already handed. The helper's own jsdoc already stated the invariant that
  makes those reads unnecessary (for a non-admin, effective *is* genuine); this
  pass makes it explicit with an `isPlatformAdmin` short-circuit, which lands on
  the per-request memo the role resolvers have already populated. Behaviour is
  unchanged for both of its call sites; `credentials.ts` benefits too.
* **`changeset-approvals.ts` (OPS-47).** Re-checked at this commit: the three
  writes still narrow and the read still does not. Unchanged.

---

## Residual risk and operator actions

1. **Audit `integration_connections` and `integration_links` for rows written
   on platform authority.** The fix stops new ones; it does not retract what is
   already configured. A connection or link whose `created_by` holds no genuine
   Maintainer grant on that org/project was writable un-elevated before today,
   and a planted one is still pushing on the five-minute cron. There is no
   evidence any exists — nothing in this repo can tell us — so this is hygiene
   following a closed gap, not incident response. `created_by` stores a
   *username*, so the check is a join against `org_members`/`project_members`
   rather than one `SELECT`.
2. **Decide `source-linking.ts`**, now the head of OPS-48's remaining eight. It
   changes a project's structure and, per AQU-2003's own note, `/link/sync`
   takes any valid project token with no role floor at all.
3. **Make the elevation census an assertion** (OPS-50 §1), so the next refactor
   that moves an authorization decision does not also move it out of view.

Still outstanding and unchanged from earlier passes: the QA-walker identity
question 10-12 left open (platform-admin paths are not QA-walkable on any
preview, because `scripts/cloudflare-stack-preview.mjs` sets no `ADMIN_EMAILS`
and no `platform_admins` row exists on development storage — and this change is
one more thing that preview cannot exercise), and the `desktop-release-signing`
Environment's required reviewers (OPS-40).

---

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was restored (`git stash` of the one source file, re-run) — the series'
standard decisive check:

* `auth-worker`: `src/__tests__/integration-guard-elevation.test.ts` — **9
  passing** (new file). Pre-fix: **5 failed**, which is the finding:
  - `PUT /airtable/orgs/1/connection` planted a credential on another tenant's
    org — and the stderr proves how far it got, because the suite stubs `fetch`
    to throw: `[airtable] whoami failed: unexpected fetch in test:
    https://api.airtable.com/v0/meta/whoami`. The request reached **Airtable**.
  - `PUT /langquest/projects/proj-t/link` likewise reached
    `https://next.langquest.org/api/v1/me`.
  - `PUT /airtable/projects/proj-t/link` repointed the tenant's project at an
    attacker-chosen base;
  - `DELETE /airtable/orgs/1/connection` **deleted** the tenant's live
    connection;
  - `POST .../sync` on both the Monday and Airtable routers got past the guard
    (`[airtable] token decrypt failed` — it had already reached the tenant's
    stored credential).
  The four that passed pre-fix are the controls that must not regress, and do
  not: elevation restores the admin path, an operator's *genuine* org-Maintainer
  grant on their own org's project still needs no elevation, an ordinary
  Maintainer is unaffected and a member below the floor still gets the
  byte-identical pre-OPS-49 403 wording, and the member-level status reads stay
  open to an un-elevated admin on all three routers per AQU-2003.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **17 passing** (3 new: the `DE_ESCALATED` ledger entry for the shared
  helper, a pin that both guards narrow an asserted floor while answering the
  `minRole == null` read before de-escalating, and a pin that the three routers
  resolve no role of their own). Verified the guard bites: with the helper
  stashed, two of the three fail.
* `auth-worker`: the seven existing suites over these routers —
  `monday.test.ts`, `airtable.test.ts`, `langquest.test.ts`,
  `monday-list-boards-scope.test.ts`, `monday-environment-gate.test.ts`,
  `monday-settings-push.test.ts`, `monday-settings-dirty.test.ts` — **134
  passing, 0 failures.**
* `auth-worker`: the five elevation suites plus `credentials.test.ts` (the other
  caller of the helper this pass touched) — **142 passing, 0 failures.**
* `npx tsc --noEmit` in `auth-worker`: no error in any changed file (the only
  remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28, 10-05, 10-12 and
  10-19).
* `npx eslint` clean on all four changed files.
* Full `auth-worker` suite (`npx vitest run`): **378 files, 4447 passing, 2
  expected-fail, 0 failures** (1139 s). Nothing red remains in this package to
  distinguish from the change under review — the condition that makes a suite
  run worth anything as evidence — and it is clean for the second pass running,
  after 10-19 recorded the three files 10-12 had found red as repaired.

Environment note, for whoever re-runs this: **no dependencies were installed in
this container at session start.** `pnpm install` in `auth-worker` (its own pnpm
workspace root) works; the repo root needs `--ignore-scripts`, and the root
install is required even for auth-worker's own suites, because `auth-worker`
imports from `../src` and `../db`.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/integration-guard-elevation.test.ts src/__tests__/monday.test.ts
src/__tests__/airtable.test.ts src/__tests__/langquest.test.ts`._
