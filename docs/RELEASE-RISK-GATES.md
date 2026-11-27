# Release risk gates: hourly production deploys

Decision of 2026-10-30 (Ryder, Matthew; Kieran to review): move from about
one production release a day to one an hour, without more risk for clients.
The event log is append-only, so most bugs are fixed forward and the
projection rebuilt; nothing is lost. A short list of outcomes can not be
fixed forward, and those paths get a person in the loop. Everything else
ships on the hour.

This document is the risk list, the file map that implements it, the line
itself, and what is still open. The code it describes:

| Piece | Where |
| --- | --- |
| Risk areas and file map | `scripts/release-risk.mjs` (`classifyFiles`, `HOLDING_AREAS`, `AREA_GATES`) |
| PR labels `risk:<area>` and the gate jobs | `.github/workflows/risk-label.yml` → `scripts/release-risk-label.mjs` |
| Planner (cherry-pick model, walk policy) | `scripts/release-plan.mjs`, `scripts/release-plan-walk.mjs` |
| Cut (builds the branch by pick) | `scripts/release-cut.mjs`, `.github/workflows/release-cut.yml` (hourly at :05, on tag, on button) |
| Hold nudge | `scripts/release-hold-nudge.mjs` (a step of the cut workflow) |
| Build and type-check on a release branch | `.github/workflows/release-verify.yml` (check name `release-verify`) |
| Deploy | `.github/workflows/release-deploy.yml` (when verify finishes, and every ten minutes) → `scripts/release-deploy-check.mjs` |
| Rollback watch and line halt | `scripts/release-rollback.mjs`, the `release:halt` issue label |
| Walk status on a PR | `.github/workflows/walk-status.yml` → `scripts/release-walk-status.mjs`; the walker is `docs/routines/WALK-PRS.md` |
| Dev deploy on merge | `.github/workflows/dev-deploy.yml` |
| Update indicator in the app | `src/components/UpdateIndicator.tsx`, `src/hooks/useUpdateCheck.ts` |

Both deploy workflows are off until a repository variable is set to `on`:
`HOURLY_RELEASE` for production, `AUTO_DEV_DEPLOY` for dev. Flipping each
one is the decision to let that environment deploy without a person
pressing a button.

Four more repository variables are the switches of the 2026-11-19 changes
(§6). Each can be flipped without a deploy:

| Variable | Unset | Set |
| --- | --- | --- |
| `WALK_POLICY` | No walk verdict holds a PR (`advisory`, §7). | `fail-only`: a failed walk holds. `strict`: anything but a PASS walk holds, as before 2026-11-19. |
| `AUTO_ROLLBACK` | The rollback watch reports what it would do. | Not read since 2026-11-27: `release-deploy.yml` passes `off` (§7). |
| `AUTO_MIGRATE` | A migration holds for a person; the deploy stops at a pending one. | `on`: a green `migration-gate` lifts the hold, and the deploy applies additive pending migrations itself. |
| `ROLLBACK_WATCH_MINUTES` | 10 | How long the watch runs after a deploy. |

## 1. Forbidden outcomes, confirmed against the code

The meeting named four. The draft had six; the two it dropped are noted.

| # | Outcome | Why it can not be fixed forward | Code path (see §2) |
| --- | --- | --- | --- |
| 1 | Lost or corrupted user edits | A `target.cell.commit` that never reaches the log, or projects over a newer head, is a contributor's work gone. The log is the only copy. | events, offline-sync |
| 2 | Bad events written to the event log | Every later read, replay and rebuild trusts the log. A malformed payload, a wrong `parent_id`, or a kind the projection does not know poisons the project from that `server_seq` on. Schema changes to the envelope change what "valid" means for 300k–1M rows per Bible project. | events, migration |
| 3 | One organization sees another's data | Not recoverable: it is already seen. Every project-scoped request passes through a small set of verifiers (§2 auth); a route that queries by `projectId` without one is the whole failure. | auth |
| 4 | Offline sync drops changes | The outbox (IndexedDB) is the only copy of an offline edit until the server acks it. A flush that removes an event on a non-permanent error, or a reconnect that skips the queue, loses it silently. | offline-sync |
| — | Broken auth or permissions (draft) | Same files as #3. Folded into `auth`. | auth |
| — | Wrong export or published output (draft) | Not on the meeting's list. Export is deterministic from the projection and re-runnable, and the round-trip suites cover it. Noted as `export`, **not holding**. Open item, §5. | export |

Also holding, unchanged from the planner's 2026-09 rules: a **schema
migration** (a person applies it to Neon; a deploy past a pending migration
is the recurring 500 class) and the **deploy machinery** itself.

## 2. File map

The table is `AREA_PATTERNS` in `scripts/release-risk.mjs`; this is the
reasoning. Test files (`*.test.*`, `e2e/`, `__tests__/`) never count. A
file can be in several areas.

**events** (holding) — the write path of the append-only log.
- `sync-worker/src/events/**`: `types.ts` (the `EventKind` union), `route.ts`
  (`POST /events`, head compare-and-swap at the candidate's `parentId`
  against `cellHeads`, stale siblings 200-accepted and reported),
  `event-insert.ts`, `event-projection.ts` (`CHAIN_MUTATING_KINDS`,
  `isChainArbitrated`, every projection statement), `dispatch.ts`,
  `handlers/**` (chain claims), `chain-claims.ts`, `chain-head-replay.ts`,
  `rebuild.ts` and `projection-snapshot.ts` (the replay), the importers
  that mint events (`import-*.ts`, `merge-sibling-route.ts`, `link-sync.ts`,
  `link-adopt.ts`). Read routes under `events/` ride along: naming each one
  would let a read route that starts writing slip through.
- `sync-worker/src/project-do.ts`, `project-do-types.ts` (WebSocket write path).
- `sync-worker/src/checking/policy.ts` (envelope validation).
- `src/lib/sync/events-emit.ts`, `chain.ts`, `target-commit-parent.ts`,
  `source-commit-chain.ts`, `bulk-events.ts`, `bulk-import.ts`,
  `create-targets.ts`, `settle-own-event.ts`, `lane-write-rejections.ts`
  (client parent selection: a wrong `parentId` is a lost edit by CAS).
- `src/lib/import.ts`; `db/postgres/schema.sql` (also `migration`).

**offline-sync** (holding) — the client's write buffer, its drain and the reconciler.
- `src/lib/sync/outbox.ts`, `outbox-flush.ts` (HTTP drain; 403 quarantine;
  removal only on accepted or permanent 4xx), `outbox-recovery.ts`,
  `outbox-sanitize.ts`, `outbox-types.ts`, `ws-reconciler.ts`,
  `backoff.ts`, `flush-applied.ts`, `live-apply.ts`,
  `confirmed-target-heads.ts`, `cqrs-bridge.ts`.
- `src/hooks/useOutboxFlusher.ts` (the Web-Lock-serialised flush cycle).

**auth** (holding) — every chokepoint before project data.
- auth-worker: `index.ts` (router), `middleware/**` (`resolveSession`,
  `authMiddleware`, platform admin), services `project-permissions`,
  `org-permissions`, `lane-grants`, `elevation-gate`, `sync-token-mint`,
  `access-payload`, `invite-scopes`, `team-roles`, `user-search-access`;
  routes `auth`, `sync-token`, `project-members`, `member-scopes`,
  `invites`, `admin`, `admin-billing`, `credentials` (PATs), `access`,
  `access-links`, `access-audit`, `org-access`, `changeset-approvals`,
  `mcp-oauth`, `users`, `me`.
- sync-worker: `auth.ts` (`verifyTokenFor{Doc,Project,File}`), `index.ts`
  (dispatch), `admin.ts`, `events/authorize.ts` (the sole
  `AuthorizedEvent` minter), `events/role-policy.ts`,
  `events/membership.ts` (live re-check; note it fails open on a missing
  project row and on a thrown error), `events/tool-provenance.ts`,
  `events/lane-read-wall.ts`, `events/export-floor.ts`,
  `external/read-auth.ts`, `external/token-bridge.ts`,
  `external/org-read-routes.ts`, `external/authority.ts`,
  `external/identity-bridge.ts`, `external/mcp-oauth-metadata.ts`,
  `lib/service-auth.ts`, `lib/admin-auth.ts`, `lib/admin-secret.ts`.
- `db/shared/project-roles.ts`, `access-grants.ts`, `api-credentials.ts`,
  `lane-visibility.ts`, `lane-grants.ts`, `workspace-access.ts`,
  `visibility-floors.ts`; `db/shim/**` (the query executor).

**migration** (holding): `db/postgres/migrations/**`, `db/postgres/schema.sql`.

**infra** (holding, no gate): any `wrangler.toml`,
`config/cloudflare-deployments.json`, the workflows on the web release line
or behind a required check (every `.github/workflows/*.yml` not listed under
`ci` below), the deploy scripts (`cloudflare-*`, `verify-*`,
`resolve-deployment-target`, `tag-release`, `tag-metadata`,
`record-github-deployment`, `assert-workers-build-env`, `ci-build`, and the
desktop line's `desktop-release*` and `desktop-bundle*`, including
`scripts/lib/desktop-release.ts` and `scripts/lib/desktop-bundle.ts`), the
file map itself (`release-risk*`), and every gate's own machinery: the
harnesses, corpora and goldens of §3, `src/lib/sync/offline-gate/**`, and
`scripts/gate-*`.

**release-tooling** (holding, gate `plan-diff`): the other `scripts/release-*`
files: planner, walk lookup, cut, deploy check, stall and hold reports,
rollback watch, notifier. Split out of infra on 2026-11-19: what a person
checked on these was "does the line still do what it did", which a dry run
answers.

**deps** (holding, gate `deps-gate`): `sync-worker/` and `auth-worker/`
`package.json` and `pnpm-lock.yaml`. Split out of the gate machinery on
2026-11-19: 28 of the 122 infra touches merged since 2026-11-01 were these
four files, almost all version bumps.

**export** (noted): `src/lib/export/**`, `packages/idml-roundtrip/**`,
`src/lib/parsers/usfm-lossless/**`, the sync-worker export routes.

**sync** (noted): the rest of `sync-worker/src/` and `src/lib/sync/`.

**ci** (noted): workflows that neither deploy the web app, decide a release,
nor run a gate or a required check: `tauri-*`, `desktop-release-*`,
`dependency-audit`, `audio-delta-sync`, `dev-neon-refresh`,
`adversarial-jev`, `notify-help-bot`, `e2e-hetzner`. GitHub runs a workflow
from dev the moment it merges, so keeping one of these out of a release
slice protected nothing; the hold only delayed the other files in the PR.
The list is by name: a new workflow is infra until someone places it.

Everything else (UI, copy, agent harness, audio, comments, search, …) has
no area and ships on the next cut unless its walk failed (§3, *Plan*).

## 3. The line

```
PR → dev            risk-label.yml labels it risk:<areas> and runs the gate of each area it touches;
                    walk-status.yml reports the walk as the `qa-walk` status; ci.yml runs the suites its diff touches
merge to dev        dev-deploy.yml (when on): neon:apply:dev, deploy dev
:05 every hour      release-cut.yml: plan, nudge on PRs held past 4 h, cut, push release/YYYY/MM/DD-NN
   push             release-verify.yml (production build, auth-worker and sync-worker type-checks; §7) + smart Jev (Hetzner)
                    — fires only because the cut pushes as RELEASE_BOT_TOKEN; a GITHUB_TOKEN push starts nothing
verify finishes     release-deploy.yml (when on; also every ten minutes): if no `release:halt` issue is open,
                    release-verify=success and Jev≠FAIL on HEAD → apply additive migrations (when on) → deploy:aquilla → tag
   tag              release-cut.yml again (dispatched; a GITHUB_TOKEN tag does not chain on its own)
   +10 minutes      rollback watch: failed invocations against the hour before, then a live check;
                    a bad release is promoted back and the line halted (when on; otherwise reported)
```

**Plan.** `release-plan.mjs` lists every PR merged to dev that the tagged
production tip does not carry (by `(cherry picked from commit …)`
provenance or PR number), classifies each by the files its merge touched,
and reads its walk verdict and the `release:approved` label from GitHub.
A PR is *held* when a holding area it touches has no green gate (below)
or its walk holds; the label clears both. Which walks hold is the walk
policy (`release-plan.mjs`, `walkHolds`). Under the default, `fail-only`,
only a walk that tried and could not prove the claim holds: FAIL, FLAKY,
BLOCKED. A PR nobody walked (`unknown`) and a PASS at test level only
(`partial`) ship. `WALK_POLICY=strict` is the rule as it was until
2026-11-19: anything but `PASS` or `none` holds. §6 has why it moved.
The walk is read
from the bot's comment in either shape it posts (the `## Bot walk — PR <n> @
<sha>` heading, or the `<!-- aquilla-qa-walk <sha> -->` marker it has opened
with since 2026-11-06), and only from an author with standing in the
repository: an organization member, the owner or a collaborator
(`author_association` on the comment), or a login named in the
`WALK_TRUSTED_LOGINS` repository variable. Anyone can comment on a PR in a
public repository, so a stranger's `**PASS**` or `**FAIL**` is not a walk. A PASS the bot qualified, such as `**PASS (test level
only)**`, is `partial`: it ran tests and never opened a preview; it holds
only under the strict policy. A walk may be
posted after the merge: the planner takes the newest walk that names the
PR's head sha, which is how a dev re-walk (`e2e/journeys/PR-BOT.md`,
*Re-walk on dev after merge*, for a PR whose preview walk a pending
migration blocked) replaces the BLOCKED comment before it. Held PRs are
skipped, not a wall: the plan is the ready PRs in dev order plus the held
list with a reason each.

**Direct commits.** A commit pushed straight to `dev` with no PR sits on
dev's first-parent line like a PR merge, and the plan lists it in its dev
position (`direct: true`, with its sha and subject where a PR has a number
and a title). It has no walk, no gate run and no PR to carry
`release:approved`, so its files decide. A commit that touches only the
generated locale catalogs (`src/lib/i18n/messages/<locale>.ts`, never
`en.ts`, `index.ts` or `all.ts`, and `src/lib/i18n/source-hashes.json`) is
ready and is picked like a PR. Any other direct commit is held as `not a
PR` until a person picks it by hand (Cut, below). Only a direct commit
that changes no file (a merge that brought nothing in) is left out.
Until 2026-11-20 the planner skipped every commit without a PR number and
said nothing: six localization commits pushed between 2026-11-14 and
2026-11-20 never reached the release line, and #2075 and #2124, which
appended locale keys after them, were listed as `pick conflict in
src/lib/i18n/source-hashes.json` on every hourly cut. The record is
`docs/decisions/0014-direct-dev-commits-on-the-release-line.md`.

**Gates: how a high-risk area becomes low-risk by test.** A gate is a
required check on the PR's head sha, named in `release-risk.mjs`
`AREA_GATES`, that proves the area's forbidden outcome did not happen for
that change. The planner reads the newest run of each gate check off the
head sha; `success` takes that area off the PR's holding list. Built
today:

- **`events` → `replay-gate`** (`risk-label.yml`, only for PRs touching
  the events area). The corpus of real projects (`sync-worker/replay-corpus/`,
  event logs plus lanes, chain claims and seq counters, fetched from the
  private snapshots bucket) and the committed synthetic corpus each seed a
  fresh in-process Postgres (PGlite), replay through the production
  rebuild endpoint from genesis, and every projection table is hashed
  (`cells`, `cell_validators`, `files`, `file_section_progress`, comments,
  audio, glosses, links, morph, concepts, waivers, attachments,
  backtranslations). The hashes must equal `golden.json`. A corpus that
  failed to fetch fails the job (`REPLAY_CORPUS_REQUIRED=1`), so a missing
  corpus never passes as green. The job also fails when `golden.json`
  changed in the PR: an intentional projection change is exactly the case
  that goes to a person, and the golden's diff is what they review before
  adding `release:approved`. A gate passing does not excuse a failed walk,
  and a PR's other holding areas (a migration beside the events change)
  still hold. Two things keep the gate honest: the planner accepts a
  gate run only from GitHub Actions (`app.slug`), and the gate's own
  machinery (`sync-worker/replay-corpus/**`, the harness under
  `__tests__`, `scripts/replay-corpus.mjs`, the workflow) is classified
  as `infra`, which holds with no gate, so a PR cannot edit the harness
  or the golden and pass itself.
- **`auth` → `auth-matrix`** (`risk-label.yml`, only for PRs touching the
  auth area). A table-driven permission matrix in two halves, one per
  worker, each a test that sends real requests through the worker's
  handlers against a PGlite fixture and compares every answer to a
  committed golden (`auth-worker/permission-matrix/golden.json`,
  `sync-worker/permission-matrix/golden.json`; harness
  `auth-worker/src/__tests__/permission-matrix.test.ts`,
  `sync-worker/src/__tests__/permission-matrix.test.ts`). The auth-worker
  half drives the session routes with the shared access fixture
  (`helpers/access-fixture.ts`: one org with every membership shape, a
  second personal org as the cross-org target, a platform admin, a removed
  member, an anonymous caller) over project reads and writes, member
  management, invites, sync-token mint, PAT mint, org and user access, and
  `/admin/*`. The sync-worker half drives sync tokens (contributor, viewer,
  lead, platform, wrong project, removed member with a still-valid token,
  missing project row, expired, wrong secret), Agent API credentials
  (unscoped, org-scoped, cross-org, cross-project, read-only, revoked, a
  user with no grant) and the admin bearer over project reads, `POST
  /events`, the external reads, changeset prepare, export and `/admin/*`.
  The golden row is the status, plus the ids returned for list routes and
  accepted/rejected for the event write, so "sees another org's data" is a
  diff and not a guess. `UPDATE_AUTH_MATRIX=1` regenerates; the job fails
  when either golden changed in the PR, so an intentional permission
  change is the case that goes to a person, with the golden diff as what
  they review. Same honesty rules as the replay gate: GitHub Actions runs
  only, and the matrix's own chain (both `permission-matrix/`, both
  harnesses, auth-worker's test helpers, setup file and vitest/tsconfig/
  dependency set, `db/shared/test-lane-fill.ts`, and
  `db/shared/test-pg-harness.ts`, the template both harness databases are
  copied from) is `infra`.

  **`events/membership.ts` fails open on purpose, and the matrix pins it.**
  The write-perimeter re-check reports `ok` for a project with no row and
  for a thrown query (its header comment). Decision: keep both. The
  sync-token route 403s an unknown `projectId` (AQU-299), so no live token
  exists for a project without a row and closing that case would only break
  fixtures; the thrown-query case degrades to the 15-minute token TTL
  rather than 500ing every write in a partial outage. Both are golden rows
  (`membership-fail-open …`, and `token_missing_project POST /events`), so
  a PR that changes either flips the golden and goes to a person.

- **`offline-sync` → `offline-gate`** (`risk-label.yml`, only for PRs
  touching the offline-sync area). The real outbox, its HTTP drain
  (`flushOutboxBatch` under `useOutboxFlusher`), the recovery journal and
  the WebSocket reconciler run 35 scripted faults against a fake server
  that records what it accepted: offline then online, 5xx then success, a
  response lost mid-batch, an expired token, a 403, a permanent 4xx, a
  second tab, a reload mid-flush, a socket dropped mid-send. The shipped
  client drains over HTTP only: nothing under `src/` sends the
  `outbox.event` frame the worker accepts, so the four socket rows prove
  the reconciler's half (a truthful `send()`, reconnect, parsed
  `event.applied` and `event.stale`) under a sender the harness supplies. The harness, not the scenario, checks the invariant:
  every enqueued event ends accepted by the server, still in the outbox, or
  held or removed by a documented rule, and never in none of them. The
  per-scenario outcome is `src/lib/sync/offline-gate/golden.json`; the job
  fails when the golden changed in the PR. Scenarios and what is not
  covered: `src/lib/sync/offline-gate/README.md`.
- **`migration` → `migration-gate`** (`risk-label.yml`,
  `scripts/gate-migration.ts`; counts only while `AUTO_MIGRATE` is `on`).
  Three legs. *Additive*: every statement the PR's new migration files run
  is on a short list production's current code cannot notice (a new table,
  a new nullable or defaulted column, a new index, a new type), with the
  forms that rewrite or lock `events` and `cells` taken off it. The list
  is also what keeps a migration from running anything else as it applies
  (2026-11-27): `CREATE TABLE … AS` is a query and is off it, and an
  expression Postgres evaluates over existing rows (an `ADD COLUMN`
  default, check or generated column, an index expression or `WHERE`) may
  call only the built-ins in `APPLY_TIME_FUNCTIONS`, because `CREATE
  FUNCTION` is additive and those are the places a migration could call
  what it had just created. The gate reads a file through `scanSql`
  (`scripts/neon-migration-file.ts`) and Postgres runs the file's own
  text, so the scanner ends a literal where Postgres does: an `E'\''`
  escape string and a `$` inside an identifier used to hide the statement
  after them from the list. *Schema*:
  the base commit's `schema.sql` plus the new files is, catalog for
  catalog, the PR's `schema.sql`, which is the drift that answers 500 with
  every test green. *Old code, new schema*: the BASE commit's replay
  corpus and both permission matrices still answer their goldens on the
  PR's `schema.sql`. That is the state production is in between the
  migration and the deploy. The replay in this leg hashes only the columns
  the BASE commit's `schema.sql` has for each projection table
  (`REPLAY_BASELINE_SCHEMA`, the base schema the job keeps beside the
  PR's; `baselineColumns` in the harness). The harness hashes whole rows
  and the base golden was written from the base columns, so a column the
  PR adds, NULL or defaulted on every row, changed every hash of its
  table and failed this leg for exactly the migration the additive leg
  allows; no change inside the PR could turn it green (first seen on
  AQU-2664, five nullable columns on `cell_audio`). An added column is
  now left out and named in the job log. What the base commit's code can
  know about is still compared: a different value in a column the base
  has, a different row count, and a base column the PR dropped or renamed
  (an error by name, even on a table with no rows) all fail, pinned in
  `sync-worker/src/__tests__/replay-corpus-baseline.test.ts`. The
  `replay-gate` and `deps-gate` runs set no baseline and hash every
  column, as `golden.json` was written. The harness is the base
  commit's, so a PR gets this once its base has it. An edited or removed
  migration file, or a statement off the list, is a person's call.
  Measured on the four
  migrations merged 2026-11-12 to 2026-11-18 (0201, 0202, 0203, 0205): all
  four pass the first two legs.
- **`release-tooling` → `plan-diff`** (`risk-label.yml`,
  `scripts/gate-plan-diff.mjs`). The base commit's own
  `scripts/release-*.test.*` pass against the PR's scripts, and on today's
  real queue the PR's planner, cut and deploy check answer exactly as the
  base's do: the same PRs ready and held for the same reasons, the same
  picks producing the same tree, the same deploy decision. A difference is
  the PR changing what ships on purpose; the printed diff is what a person
  reviews.
- **`deps` → `deps-gate`** (`risk-label.yml`, `scripts/gate-deps.mjs`).
  Nothing but dependency versions changed in a worker's `package.json` (no
  script, no override, no alias or git source); the packages the gates run
  through (`vitest`, `@electric-sql/pglite`) resolve in the lockfile to
  what the base resolves them to; and the replay corpus and both matrices
  hold on the new set.

Four of these run their checker from the base commit, checked out beside
the PR as a worktree, and all of their own files are `infra`: the same
honesty rule as the first two gates.

**Cut.** `release-cut.mjs` starts a branch at the tagged tip and
`git cherry-pick -x` each ready entry onto it, in dev order: `-m 1` for a
merge commit; a squash merge and a direct commit have one parent and are
picked as they are. This is what Matthew did by hand, mechanised. A pick
that does not land is reported as held with a reason a person can act on,
and the cut continues with the rest:

- `pick conflict in <paths>; needs #N`: git stopped on unmerged paths and
  the pick is aborted. `needs #N` is the newest held PR merged before it
  whose diff touches one of those paths, read off the `files` the plan
  carries per PR (no GitHub call), which is almost always the PR it was
  built on; approving that PR is the fix. With no such PR the entry stops
  at the paths. When what it was built on is a held direct commit, the
  reason reads `needs direct commit <short sha>`, and picking that commit
  by hand (below) is the fix.
- `empty pick: already in base, or needs #N`: git stopped with nothing to
  commit ("The previous cherry-pick is now empty"). Either production
  already carries the change, or the change only exists relative to a
  held PR and is a no-op against the base. When the plan proves the first
  (`release-cut.mjs`, `provablyInBase`: the plan lists the PR's files and
  no PR still off the branch touches any of them), the pick is committed
  empty and listed as **Recorded, no change**: its `-x` provenance is what
  the planner reads, so the PR leaves the queue. Otherwise the pick is
  skipped, never committed empty: provenance on a change production lacks
  would mark the PR released. That PR is listed on every cut until the
  held PR it needs ships. (Before 2026-11-19 every empty pick was skipped,
  and #1968, #2046, #2047 and #2051 sat on every cut for days waiting for
  a person to "record it by hand" with no stated way to do so.)

**Releasing a held direct commit.** A direct commit held as `not a PR`
is listed on every cut, in the held line, as `<short sha> "<subject>" (not
a PR)`. A run that cuts nothing because no entry is ready lists it in its
run summary too. (A run that stops on a release in flight plans nothing;
that release's own notes carry the list.) It stays listed until a person
acts, because the pick is the sign-off:

1. Decide that it should ship. Read the commit: nobody reviewed it. A
   shell version bump, for one, raises the minimum shell version
   production asks for, so that shell has to be published first.
2. On the release branch in flight (or one cut by hand), run
   `git cherry-pick -x <sha>` and push. Add `-m 1` only when the commit is
   a merge. `release-verify` and smart Jev run again on the new HEAD.
3. Once that branch is tagged, the planner reads the `(cherry picked from
   commit <sha>)` line and the commit leaves the list. `-x` is not
   optional here: a PR picked without it is still known by the number in
   its subject, and a direct commit has no number.

When the pick comes out empty because production already has the change,
record it instead with an empty commit on the release branch whose body
carries the same line, the remedy an empty pick of a PR already has:
`git commit --allow-empty -m "Record <short sha> as released" -m "(cherry
picked from commit <full sha>)"`, the last part on one line with all 40
characters of the sha.

Each reason appears in the run summary as a `- #N: <reason>` line, in the
held line of the release notes, and in the commit comment. When nothing
could be picked, the summary lists each PR with its reason instead of the
bare "every ready PR conflicted" line that, from 2026-10-31, hid an empty
pick (#1752, built on held #1750) behind a real conflict (#1744 on held
#1743). The branch is pushed and the release notes posted as a commit
comment with the picked table and the held line. None of this changes who
deploys or the `release:approved` sign-off.

**Verify.** The push runs `release-verify` and smart Jev. Since 2026-11-27
`release-verify` is the production build and the auth-worker and
sync-worker type-checks, not the whole suite (§7). This is where "a ready
PR that depended on a held one and still applied as a patch" is caught
when it fails to compile: on its first day the reduced check held
release/2026/11/27-08, where #2242 was picked without the held #2240 it
imports from. A pick that compiles and fails only a test is no longer
caught here (the suites ran on the PR in `ci.yml`), and one that fails a
journey is reported by Jev, not held (§7). The fix is the same as today: a
person picks the held PR onto the branch or reverts the pick there, and
the new HEAD re-verifies. The held PR's approval alone does not reach a
branch already in flight, because no new cut starts while one is open.

**Deploy.** `release-deploy-check.mjs` reads, for the branch HEAD only,
the `release-verify` check conclusion and the newest Jev marker comment's
decision line, and whether an issue labelled `release:halt` is open. Deploy
iff none is open, verify succeeded and Jev reported anything but FAIL. No
Jev comment yet means wait for the next look. The workflow looks when
Release verify finishes green and every ten minutes; the stall report for
a red verify stays hourly, at :45. Until 2026-11-19 it looked only at :45
and the worker suites ran back to back in one job (23 minutes of
auth-worker, then 47 of sync-worker), so every release took about two
hours from cut to tag and twelve a day was the ceiling with no hold at
all. The deploy is the unchanged `pnpm run deploy:aquilla` chain (schema
guard, SPA, sync, auth, live checks, calver tag). The deploy job does not
run on the release branch's ref, so `GITHUB_REF_NAME` is `dev` there while
the checkout is the release branch; the job names that branch in
`DEPLOY_REF_NAME`, which the deploy guard (`scripts/verify-deploy-branch.sh`),
the build stamp (`scripts/build-info.ts`) and the Cloudflare version label
read ahead of GitHub's ref.

**Migrations at deploy.** While `AUTO_MIGRATE` is `on`, the deploy job runs
`neon:status:prod` first and, when migrations are pending, asks
`gate-migration.ts additive` about exactly those files. If every statement
is additive it runs `neon:apply:prod --snapshot` (a Neon branch off
production first, as the apply guard requires) and deploys. If not, it
leaves them pending and the schema guard stops the deploy as it always
did: a non-additive migration reaches the line only through
`release:approved`, and the person who approved it applies it.

**Rollback watch.** After the tag, `release-rollback.mjs watch` compares
each production Worker's failed-invocation rate since the deploy with its
rate over the hour before (Cloudflare Workers analytics), for ten minutes,
then runs the live checks once. One Worker over the limit (5%, or three
times its own baseline, on at least 200 invocations) or a failed live
check is a bad release. While `AUTO_ROLLBACK` is `on`, the watch promotes
the versions recorded before the deploy back to 100% on all three surfaces
and opens an issue labelled `release:halt`, which stops every deploy until
a person closes it: production is then behind its own tag, and the next
slice is cut from that tag. Otherwise it posts what it would have done.
The limits of the signal are in the script's header: a handler that
catches its error and answers 500 is not a failed invocation, and a subtle
wrong answer is invisible to both checks.

**Tag → next cut.** The tag closes the release; the deploy workflow
dispatches the cut so the next slice starts at once; the :05 schedule is
the backstop.

**In the app.** `useUpdateCheck` polls `/version.json` once a minute (one
poller, shared). A newer sha shows a small pulsing "Update" mark next to
the version string in the left-rail footer and the floating badge; click
reloads. `UpdateOnNavigate` reloads on the next route change that is not
into `/project/:id/editor…`, never on its own while in the editor. The
floating "Update available" button is gone. Stale lazy chunks still
self-heal through `chunk-reload.ts` as before.

## 4. What the held path looks like for a person

1. A PR touching a holding area gets `risk:<area>` labels at open time,
   and the gate job of each area it touches runs on its head.
2. It merges to dev like any other (ci.yml, walk, review agent).
3. Every cut skips it while an area it touches has no green gate, and lists
   it under **Held, not in this release** with the reason. A PR whose
   every holding area has a green gate is not held at all: it never
   reaches this list. `infra` has no gate and always reaches it.
4. Four hours after the merge, the cut workflow names the PR once in the
   release channel (`release-hold-nudge.mjs`), with how many others have
   waited as long.
5. Manual QA as today (the dev deploy carries it). When satisfied, a
   person adds `release:approved` to the PR.
6. The next cut picks it. If the manual QA finds a problem, the fix is a
   new PR; the held PR just stays held.

A direct commit has no PR, so steps 1, 2 and 4 do not exist for it: it is
either a catalog-only commit the cut picks, or it is listed as `not a PR`
until a person picks it onto a release branch (section 3, *Releasing a
held direct commit*).

Holding is by merged diff, not by label: removing a `risk:*` label changes
nothing, and `release:approved` is the one label the planner reads.

`release:approved` is for a held PR. From 2026-11-12 to 2026-11-17 nearly
every merged PR carried it, risk label or none, because nearly every PR
was held for a missing walk; when the labelling stopped, so did the
releases. A week in which most PRs need the label is the line reporting a
broken gate, not a week of risky changes.

## 5. Open items

- **Replay corpus: real projects. Done.** The golden pins 20 production
  projects and the synthetic one (`sync-worker/replay-corpus/golden.json`).
- **Auth matrix: breadth.** The gate runs (section 3) over the route
  families named there. Not yet in the table: member-scopes writes,
  access-links, changeset approvals, the MCP tools/call adapter, and the
  lane read wall (`LANE_READ_WALL=1`). Each is one more probe row; add it
  and regenerate the golden in a PR of its own so the diff is the review.
- **Automatic rollback: built, in observe mode.** §3, *Rollback watch*.
  Open: flip `AUTO_ROLLBACK` to `on` after the watch has reported
  correctly on real releases (its thresholds are a first guess); add the
  `CLOUDFLARE_ANALYTICS_TOKEN` secret (a Cloudflare token with Account
  Analytics read and nothing else), without which every watch reads
  `no-signal`; and add a signal for handled 5xx answers (the zone's
  HTTP analytics for the API host, or PostHog error tracking), which the
  invocation count cannot see. The desktop hot bundle a release publishes
  is not rolled back.
- **Automatic migrations: built, switched off.** §3, *Migrations at
  deploy*. Open: prove the stored `NEON_API_KEY` can create a branch (the
  dev refresh has been refused with HTTP 401 on it, AGENTS.md), then flip
  `AUTO_MIGRATE`. Until then a migration PR holds as before, gate green or
  not.
- **Walks.** The walker routine (`docs/routines/WALK-PRS.md`) has to be
  created in a Claude account, and its accounts added to the dev access
  list (`docs/security/preview-access.md`). `qa-walk` reports on every PR
  but is not a required check; requiring it is the step that makes "a PR
  merges on a PASS walk" true again, and should wait until the routine
  has walked a week of PRs.
- **Offline gate: two losses it pins, and what it cannot drive.** The
  golden records two events that end in no bucket, each marked as a known
  loss so the gate fails if either changes. (1) `flushOutboxBatch` deletes
  a non-comment event that has no `fileId` without posting it or telling a
  listener; no current emitter omits `fileId`, and
  `outbox-flush.test.ts` pins the delete as a programmer-error path, but
  it is the shape of forbidden outcome #4 and a quarantine would keep the
  event readable. (2) The recovery journal covers `target.cell.commit`
  only, so a lone validate enqueued in the instant before a page is torn
  down is gone. Both are decisions for a person, not fixed here. Not
  driven: multi-account drain, Tauri offline routing, storage quota, real
  page teardown and cross-tab locks
  (`src/lib/sync/offline-gate/README.md`).
- **`export` as a holding area.** Not on the meeting's list, on the
  draft's. Default here: noted, not holding. Decide.
- **`RELEASE_BOT_TOKEN`** (done 2026-10-31: a fine-grained PAT, contents +
  deployments write on this repo, kept in Ryder's Keychain). The "release
  tags" ruleset needs no bypass: its rule is a recorded production
  Deployment, which `tag-release.sh` writes first. The token matters for a
  second reason too: GitHub runs no push-triggered workflow for a push
  made with `GITHUB_TOKEN`, so the cut's checkout pushes as this token or
  the release branch never verifies itself. If the tag push fails,
  production is already live and the tag is a person's job
  (`scripts/tag-release.sh`).
- **Dev deploy on merge waits for a green baseline** (Matthew). 22 root
  vitest failures and a red sync-worker pair were on dev as of 2026-10-06;
  `release-verify` runs the full suite, so a red baseline blocks every
  hourly deploy until it is green. That is the intended pressure, but it
  means the first switch-on is a cleanup, not a flag flip. Since
  2026-11-27 `release-verify` is the build and the type-checks (§7), so a
  red test on dev no longer blocks the line; only a baseline that does not
  compile does.
- **Jev verdict provenance: done.** `release-deploy-check.mjs` counts a
  marker comment only from a trusted login (`JEV_TRUSTED_LOGINS` in
  `release-deploy.yml`, default the runbook's reporting identity), and any
  FAIL from it holds even if a later comment says PASS. A GitHub App for
  the runner replaces the login list when it exists.
  The comments on the HEAD are read across every page, and `release-verify`
  counts only as a check run GitHub Actions produced.
- **Jev cadence.** One Hetzner stack, one suite at a time, queued. A
  cut whose Jev run is slow simply deploys at a later ten-minute look; two cuts can not race because one release is in flight at
  a time. If the queue backs up, the Jev run on an older HEAD is
  superseded and the deploy waits.
- **PR-level test trimming** (meeting: many PR tests belong on the
  release). `release-verify` now carries the full suite; what to drop
  from `ci.yml` on PRs is a separate change with its own review. Reversed
  2026-11-27 (§7): `release-verify` no longer runs the suites, so `ci.yml`
  on the PR is the only place they run, and this argument no longer
  supports dropping any of them from it.
- **Kieran** has not seen this yet.

## 6. 2026-11-19: why the line did one to three releases a day

Three weeks after the decision above, production got one to three releases
a day against 13 to 25 PRs merged each working day. The measurement, from
the release cut of 2026-11-19 21:12 UTC, with 47 merged PRs waiting:

| Why held | PRs |
| --- | --- |
| No walk comment at all | 28 |
| Walk at test level only | 7 |
| Walk failed | 1 |
| A holding area with no gate (3 infra, 2 offline-sync, 1 migration with offline-sync) | 6 |
| Approved, but the pick was empty | 4 |

So the hold was not the risk areas. The `events` and `auth` gates were
doing their job: every PR carrying `risk:events` or `risk:auth` in that
list was held for its walk, not its area. The hold was the walk, and the
walk was missing for reasons that had nothing to do with the changes:

1. 2026-11-06 to 2026-11-12, the planner could not read the comment format
   the walker had moved to (`release-plan-walk.mjs` header).
2. From 2026-11-12, CI previews admit only the dev access list (#2004),
   the walker's accounts were not on it, and the walker fell back to
   running tests and posting `PASS (test level only)`.
3. Nothing started a walk and nothing noticed a missing one before the
   cut.

Meanwhile people cleared the hold by labelling every PR `release:approved`
in batches, so the line ran at the speed of the labelling.

What changed, each against the cause it answers:

| Cause | Change |
| --- | --- |
| An unproven walk held three PRs in four, and is not an outcome that cannot be fixed forward | Default walk policy `fail-only`; the rollback watch stands behind it |
| The walker could not sign in, and said so nowhere | Access-list rows for its accounts; the routine stops and reports a refusal instead of falling back |
| Nothing started a walk or showed a missing one | The scheduled routine; the `qa-walk` status on every PR |
| `offline-sync`, `migration`, and most of `infra` had no gate | `offline-gate`, `migration-gate`, `plan-diff`, `deps-gate`; off-line workflows are `ci` |
| About two hours from cut to tag | Worker suites sharded; deploy looks when verify finishes |
| 47 PRs waited two days in silence | The four-hour hold nudge |
| Empty picks listed forever | Recorded when the plan proves production has them |

The principle this section is here to keep: when the line holds most PRs
for the same reason, the reason is a gate to build or a gate that broke,
and the answer is a test that proves the specific outcome, not a label.


## 7. 2026-11-27: the holds that never decided are advisory

An audit of the 1,234 PRs merged to dev from 2026-10-01, their 7,962
workflow runs and 6,700 comments, asked of each check: did it keep a real
problem from production, or only delay good work. Sections 1 to 6 describe
the line as it was built; where they disagree with this section, this
section is the line as it runs.

| Check | What the record shows | Now |
| --- | --- | --- |
| Smart Jev on a release HEAD | 87 runs: 78 INCONCLUSIVE, 9 HARNESS UNAVAILABLE, no PASS, no FAIL | Advisory. `release-deploy-check.mjs` `decide` no longer waits for it or holds on it; the verdict is named in the reason. |
| Walk | 68 PRs with a FAIL: 17 fixed and walked to PASS, 51 merged with no later PASS. 74 BLOCKED, 18 FLAKY | Advisory. `WALK_POLICY` unset is `advisory`: no verdict holds. `fail-only` and `strict` are the switches back. |
| `release-verify` | 82 runs, 2 failures, one a runner setup fault | Build and type-check only (`pnpm run build`, each worker's `type-check`). The PRs ran their suites in `ci.yml`. |
| Adversarial Jev on PRs | 2,041 runs, 234 runner-hours; all 170 red checks were the harness; one attack made 93 of 150 "failure found" comments | Nightly only. |
| Rollback watch | One rollback, of a strings-only release, on a reconnect burst; the line stopped 32 hours (#2212) | Report only: `release-deploy.yml` passes `AUTO_ROLLBACK: "off"` whatever the variable says. |

What still holds a PR: a holding area with no green gate (`replay-gate`,
`auth-matrix`, `offline-gate`, `migration-gate`, `plan-diff`, `deps-gate`,
and `infra` with no gate), until the gate is green or a person adds
`release:approved`. Those are the outcomes of §1 that cannot be fixed
forward. Everything else ships on the next cut and is fixed forward: in the
same eight weeks dev took no revert of a bad merge.

The line still stops on an open `release:halt` issue, which a person can
open; the watch no longer opens one.
