# Deferred: `lane_id` SET NOT NULL cutover (AQU-1240)

These eight migrations enforce `lane_id NOT NULL` on every lane-bearing table via
the zero-downtime validated-CHECK pattern (add a `NOT VALID` CHECK → non-blocking
`VALIDATE` → `SET NOT NULL`, which PG12+ satisfies from the validated CHECK
without a second scan → drop the redundant CHECK).

They are **staged here, out of the `migrations/` apply path**, on purpose. They
are correct for a live database but are **not** safe to ship yet because:

1. **Test harness.** `sync-worker/src/__tests__/helpers/pg-test-db.ts` loads
   `db/postgres/schema.sql` directly into PGlite, and its `seedRows` helper
   fills any omitted `NOT NULL` text column with `""`. With `lane_id NOT NULL`
   in `schema.sql`, every test that seeds `cells` / `assignments` / etc. without
   a `lane_id` inserts `lane_id = ""`, which then violates the composite FK
   (there is no lane with id `""`). ~75+ suites seed these tables; only ~10 seed
   `lanes`. Promoting NOT NULL therefore requires a seed-harness overhaul
   (universally seed a project's lanes + resolve `lane_id` in `seedRows`).
2. **Dual-read.** While the dual-read fallback (`lane_id IS NULL` → resolve by
   `target_lang`) is still in the read paths, the transitional NULL state is a
   real, tested scenario. NOT NULL makes that fallback dead code; its NULL-insert
   tests should be removed in the same change.

## How to promote (later PR)

1. Overhaul the seed harness so every seeded project gets its lanes and every
   content-row seed carries a resolvable `lane_id`.
2. Remove the dual-read fallback + its NULL-lane_id tests.
3. Flip the eight `lane_id TEXT` columns to `lane_id TEXT NOT NULL` in
   `db/postgres/schema.sql`.
4. Move these files back into `db/postgres/migrations/` (renumber to the next
   free indices at that time).
5. Gate: run the verify script (`pnpm neon:verify:lanes:<env>`) first — it must
   report **0** NULL `lane_id` on every table for that environment. The four
   auxiliary tables (`artifact_bindings`, `scene_briefs`, `contextual_runs`,
   `contextual_drafts`) are the likely stragglers.

## Why PR2 still ships value without these

`migrations/0099_validate_fk_lane_id.sql` flips all eight composite FKs from
`NOT VALID` to VALIDATED. That is drift-neutral and breaks no tests, yet it
proves and enforces that every non-null `lane_id` is a real lane — the integrity
guarantee the read wall (PR3, keyed on the lane tag) depends on.
