# Operational Security Review — 2026-10-12

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-10-05.md`.
New findings continue the **OPS-n** series at **OPS-44**._

**Scope for this pass: authentication & session management** — the Monday slot.
Two constraints shaped where it looked, and they are the same two the last pass
recorded:

1. **A parallel auth/session pass ran again this morning.** Commit `b225cb40`
   ("[Pen test] Auth & session: harden Monday backTo redirect, supersede old
   reset tokens") landed on `dev` at 09:10 UTC and touched
   `auth-worker/src/routes/auth.ts` and `routes/monday.ts`. Like `87397102` a
   week earlier, it wrote no review document, so its findings carry no OPS-n.
   **This pass therefore avoids `routes/auth.ts` and `routes/monday.ts`** rather
   than re-reading them hours behind someone else. That is the **fifth**
   concurrent-pass collision the series has recorded, and the second on the same
   file in eight days. §0's numbering note is still the right diagnosis and
   scheduling is still the fix; at this cadence the collision is now the norm for
   the Monday slot, not the exception.
2. **The newest authorization surface in the repo had never been read.**
   AQU-1239 (`84edc274`, 2026-10-08) moved platform-admin identity out of
   `ADMIN_EMAILS` in `wrangler.toml` and into a `platform_admins` table
   (migration 0157), because the repo is now public and the var published every
   operator's real address. It landed after 10-05's pass. Grepping the series
   for `platform_admins` and `0157` returns nothing.

So: the platform-admin authority chain end to end — who is an admin, what that
grants, and where the step-up elevation gate that is supposed to fence it
actually applies.

The AQU-1239 change itself is sound (see "Reviewed, no new finding"). Reading it
is what made the real question visible: **elevation is not the fence the repo
believes it is.** AQU-1322 wrote the rule down — *"admin power applies only
while elevated"* — and applied it to eleven grant-management writes. It was never
applied to the paths that mint a credential or disclose one. That is OPS-44.

Every finding is labelled **FACT** (verified against a file:line or reproduced at
this commit) or **JUDGMENT** (reasoned inference). No survey agent was used.

---

## Findings

### OPS-44 — Platform-admin power needed no elevation on the four paths that escape the session: the sync-token mint, PAT minting, the org's live vendor keys, and the irreversible project fold — **FIXED** [FACT]

**The authority.** `resolveProjectRole` adds a `{ source: "platform", level: 700 }`
contribution for every platform admin on **every project in every org**
(`auth-worker/src/services/project-permissions.ts:311`), and
`getEffectiveOrgRole` returns `Math.max(membership ?? 0, 700)` on **every org**
(`services/org-permissions.ts:419`). That is the intended cross-tenant
support path.

**The fence.** AQU-1322 decided that authority should only apply while the
session holds an active step-up elevation — the emailed 6-digit code, 6-hour
window, bound since OPS-35 to the credential that redeemed it. Its own header
states the rule: *"admin power applies only while elevated, on project
membership writes"* (`services/elevation-gate.ts:1`). `projectElevationDenial`
implements it, at **eleven** call sites — `routes/projects.ts` (×5),
`access-links.ts` (×2), `project-members.ts`, `invites.ts`, plus two
`hasActiveElevation` sites in `orgs.ts`. All eleven are grant-management: add a
member, mint an invite, revoke a link. `admin-membership-elevation.test.ts` even
gates *reads* of invite tokens behind elevation.

**The gap.** Of the **44** route modules in `auth-worker/src/routes/` that
resolve a role a platform admin can win, **8** made any elevation decision and
**36** made none (measured, `scripts/platform-elevation-coverage.test.ts`). Most
of those 36 are reads whose openness is a deliberate product choice — see OPS-45.
Four were not reads, and they share a property that makes them categorically
different from the eleven that were gated: **what they hand out survives or
escapes the session, so no later elevation check can reach it.**

| # | Path | What an un-elevated admin got | Verified |
|---|---|---|---|
| a | `POST /api/v2/sync-token` | A sync token for **any** project, carrying `src: "platform"` | `routes/sync-token.ts`, `services/sync-token-mint.ts:118` |
| b | `POST /api/v2/credentials` | An `aqk_` Agent-API **PAT** scoped to any tenant's project/org, `act` and `pii` included | `routes/credentials.ts:137-147` |
| c | `GET /api/v2/orgs/:orgId/settings` | Any org's **live Gemini/TTS vendor API keys, unredacted** | `routes/org-settings.ts:285-301` |
| d | `POST /api/v2/projects/:id/merge-sibling` | An **irreversible** fold of any tenant's project into one they control | `routes/merge-sibling.ts:149-163` |

**(a) is the worst of the four, because of what the claim means downstream.**
`src: "platform"` is the sync-worker's one blanket exemption. Six checks skip on
it: the live membership re-check on every `POST /events` flush
(`sync-worker/src/events/route.ts:977`), two in `events/authorize.ts` (506, 769),
`events/merge-sibling-route.ts:427`, `events/plan-route.ts:279`, and the lane read
wall (`events/lane-read-wall.ts:94`). So one mint on bare admin authority yields
cross-tenant **read and write** on draft target text (D2) and the membership
graph (D3) — the exact linkage §2 calls the reason this product is a target —
while bypassing the control (FRO-346's live re-check) that exists to make
removing a member take effect immediately.

**(b) is the most durable.** A PAT outlives the session that minted it. Even with
(a) closed, an un-elevated admin could mint a PAT and reach project content
through the external Agent API indefinitely, routing *around* the step-up gate
rather than passing it. At level 700 they also cleared the two floors above
CONTRIBUTOR: `act` (MAINTAINER) and — reproduced — `pii` (OWNER), which AQU-1180's
own comment calls *"a decision about other people's safety"* because it hands a
third-party AI console the real names of everyone who has edited the project.

**(c) is a plaintext credential of someone else's** (D7). The route redacts
`orgProviderKeys` below MAINTAINER precisely so *"a viewer could [not] read the
org's live Gemini/TTS vendor key straight out of the settings response"*
(`org-settings.ts:209-215`) — and then took its role from `getEffectiveOrgRole`,
which hands every operator 700 on every org. The redaction was defeated for the
one caller class it should have applied to hardest.

**The attacker is the one OPS-35 already named**, and this is why the finding
matters rather than being a restatement of "admins are powerful". OPS-35 hardened
elevation against *"a caller already holding a valid (e.g. stolen) non-elevated
admin JWT"*, binding the elevated session to the credential that redeemed the
code so that attacker could not ride the real operator's elevation. That fix
holds. But against D2/D3/D7 it was moot: the attacker never needed elevation.
Access tokens last 30 days (V8). The enumeration needed is unelevated too —
`GET /api/v2/orgs?limit=50` returns the org directory (`orgs.ts:202`) and
`GET /api/v2/projects?limit=50` returns, in its own words, *"one page of the
tenancy"* (`projects.ts:556-558`). Stolen JWT → list every org → list every
project → mint a platform sync token or a PAT per project → read and write
everything. No emailed code anywhere in that chain [FACT: each step verified
against the route; JUDGMENT: that the steps compose, which follows from each
being behind `authMiddleware` alone].

**Why this sat unnoticed** [JUDGMENT]: `elevation-gate.ts`'s header asserts that
*"a resolved role whose source is 'platform' means the decision rests on admin
power, not a genuine grant"*, justified by platform having the lowest tie
priority. **That premise is false, and a test written against it failed on first
run.** Tie priority only breaks ties; 700 outranks every genuine grant below
owner. So an operator who is a real org MAINTAINER (600) of a project also
resolves `source: "platform"`. Two consequences: the eleven gated sites
*over-block* (they refuse operators on their own projects — fail-closed, so not a
vulnerability, but it makes the gate feel wrong and discourages applying it
further), and any naive extension of the gate to a path like the sync-token mint
would lock operators out of ordinary work. The incorrect comment is now
corrected in place.

**Fix — de-escalate, don't refuse.** A flat 403 on `source === "platform"` was
tried first and is wrong for exactly the reason above: `POST /sync-token` is the
path every project-open goes through, and refusing an operator their own project
is not acceptable. So the admin *superpower* is stripped and the caller falls
back to their **genuine** role:

- `resolveGenuineProjectRole` (`services/project-permissions.ts`) — the role the
  user would hold with no platform contribution, via the existing pure
  `roleFromGrantPaths` with the admin flag forced off. Its own memo slot; no new
  query shape. Resolves through the per-table grant paths deliberately: this is a
  narrowing check, and under `ACCESS_GRANTS_RESOLVER=shadow` (the deployed
  setting) that resolver is the authoritative one anyway.
- `roleWithoutUnelevatedAdmin` and `orgLevelWithoutUnelevatedAdmin`
  (`services/elevation-gate.ts`) — return the caller's role unchanged when it
  rests on a genuine grant **or** when the session is elevated; otherwise the
  genuine role, which is `null` when platform power was the only path. The org
  twin needs no admin check of its own, because `getEffectiveOrgRole` only ever
  raises membership to 700, so the membership row *is* the de-escalated answer.
- The mint core refuses **before signing** (`reason: "elevation_required"`, a 403
  not a 503 — this is a permission answer, not AQU-996's DB blip). Placed in
  `mintSyncTokenForUser` rather than only in the route, so the guarantee is
  structural: `lib/agent/command-tools.ts`, which cannot observe a session, now
  fails that path closed instead of silently minting past the gate.

Narrowing only, on all four. No credential gains scope; a genuine member's
request is byte-identical; with `ADMIN_REQUIRE_ELEVATION` unset (local dev, e2e)
every path behaves exactly as before.

**A side effect worth naming** [FACT]: because an un-elevated operator now
resolves to their genuine source, a token minted for a project they genuinely
maintain carries `src: "org"` rather than `src: "platform"` — so the sync-worker's
live membership re-check now *applies* to it, where before admin status silently
exempted operators from it on their own projects. Strictly more checking.

### OPS-45 — 36 of 44 route modules resolve a platform-admin-winnable role with no elevation decision; the cross-tenant metadata reads are deliberate, the rest are unexamined — **REPORTED, NOT FIXED** [FACT measurement / JUDGMENT on severity]

OPS-44 fixed the four paths whose grant escapes the session. The measurement
that found them also found the breadth, and the honest statement of it is that
most of the remaining 36 modules have never had the question put to them.

They fall into three groups:

- **Deliberate cross-tenant reads.** `GET /api/v2/orgs` (picker mode) and
  `GET /api/v2/projects` (`adminBypass`) exist *in order to* show an operator the
  whole tenancy; `OrgSwitcher.tsx` and the admin console's pickers consume them,
  and the code says so. Gating these on elevation is a product decision with real
  UX consequences, not a security patch, so this pass did not make it. It is also
  the enumeration half of OPS-44's chain, which is why OPS-44's fix is written to
  hold even when the attacker knows every project id.
- **Reads of project/org content and config** — `project-settings.ts`,
  `knowledge.ts`, `style-rules.ts`, `termbase-subscriptions.ts`,
  `scene-briefs.ts`, `team-handoffs.ts`, `access-audit.ts`, `usage.ts`,
  `billing.ts`, and the `ai-*` routes. Each reads or writes one tenant's data on
  a role a platform admin wins. None was individually reproduced in this pass.
  `org-settings.ts` was in this group until its secret-disclosing branch was
  found, which is the reason to suspect the group rather than trust it.
- **`changeset-approvals.ts`** deserves a pass of its own [JUDGMENT]: it is the
  human approval gate in front of agent writes (`docs/AGENT-API.md`), and an
  authority that can approve its own agent's changeset across tenants without a
  step-up is a different shape of problem from a wide read.

Not fixed here because a blanket gate would change the admin console's and the
org switcher's behaviour in ways this pass cannot validate, and because the right
unit of work is one deliberate decision per route, recorded — which is what the
new coverage test makes possible and what it should be used for. **Recommended
next**, in order: `changeset-approvals.ts`, then the content writes, then a
product decision on whether cross-tenant *reads* should require elevation at all.

### OPS-46 — The only check that runs on a pull request is an advisory agent suite; `ci.yml` still documents three of its jobs as required branch-protection contexts it can never report — **REPORTED, NOT FIXED** [FACT]

Found by checking my own PR's green tick instead of trusting it, after the QA
walk's green `pr` row prompted the question "which suite was that?".

**`adversarial-jev.yml` is the only workflow in the repo with a
`pull_request:` trigger.** Every other workflow — `ci.yml`,
`audio-delta-sync.yml`, `dependency-audit.yml`, `deploy-workers.yml`,
`dev-neon-refresh.yml`, `e2e-hetzner.yml`, `tauri-release.yml` — is
`workflow_dispatch` and/or `schedule` only (`tauri-release.yml` on tag push).
So the checks a PR receives are exactly:

| Check | What it is |
|---|---|
| `pr` | the **`pr` job of `adversarial-jev.yml`** — the advisory adversarial Jev suite |
| `nightly` | the same workflow's other job, skipped on PRs |
| `Workers Builds: aquilla-web-preview` | Cloudflare **compiling** the SPA/worker |

`ci.yml` holds `lint`, `typecheck`, `unit`, `build`, `schema-migrations`,
`auth-worker-tests`, `sync-worker-tests` and `agent-worker-tests`. **None of
them runs on a pull request.** No test suite, linter or typechecker gates a PR
in this repository.

**Half of this is deliberate and documented; half is not.** `ci.yml`'s header
records the intent plainly (AQU-564): *"Cloudflare Workers Builds owns automatic
pull-request compilation and route-free versions. This workflow is retained only
as an explicit fallback; it has no pull-request or push trigger and therefore
consumes no hosted runner minutes during ordinary repository activity."* That is
a real cost decision and not a mistake. But Workers Builds **compiles**; it does
not run a test, a lint or a typecheck. The gap between "PR compilation is
covered" and "PR verification is covered" is the whole finding.

**The part that is simply inconsistent.** `ci.yml:68` still says, immediately
above `lint`:

> `# Required branch-protection checks. Do not rename or add conditions without`
> `# updating the main/dev protection rules in the same control-plane change.`

Three jobs are documented as required branch-protection contexts inside a
workflow that cannot report on a PR. One of two things is true, and both are
worth knowing: either `main`/`dev` protection does require contexts named
`lint`/`typecheck`/`unit`, in which case no PR can ever satisfy them and every
one of them sits "Expected — waiting for status"; or protection does not require
them, in which case the comment describes a control that is not in force. This
PR resolves it empirically — GitHub reports `mergeable_state: "clean"` with only
the Jev check and the Cloudflare build present — so **it is the second**. A
control documented as required and not actually enforced is V4a's shape again,
and OPS-38's: a second control left thin in reliance on one nobody measured.

**This is OPS-21, two months on and worse.** 08-24 reported that *"the required
PR gate is red on `dev` and fails in the first of three sequential phases, so
the worker test suites and the SPA build never execute at all"*, with patches,
and recorded it rather than fixing it because none of it was auth/session work.
The suites are no longer merely unreachable behind a failing phase — their
workflow is not wired to pull requests at all.

**Why it matters beyond tidiness** [JUDGMENT]: it is the reason this pass found
six red test files that nothing had flagged (three in `auth-worker`, three under
`src/`, §Verification), and it is why the green tick on this very PR is not
evidence of anything. The green `pr` check here ran the adversarial suite, which
reported **"HARNESS UNAVAILABLE. The canary health check failed (2 of 2). This
run says nothing about the change."** A reviewer reading ✅ would reasonably infer
tests passed. Nothing did.

**Not fixed, deliberately.** Adding `pull_request:` to `ci.yml` is a one-line
change with consequences this pass cannot own: it starts consuming hosted runner
minutes on every PR — the exact cost AQU-564 set out to avoid — and it would go
red immediately on the six known-failing files, blocking unrelated work until
those are fixed. The ordering a maintainer has to choose (fix the six, then wire
the trigger, or wire it non-blocking first) is a control-plane decision, and the
comment at `ci.yml:68` warns that protection rules must change in the same
control-plane change. **Recommended**: decide whether the `lint`/`typecheck`/
`unit` contexts are meant to be required, then either wire `ci.yml` to
`pull_request` and fix the six red files, or correct that comment so it stops
describing enforcement that does not exist.

---

## Reviewed, no new finding

Each was read against the code, not assumed safe by category.

- **AQU-1239 / `platform_admins` (migration 0157) is correctly built.** The table
  is keyed by a lowercased, trimmed email with a `CHECK` that refuses anything
  else, so the primary key is the lookup key. `loadPlatformAdminEmails` and
  `isPlatformAdminEmail` memoise **per request only**, so deleting a row revokes
  on the next request — verified against `lib/request-memo.ts`, where a missing
  memo simply runs the loader (so the scheduled handler is correct too) and a
  rejected promise is not retained. A failed table read logs and contributes
  **nobody** — fail closed, and the `ADMIN_EMAILS` bootstrap is unioned in
  afterwards rather than replacing it. Every reader of `env.ADMIN_EMAILS` in the
  tree is inside `middleware/platform-admin.ts`; the other 40-odd mentions are
  comments and test fixtures, so the conversion left no stale consumer that would
  have silently matched nobody once deployed envs stopped setting the var.
- **Email-keyed admin identity cannot be shadowed.** The obvious attack on a
  table keyed by email — register the address and inherit the grant — was chased
  and does not work. `idx_users_email_ci ON users (LOWER(email))` makes the
  uniqueness check case-insensitive, and registration additionally rejects a
  username equal to anyone's email and vice versa (`routes/auth.ts:212`, the
  `87397102` fix). The `LOWER`-vs-`TRIM` asymmetry was tested specifically: the
  index normalises with `LOWER` only, while `isPlatformAdminEmail` normalises
  with `.trim().toLowerCase()`, so `" admin@…"` would have matched an admin row
  while sitting in a distinct `users` row — but `z.string().email()` rejects
  every leading/trailing-whitespace, NBSP, newline, NUL and zero-width variant
  (verified against the installed zod 4.6.5; `ADMIN@…` passes zod and is caught
  by the ci index). There is **no email-change route** in the tree — the only
  writes to `users.email` are registration, the legacy D1 JIT migration, and the
  dev/seed/test routes — so an account's email cannot be repointed at an admin
  address after the fact.
- **`email_verified_at` is written once and read nowhere** (`routes/auth.ts:795`
  is the only write; no non-test reader exists). Verification is decorative, as
  the schema's own "soft verification" comment says. Recorded rather than raised:
  it gates nothing today, so it is not a control that failed, but it is also not
  available as a mitigation — which matters for `platform_admins`, since the
  migration deliberately supports listing an admin **before** they sign up. An
  admin email listed but never registered is claimable by whoever registers it
  first, and nothing would require them to prove they control the mailbox. The
  step-up code is what stands in the way (it is emailed to the account address),
  and after OPS-44 that gate is now actually load-bearing for D2/D3/D7 rather
  than only for the console.
- **`ADMIN_EMAILS` is still accepted in production** — no environment gate, so
  `wrangler secret put ADMIN_EMAILS` would confer platform admin on a deployed
  worker with no deploy and no code review, which is V1's shape exactly. Not
  raised as a finding: the actor who can do that already holds `SECRET_KEY` and
  can mint a token for any user outright, so it grants nothing they lack, and
  they would still face the emailed step-up code. Worth knowing as the reason the
  AQU-1239 win is "the list is no longer *published*", not "the var is no longer
  *authoritative*".
- **The admin console's own gate is intact.** `requirePlatformAdmin` is a single
  choke point on `/api/v2/admin/*`; `requireAdminElevation` is mounted after only
  the three bootstrap routes (`/me`, `/elevation/request`, `/elevation/verify`),
  and `/me` is deliberately pre-elevation because it is how the SPA learns it
  must elevate. `ADMIN_REQUIRE_ELEVATION = "true"` in the top-level `[vars]` and
  in both `[env.production.vars]` and `[env.development.vars]`; the
  `WRANGLER_LOCAL=1` bypass is local/e2e only. OPS-35's `(user_id, session_key)`
  binding and OPS-36's scrypt-hashed codes are unchanged and still correct.
- **`services/source-linking.ts` signs a sync token but sets no `src` claim**, so
  it carries none of the platform exemptions. It is a `userId: 0` service token;
  its authorization lives elsewhere. Correctly absent from the minter ledger.
- **The `platform` grant's attribution is right even where its level is not.**
  `sourcePriority` puts `platform` lowest, so a genuine grant keeps attribution
  on a tie, and `access-payload.ts` reports `origin: { kind: "platform" }`
  honestly. The problem OPS-44 describes is the *level* (700) outranking genuine
  grants, not the attribution.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-44 | Un-elevated platform-admin authority minted cross-tenant sync tokens and PATs, disclosed orgs' live vendor API keys, and folded projects irreversibly | **Medium** — needs a platform-admin session, but *only* a session: a stolen 30-day access token suffices, which is the attacker OPS-35 was written for, and no step-up code appears anywhere in the chain | **High** — D2 draft text and D3 membership/activity read *and written* across every tenant (via the sync-worker's six `src: "platform"` exemptions), D7 vendor keys in plaintext, D3 real identity via a `pii` PAT that outlives the session, plus irreversible destruction of a donor project | **High** | Fixed |
| OPS-46 | No test/lint/typecheck suite runs on a pull request (`adversarial-jev.yml` is the only `pull_request`-triggered workflow); `ci.yml` still documents three jobs as required branch-protection contexts it cannot report | **Certain — it is the current state** | **Medium–High** [JUDGMENT] — no single breach, but it is why six red test files went unflagged and why a green tick on any PR, this one included, is not evidence. OPS-21's finding, now worse | **Medium–High** | Reported |
| OPS-45 | 36 of 44 route modules resolve a platform-admin-winnable role with no elevation decision | High that some are wrong [JUDGMENT] — one of the two examined in this pass (`org-settings`) turned out to disclose a credential | Unknown, bounded by one tenant's data per route; `changeset-approvals.ts` is the one flagged as likely worse | **Medium** | Reported |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Genuine (platform-free) project role, via the existing pure resolver with the admin flag forced off; own memo slot | `auth-worker/src/services/project-permissions.ts` (`resolveGenuineProjectRole`) |
| De-escalation helpers: return the caller's role unchanged when genuine or elevated, else the genuine role (null when admin power was the only path) | `auth-worker/src/services/elevation-gate.ts` (`roleWithoutUnelevatedAdmin`, `orgLevelWithoutUnelevatedAdmin`) |
| Sync-token mint fails the platform path closed **before signing**, structurally — in the mint core, not the route, so a caller that cannot observe elevation loses the path rather than minting past the gate | `auth-worker/src/services/sync-token-mint.ts` (`elevation_required`), `routes/sync-token.ts`, `lib/agent/command-tools.ts` |
| PAT scope level taken from de-escalated authority, closing the permanent cross-tenant credential (incl. `act` and `pii`) | `auth-worker/src/routes/credentials.ts` |
| Unredacted `orgProviderKeys` (D7) requires elevation when the write-level role rests only on admin power | `auth-worker/src/routes/org-settings.ts` |
| Irreversible sibling fold de-escalates and re-applies the `project_lead` floor on **both** sides | `auth-worker/src/routes/merge-sibling.ts` |
| Corrected the false premise that `source === "platform"` implies no genuine grant — the reason the gate was never extended, and the reason a naive extension locks operators out | `auth-worker/src/services/elevation-gate.ts` header |
| Drift guard: every module that can emit `src: "platform"` is a declared minter with its gate asserted; every mint-core caller has an explicit `platformElevated` decision; the four de-escalated paths keep their helpers; the sync-worker's six platform exemptions match a ledger, so a new exemption widens the radius visibly | `scripts/platform-elevation-coverage.test.ts` |
| Behavioural regression tests, incl. the operator-keeps-their-own-work cases that a flat 403 would have broken | `auth-worker/src/__tests__/admin-membership-elevation.test.ts`, `merge-sibling.test.ts`, `credentials.test.ts`, `org-settings-provider-keys.test.ts` |

**No UI/UX change.** A genuine member's request is byte-identical on every
touched route; the eleven existing `projectElevationDenial` responses are
byte-identical (the new `action` label defaults to the old wording); and with
`ADMIN_REQUIRE_ELEVATION` unset — local dev and e2e — every path behaves exactly
as before. The only callers that lose anything are un-elevated platform admins
acting outside their own grants, who regain it by elevating.

## Operator actions this change cannot perform

Both are out-of-band, like every GitHub/Cloudflare-side control this series
flags rather than assumes.

1. **Audit existing `aqk_` credentials for scopes that rest on admin power.**
   The fix stops new ones being minted that way; it does not revoke the old.
   Any credential whose `org_id`/`project_id` the owner cannot justify through a
   genuine grant was mintable un-elevated before today and should be revoked —
   `pii: true` and `mode: "act"` rows first. There is no evidence any were
   minted abusively (nothing in this repo can tell us), so this is hygiene
   following a closed gap, not incident response.
2. **Rotate any org's vendor API keys that an un-elevated admin session could
   have read**, if the operator set was ever broader than the people who should
   see tenants' keys. D7 keys are someone else's credential; the cost of
   rotating is theirs to weigh, so this is a decision to put to each org rather
   than one to make for them.

3. **Decide how a QA walker gets platform-admin identity on a preview.** A
   consequence of AQU-1239 that surfaced when the QA walk tried to exercise
   OPS-44's four paths on this PR's preview and could not: it signs in but gets
   `403 platform admin required`, because the preview auth-worker is deployed
   with **no `ADMIN_EMAILS`** (`scripts/cloudflare-stack-preview.mjs:56-63` sets
   six vars, not that one), so after AQU-1239 the `platform_admins` table is the
   only source of admin identity on a preview and no QA row exists on
   development storage. **The admin paths are therefore not QA-walkable on any
   preview** — worth knowing before the next pass plans to verify one there.

   Of the two ways to close it, the bootstrap var is much the safer: adding
   `ADMIN_EMAILS` to that block is per-preview, scoped to the preview worker,
   versioned in the repo, and disappears with the deployment, whereas a
   `platform_admins` row on shared development storage grants cross-tenant
   admin over every project in dev, persists beyond any one preview, and is
   invisible to config review — most of what this pass is about. Either way it
   is a human's call, because previews read shared development Hyperdrive and
   R2: real data for every project in dev. Not done here.

   Worth recording that elevation itself is *not* the obstacle, and that a
   preview is a faithful test of the gate rather than a bypass: previews set
   `ADMIN_REQUIRE_ELEVATION: "true"` and deliberately do not set
   `WRANGLER_LOCAL` (pinned by `cloudflare-stack-preview.test.ts:81`), yet
   `POST /admin/elevation/request` still returns the code in its own response
   body there, because previews bind no `EMAIL` service and run
   `ENVIRONMENT: "development"` (`routes/admin.ts:163`). Identity is the only
   missing piece.

Also still outstanding from 09-25 and unchanged: the `desktop-release-signing`
Environment needs required reviewers configured in repo settings to actually
hold the Tauri signing job (OPS-40).

## Verification

Each new assertion was confirmed **failing** against the pre-fix code before the
fix was restored (`git stash` of the one source file, re-run):

* `auth-worker`: `src/__tests__/admin-membership-elevation.test.ts` — **80
  passing** (7 new). Pre-fix: 2 failed — the platform-only mint was allowed, and
  an operator's genuine org role was masked by platform power so the token
  carried `src: "platform"` on their own org's project.
* `auth-worker`: `src/__tests__/credentials.test.ts` — **31 passing** (6 new).
  Pre-fix: **4 failed** — foreign-project scope, foreign-org scope, `act` and
  `pii` were all mintable un-elevated.
* `auth-worker`: `src/__tests__/org-settings-provider-keys.test.ts` — **12
  passing** (4 new). Pre-fix: 1 failed — the un-elevated admin received the live
  `gemini-tts` key in plaintext.
* `auth-worker`: `src/__tests__/merge-sibling.test.ts` — **20 passing** (5 new),
  including the pre-existing AQU-1550 test that a platform operator with no
  donor grant *can* fold, which still passes because elevation is not required in
  the test env — confirming the fix is inert where it should be.
* Root: `npx vitest run --project app scripts/platform-elevation-coverage.test.ts`
  — **11 passing**. Verified the guard bites: with the mint gate stashed, the
  minter assertion fails.
* `npx tsc --noEmit` in `auth-worker` reports no error in any changed file (the
  only remaining output is the `partyserver` `TS2307`s from `sync-worker`, whose
  package is not installed in this environment — same as 09-28 and 10-05).
* `npx eslint` clean on all 15 changed files.
* **The PR's own green CI tick is not evidence — see OPS-46.** The only check a
  pull request receives here is the `pr` job of `adversarial-jev.yml` (plus the
  Cloudflare build), and on this PR it reported *"HARNESS UNAVAILABLE … This run
  says nothing about the change."* No test, lint or typecheck suite runs on a
  PR in this repository, so the local runs below are the whole of the automated
  evidence for this change.
* Full `auth-worker` suite (`npx vitest run`): **307 files, 3618 passing, 2
  expected-fail, 7 failures in 3 files — all pre-existing, none in anything this
  change touches.** Each was verified rather than assumed:
  - `rls-backstop.test.ts` (5) — the replayed RLS migrations abort on
    `column "target_lang" does not exist`, which the setup catches and logs as
    *"expected on some PGlite versions"* before continuing with the policies
    never installed. The real cause is AQU-1611 (`2026-10-07`, "Stop projection
    writers filling target_lang"), the last commit to touch this file: the
    column is gone but a migration the test replays still names it.
  - `changeset-floor.test.ts` (1) — `requiredRoleForChangeset` returns 500 where
    the test expects 600 for a non-terminology settings patch.
    `lib/changeset-floor.ts`, `routes/changeset-approvals.ts` and the test are
    **byte-identical to `origin/dev`**, and `changeset-floor.ts` imports nothing
    this change touches.
  - `source-linking-cycle.test.ts` (1) — a legitimate B→C link 400s. Source,
    route and test are byte-identical to `origin/dev`, and the failure
    **reproduces with this change's `project-permissions.ts` reverted to
    `origin/dev`**, which is the decisive check since that is the only changed
    module `source-linking` reaches.

* Root `app` suite (`npx vitest run --project app`): **1762 files, 19964
  passing, 23 skipped, 5 failures in 3 files — all pre-existing.** This change
  touches **nothing under `src/`** (`git diff --name-only origin/dev HEAD` has
  no `src/` entry), and all three files are byte-identical to `origin/dev`:
  - `src/partner-integrations/biblica/__tests__/idml.biblica-scripture.test.ts` (3)
  - `src/lib/i18n/namespaces/no-duplicates.test.ts` (1)
  - `src/lib/egress/zip-core.test.ts` (1) — *"survives output larger than one
    flush window"* dies on the 60 s stall watchdog (AGENTS.md rule 15). The
    first guess was CPU contention from concurrent suite runs; **re-running the
    file alone disproves that** — 63 s and the same failure on an otherwise
    idle machine. It is a real red test on `dev`, not a scheduling artifact.

  Note the 6 `ScriptAlignmentDialog.test.tsx` failures 10-05 reported as
  pre-existing are gone; these three are different files.

  **The auth-worker reds are a regression on `dev`, not here, and worth
  flagging:** 10-05
  recorded this package as *"266 files, 3085 passing, 2 expected-fail, 0
  failures… there is now nothing red in this package."* Three files have gone
  red in the week since, two of them traceable to work that merged on 10-07.
  Reported rather than fixed — none of it is auth/session work, and `dev` owns
  it — in the same spirit as OPS-21.

---

_Re-run the mechanical parts of this review with: `npx vitest run --project app
scripts/platform-elevation-coverage.test.ts && cd auth-worker && npx vitest run
src/__tests__/admin-membership-elevation.test.ts src/__tests__/credentials.test.ts
src/__tests__/org-settings-provider-keys.test.ts src/__tests__/merge-sibling.test.ts`._
