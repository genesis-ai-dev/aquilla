# Lane-ID rollout runbook (AQU-1240)

Ordered, copy-pasteable steps to take first-class lane IDs live. Run **dev end
to end first**, confirm, then repeat the identical sequence on **prod**. Every
schema change is additive or non-blocking; the one hard-to-reverse step
(`SET NOT NULL`, migrations 0104–0111) runs only after verify is clean (§4).

## 0. Cast & concepts

- **Migrations** (`db/postgres/migrations/*.sql`) change schema shape. Applied
  manually with `pnpm neon:apply:<env>` (NOT automatic on merge/deploy —
  `deploy-workers.yml` only runs `neon:status`, a drift *check*).
- **Backfill** (`scripts/neon-backfill-lanes.ts`) is a **data** script, not a
  migration. It inserts the `lanes` rows per project, fills `lane_id` on the
  eight content tables, then writes `project_member_lane_roles` (one row per
  person per lane they can already see). Idempotent, resumable, dry-run by
  default. Runs *between* applying the additive migrations and deploying the
  PR2 workers. The grant phase does not clobber a row that is already there.
- **Verify** (`scripts/neon-verify-lanes.ts`) is read-only; it reports
  `nulls`/`orphans` per table and, with `--require-complete`, exits non-zero if
  any `lane_id` is still NULL.
- **Who:** Matthew (or Ryder) runs `neon:apply` / `neon:backfill` / `neon:verify`
  against dev and prod. Luke drives the PR merges + worker deploys.

## 1. PR1 — additive (already open)

Columns, `CONCURRENTLY` indexes, composite FK `NOT VALID`, dual-read reads, and
forward-writes of `lane_id`. Nothing enforced yet; fully back-compatible.

`pnpm neon:apply` applies **every pending file**, not a numeric slice. After PR1
is on `dev` and before PR2 is merged, the pending lane files are:

- `0091_project_member_lane_roles.sql` (only if that ledger row is not already applied)
- `0096_lanes.sql`
- `0097_lane_id_columns.sql`
- `0098_idx_cells_lane_id.sql` (CONCURRENTLY)
- `0099_idx_cell_validators_lane_id.sql` (CONCURRENTLY)
- `0100_idx_file_section_progress_lane_id.sql` (CONCURRENTLY)
- `0101_idx_assignments_lane_id.sql` (CONCURRENTLY)
- `0102_fk_lane_id.sql` (composite FK, `NOT VALID`)

`0092`–`0095` on `dev` are **not** lane files (`0092_structural_cell_counters`,
`0093_assignment_cells_file_idx`, `0094_structural_audio_counters`,
`0095_derive_missing_book_rows`). If those are still pending they apply in the
same `neon:apply` and that is fine. Do not merge PR2 first: its files
(`0103`, then `0104`–`0111`) would be pending too, and `0104` fails on purpose
while any `lane_id` is still NULL.

```
# after PR1 is merged to dev, and PR2 is not:
pnpm neon:status:dev          # pending: 0096_lanes … 0102_fk_lane_id (+ 0091 if new)
pnpm neon:apply:dev           # additive columns, CONCURRENTLY indexes, FK NOT VALID
pnpm neon:status:dev          # expect: ledger + schema clean
# deploy PR1 workers (dual-read + forward-write go live):
pnpm deploy:aquilla:dev:api   # neon:status gate must be green
```

At this point new writes stamp `lane_id`; reads fall back to `target_lang` when
it is NULL. Safe to sit here indefinitely.

## 2. Backfill dev

Run this from the PR2 branch (`Luke-Lane-Updates-2`), after §1 and before the
PR2 deploy. `dev` does not contain the grant phase until PR2 is merged. The
script only needs the PR1 tables (`0091`, `0096`–`0102`) applied. It does not
need `0104`–`0111`.

```
pnpm neon:backfill:lanes:dev              # DRY RUN — lane plan and grant plan
pnpm neon:backfill:lanes:dev --apply      # writes lanes, fills lane_id, inserts grants
```

Read the dry run before `--apply`. A `WARN` line is a lane scope that matched
no lane or more than one. That scope is not granted. A member whose every
scope was skipped would see no target lane once the read wall is on. Fix the
scope or accept that before deploying PR2 workers. Members with no lane scope
get one row per target lane that exists at backfill time. Maintainer and
above, and platform admins, get no rows (their role already sees every lane).

A grant stores `lanes.id`. The product shows `lanes.name`. One language string
does not open two lanes. A re-run does not change a grant someone edited later.

Big single project? Scope + bound it:

```
pnpm neon:backfill:lanes:dev --apply --project <id> --statement-timeout 600s
```

## 3. Verify dev

```
pnpm neon:verify:lanes:dev                    # report total/nulls/orphans
pnpm neon:verify:lanes:dev --require-complete  # gate: exit 1 if any NULL/orphan
```

- `orphans` must be **0** always (a validated FK guarantees it).
- `nulls` must be **0** before the NOT NULL cutover. The four auxiliary tables
  (`artifact_bindings`, `scene_briefs`, `contextual_runs`, `contextual_drafts`)
  are the likely stragglers — re-run the backfill or resolve the missing lane.

## 4. PR2 — validate the FKs, then require lane_id

Do this only after §3 is green (`--require-complete`). `neon:apply` runs every
pending file in order, so merging PR2 and applying before the backfill will
fail `0104` on purpose (NULLs remain). That failure rolls back just that file;
fix by finishing the backfill, then apply again.

- `0103_validate_fk_lane_id.sql` flips all 8 composite FKs from `NOT VALID` to
  VALIDATED (non-blocking scan).
- `0104`–`0111` make `lane_id` `NOT NULL` on each table, one file per table,
  via a non-blocking validated CHECK so the lock window stays short. Each file
  fails and rolls back if that table still has a NULL.

PR2's dev and prod wrangler blocks set `LANE_READ_WALL=1` on **both** the sync
worker and the auth worker. `pnpm deploy:aquilla:dev:api` is what turns the
read wall on. `neon:status` does not look at grant rows. Do not deploy those
workers until §2 `--apply` has finished in this environment and every `WARN`
line is either fixed or accepted. An empty grant table plus the flag hides
every target lane from everyone below Maintainer.

Local `wrangler dev` and e2e do not set the flag.

```
# after PR2 is merged to dev, verify --require-complete passed, AND the grant
# phase of §2 has been applied:
pnpm neon:apply:dev           # 0103, then 0104..0111
pnpm neon:status:dev          # clean
pnpm neon:verify:lanes:dev --require-complete
pnpm deploy:aquilla:dev:api   # this deploy turns the read wall on
```

## 5. Prod

Repeat §1 → §4 against prod, in order, only after dev is green:

```
pnpm neon:status:prod && pnpm neon:apply:prod         # first: 0096_lanes … 0102_fk only (PR1)
pnpm neon:backfill:lanes:prod                         # dry run; read WARN lines
pnpm neon:backfill:lanes:prod --apply                 # lanes, lane_id, and grants
pnpm neon:verify:lanes:prod --require-complete        # must pass before PR2 apply
pnpm neon:apply:prod                                  # then: 0103 + 0104..0111
pnpm deploy:aquilla:... (prod equivalents)            # turns the read wall on
```

## 6. Rollback notes

- Additive columns / indexes / `NOT VALID` FK: harmless to leave; no rollback
  needed. Dual-read tolerates NULL `lane_id`.
- `VALIDATE CONSTRAINT` (0103): to undo, `ALTER TABLE t VALIDATE`→ there is no
  "invalidate"; drop+re-add `NOT VALID` if ever required (not expected).
- Backfill: additive only (`lane_id IS NULL` guarded; grants use
  `ON CONFLICT DO NOTHING`). Re-running is safe and does not edit a grant
  that is already present.
- The hard-to-reverse step is `SET NOT NULL` (`0104`–`0111`). It is gated:
  the migration fails if any `lane_id` is still NULL, and it must not be
  applied until `--require-complete` is green.

## 7. What is NOT in this rollout

- **AQU-730 write wall** (the allow→deny flip on `enforceScopes`): still last.
  The read wall turns on with the PR2 worker deploy, and only after §2 has
  written grants. New lanes created after the backfill do not auto-grant.
- **Default-lane elimination** (`''` → tag) and rename/BLANK UX: later slices.
  Lane names stay whatever the lane backfill already wrote.
