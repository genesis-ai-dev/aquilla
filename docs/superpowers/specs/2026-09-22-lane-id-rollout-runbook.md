# Lane-ID rollout runbook (AQU-1240)

Ordered, copy-pasteable steps to take first-class lane IDs live. Run **dev end
to end first**, confirm, then repeat the identical sequence on **prod**. Every
schema change is additive or non-blocking; the one destructive-ish step
(`SET NOT NULL`) is deferred and gated (see §5).

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

```
# after PR1 is merged to dev:
pnpm neon:status:dev          # expect: pending migrations 0092..0098 listed
pnpm neon:apply:dev           # applies 0092..0098 (additive; CONCURRENTLY idx)
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

## 4. PR2 — validate the FKs (this PR)

`0099_validate_fk_lane_id.sql` flips all 8 composite FKs from `NOT VALID` to
VALIDATED (non-blocking scan). Drift-neutral, no behavior change for writers.

```
# after PR2 is merged to dev:
pnpm neon:apply:dev           # applies 0099 (VALIDATE CONSTRAINT x8)
pnpm neon:status:dev          # clean
pnpm deploy:aquilla:dev:api   # no code change strictly required; keep in sync
```

## 5. NOT NULL cutover — DEFERRED (not in PR2)

The eight `SET NOT NULL` migrations live in
`db/postgres/deferred-notnull-cutover/` (out of the apply path). They are correct
and rehearsed but **not shipped yet** because flipping `schema.sql` to `NOT NULL`
breaks ~75+ PGlite suites via the seed helper. Promote them in a dedicated PR
(seed-harness overhaul + remove dual-read), then:

```
pnpm neon:verify:lanes:<env> --require-complete   # MUST pass (0 nulls) first
pnpm neon:apply:<env>                              # applies 0100..0107
```

Each is idempotent and self-gating: run against a not-yet-complete table and the
`VALIDATE CONSTRAINT` step fails loudly and rolls back — that failure is the
gate, do not force it.

## 6. Prod

Repeat §1 → §4 against prod, in order, only after dev is green:

```
pnpm neon:status:prod && pnpm neon:apply:prod         # 0092..0098, then 0099
pnpm neon:backfill:lanes:prod --apply                 # (between the two applies)
pnpm neon:verify:lanes:prod --require-complete
pnpm deploy:aquilla:... (prod equivalents)
```

## 7. Rollback notes

- Additive columns / indexes / `NOT VALID` FK: harmless to leave; no rollback
  needed. Dual-read tolerates NULL `lane_id`.
- `VALIDATE CONSTRAINT` (0099): to undo, `ALTER TABLE t VALIDATE`→ there is no
  "invalidate"; drop+re-add `NOT VALID` if ever required (not expected).
- Backfill: additive only (`lane_id IS NULL` guarded); re-running is safe.
- The only hard-to-reverse step is `SET NOT NULL` (§5) — which is why it is
  deferred and gated behind a green `--require-complete` verify.

## 8. What is NOT in this rollout

- **AQU-730 read/write wall** (PR3): the grant substrate ships dormant in PR1
  (`0091`, token mint, `resolveVisibleLanes`). Wiring the wall + the grant
  backfill + the deny-flip is a separate track; the deny-flip must come only
  after the grant backfill populates prod, or it locks out translators.
- **Default-lane elimination** (`''` → tag) and rename/BLANK UX: later slices.
