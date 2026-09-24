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
  migration. It inserts the `lanes` rows per project and fills `lane_id` on the
  eight content tables. Idempotent, resumable, dry-run by default. Runs *between*
  applying the additive migrations and enforcing anything.
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

```
pnpm neon:backfill:lanes:dev              # DRY RUN — prints the lane plan
pnpm neon:backfill:lanes:dev --apply      # writes lanes + fills lane_id
```

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

```
# after PR2 is merged to dev, and verify --require-complete passed:
pnpm neon:apply:dev           # 0103, then 0104..0111
pnpm neon:status:dev          # clean
pnpm neon:verify:lanes:dev --require-complete
pnpm deploy:aquilla:dev:api
```

## 5. Prod

Repeat §1 → §4 against prod, in order, only after dev is green:

```
pnpm neon:status:prod && pnpm neon:apply:prod         # first: 0096_lanes … 0102_fk only (PR1)
pnpm neon:backfill:lanes:prod --apply
pnpm neon:verify:lanes:prod --require-complete        # must pass before PR2 apply
pnpm neon:apply:prod                                  # then: 0103 + 0104..0111
pnpm deploy:aquilla:... (prod equivalents)
```

## 6. Rollback notes

- Additive columns / indexes / `NOT VALID` FK: harmless to leave; no rollback
  needed. Dual-read tolerates NULL `lane_id`.
- `VALIDATE CONSTRAINT` (0103): to undo, `ALTER TABLE t VALIDATE`→ there is no
  "invalidate"; drop+re-add `NOT VALID` if ever required (not expected).
- Backfill: additive only (`lane_id IS NULL` guarded); re-running is safe.
- The hard-to-reverse step is `SET NOT NULL` (`0104`–`0111`). It is gated:
  the migration fails if any `lane_id` is still NULL, and it must not be
  applied until `--require-complete` is green.

## 7. What is NOT in this rollout

- **AQU-730 write wall** (the allow→deny flip on `enforceScopes`): still last.
  The grant substrate ships in PR1. The **read** wall is now on this branch
  but dark. Set `LANE_READ_WALL=1` on the sync worker and the auth worker
  only after `project_member_lane_roles` is backfilled in that environment.
  Until then every member still sees every lane. Turning it on against an
  empty grant table hides every target lane from everyone below Maintainer.
- **Grant backfill** is not in this branch. It has to run before the flag.
  A grant row stores `lanes.id`. The product shows `lanes.name`, which may
  be the same text as the language. One row is one lane. A language match
  does not grant a second lane. New lanes after the backfill do not auto-grant.
- **Default-lane elimination** (`''` → tag) and rename/BLANK UX: later slices.
