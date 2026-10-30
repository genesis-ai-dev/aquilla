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
| Risk areas and file map | `scripts/release-risk.mjs` (`classifyFiles`, `HOLDING_AREAS`) |
| PR labels `risk:<area>` | `.github/workflows/risk-label.yml` → `scripts/release-risk-label.mjs` |
| Planner (cherry-pick model) | `scripts/release-plan.mjs`, `scripts/release-plan-walk.mjs` |
| Cut (builds the branch by pick) | `scripts/release-cut.mjs`, `.github/workflows/release-cut.yml` (hourly at :05, on tag, on button) |
| Full suite on a release branch | `.github/workflows/release-verify.yml` (check name `release-verify`) |
| Hourly deploy | `.github/workflows/release-deploy.yml` (:45) → `scripts/release-deploy-check.mjs` |
| Dev deploy on merge | `.github/workflows/dev-deploy.yml` |
| Update indicator in the app | `src/components/UpdateIndicator.tsx`, `src/hooks/useUpdateCheck.ts` |

Both deploy workflows are off until a repository variable is set to `on`:
`HOURLY_RELEASE` for production, `AUTO_DEV_DEPLOY` for dev. Flipping each
one is the decision to let that environment deploy without a person
pressing a button. Until then everything else here (labels, planner, cuts,
verify) already runs and changes nothing about who deploys.

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

**offline-sync** (holding) — the client's write buffer and its two drains.
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

**infra** (holding): any `wrangler.toml`, `config/cloudflare-deployments.json`,
`.github/workflows/**`, and the deploy/release scripts (`cloudflare-*`,
`verify-*`, `resolve-deployment-target`, `tag-release`, `tag-metadata`,
`record-github-deployment`, `assert-workers-build-env`, `ci-build`,
`release-*`).

**export** (noted): `src/lib/export/**`, `packages/idml-roundtrip/**`,
`src/lib/parsers/usfm-lossless/**`, the sync-worker export routes.

**sync** (noted): the rest of `sync-worker/src/` and `src/lib/sync/`.

Everything else (UI, copy, agent harness, audio, comments, search, …) has
no area and ships on the hour once its walk is `PASS` or `none`.

## 3. The line

```
PR → dev            risk-label.yml labels it risk:<areas>; ci.yml runs the suites its diff touches
merge to dev        dev-deploy.yml (when on): neon:apply:dev, deploy dev
:05 every hour      release-cut.yml: plan, cut, push release/YYYY/MM/DD-NN
   push             release-verify.yml (typecheck, lint, all unit, all workers, build) + smart Jev (Hetzner)
:45 every hour      release-deploy.yml (when on): if release-verify=success and Jev≠FAIL on HEAD → deploy:aquilla → tag
   tag              release-cut.yml again (dispatched; a GITHUB_TOKEN tag does not chain on its own)
```

**Plan.** `release-plan.mjs` lists every PR merged to dev that the tagged
production tip does not carry (by `(cherry picked from commit …)`
provenance or PR number), classifies each by the files its merge touched,
and reads its walk verdict and the `release:approved` label from GitHub.
A PR is *held* when a holding area it touches has no green gate (below)
or its walk is not `PASS`/`none`; the label clears both. Held PRs are
skipped, not a wall: the plan is the ready PRs in dev order plus the held
list with a reason each.

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
- **`auth` → permission matrix**: not built (open items).

**Cut.** `release-cut.mjs` starts a branch at the tagged tip and
`git cherry-pick -x` each ready PR onto it (`-m 1` for merge commits).
This is what Matthew did by hand, mechanised. A pick that conflicts is
aborted and reported as held (`pick conflict`); the cut continues. The
branch is pushed and the release notes posted as a commit comment with the
picked table and the held line.

**Verify.** The push runs the whole suite (`release-verify`) and smart
Jev. This is where "a ready PR that depended on a held one and still
applied as a patch" is caught: it fails to compile, fails a test, or fails
a journey. The fix is the same as today: a person adds the held PR's
approval or reverts the pick on the branch; a new HEAD re-verifies.

**Deploy.** `release-deploy-check.mjs` reads, for the branch HEAD only,
the `release-verify` check conclusion and the newest Jev marker comment's
decision line. Deploy iff verify succeeded and Jev reported anything but
FAIL. No Jev comment yet means wait for the next hour. The deploy is the
unchanged `pnpm run deploy:aquilla` chain (schema guard, SPA, sync, auth,
live checks, calver tag).

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

1. A PR touching a holding area gets `risk:<area>` labels at open time
   and a run summary saying it is off the hourly line.
2. It merges to dev like any other (ci.yml, walk, review agent).
3. Every hourly cut skips it and lists it under **Held, not in this
   release** with the reason. An events-only PR whose `replay-gate` check
   is green is not held at all: it never reaches this list.
4. Manual QA as today (the dev deploy carries it). When satisfied, a
   person adds `release:approved` to the PR.
5. The next cut picks it. If the manual QA finds a problem, the fix is a
   new PR; the held PR just stays held.

Holding is by merged diff, not by label: removing a `risk:*` label changes
nothing, and `release:approved` is the one label the planner reads.

## 5. Open items

- **Replay corpus: real projects.** The gate runs (section 3) but the
  corpus holds one synthetic project. Someone with production read
  access captures ~20 real projects (`node scripts/replay-corpus.mjs
  export --url … --project …`, then `upload`, then
  `UPDATE_REPLAY_GOLDEN=1`; `sync-worker/replay-corpus/README.md`).
  Pick projects clients work in daily, a few thousand to ~50k events each:
  PGlite replays a Bible-scale log too slowly for a PR check. Until real
  projects are in, the gate proves the harness and the chain rules it
  pins, not production shapes. The `fetch` step in `risk-label.yml` needs
  `CLOUDFLARE_API_TOKEN` with R2 read on `aquilla-snapshots`.
- **Permission matrix for `auth` PRs** (meeting: "send requests to the
  auth API and record what it does"). Candidates to grow into the
  table-driven gate: `auth-worker/src/__tests__/access-attacks-parity`,
  `access-characterization`, `members-matrix-batched`,
  `permission-semantics`; sync-worker `foreign-role-enforcement`,
  `external-project-reads`, `member-removed`. Not confirmed table-driven
  in this pass. The gap found while mapping: `events/membership.ts` fails
  open on a missing project row and on a thrown error (by design, with a
  comment); worth a deliberate decision.
- **Automatic rollback on error-rate rise.** `cloudflare-version-deploy.mjs`
  promotes `${versionId}@100%` and keeps no previous version id; there is
  no rollback script. Design: record the previous Worker version id per
  surface in the deploy manifest, read PostHog error-tracking (or the
  Workers error rate) for the 10 minutes after a deploy, and promote the
  previous version back if the rate exceeds the hour before by a fixed
  factor. Until then the fix is forward: next hour.
- **`export` as a holding area.** Not on the meeting's list, on the
  draft's. Default here: noted, not holding. Decide.
- **Tag push from the workflow.** The "release tags" ruleset requires a
  recorded production Deployment and may refuse `GITHUB_TOKEN`. First
  enablement needs `RELEASE_BOT_TOKEN` (contents + deployments write,
  on the ruleset's bypass list) or a one-time test that `GITHUB_TOKEN`
  is accepted. If the tag fails, production is already live and the tag
  is a person's job (`scripts/tag-release.sh`).
- **Dev deploy on merge waits for a green baseline** (Matthew). 22 root
  vitest failures and a red sync-worker pair were on dev as of 2026-10-06;
  `release-verify` runs the full suite, so a red baseline blocks every
  hourly deploy until it is green. That is the intended pressure, but it
  means the first switch-on is a cleanup, not a flag flip.
- **Jev verdict provenance.** `release-deploy-check.mjs` reads the Jev
  decision from any commit comment carrying the smart-tests marker, with
  no author check, the same trust the walk lookup extends to QA-bot PR
  comments. The repo is private, so only a collaborator could post a
  forged PASS, but this is a production deploy gate: before switching
  `HOURLY_RELEASE` on, filter on the bot's login or app id (or have Jev
  publish a check run, which cannot be forged), and let any FAIL from
  the trusted author hold rather than the newest comment winning.
- **Jev cadence.** One Hetzner stack, one suite at a time, queued. An
  hourly cut whose Jev run takes longer than an hour simply deploys the
  hour after; two cuts can not race because one release is in flight at
  a time. If the queue backs up, the Jev run on an older HEAD is
  superseded and the deploy waits.
- **PR-level test trimming** (meeting: many PR tests belong on the
  release). `release-verify` now carries the full suite; what to drop
  from `ci.yml` on PRs is a separate change with its own review.
- **Kieran** has not seen this yet.
