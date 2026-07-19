# AQU-538 lanes → Neon `main` (production) — zero-downtime rollout

**Goal:** apply the target-language-lane schema to the production Neon branch with
**full backward compatibility** — no window where the serving worker lacks a valid
`ON CONFLICT` arbiter, and no long table-rewrite lock.

**Why the committed migrations (`0057`–`0060`) are not run as-is on `main`:**
`0057`/`0058` do a hard `DROP CONSTRAINT … ; ADD PRIMARY KEY (…, target_lang)`.
On a populated table that (a) rebuilds the unique index under an `ACCESS EXCLUSIVE`
lock and (b) instantly invalidates the old 4-column `ON CONFLICT(project_id,
file_id, cell_id, side)` that the **currently-deployed** code uses — breaking every
cell write until the new code is live. Those files remain correct for **fresh DBs**
(schema.sql already defines the 5-col PK) and **staging** (a blip is fine). For
`main` we split them into expand → deploy → contract.

`0059` (new table) and `0060` (`assignments.target_lang`, no PK change) are already
fully backward-compatible and are folded into Phase 0.

---

## Preconditions
- Neon direct-host creds loaded: `set -a; . ./.env; set +a` (uses `NEON_PG_HOST`,
  the **direct** host, per `scripts/pg.ts` — required for DDL).
- You are pointing at the **main/production** branch, not staging. Double-check
  `echo $NEON_PG_HOST` / `$NEON_PG_DB` before every command below.
- The lane-aware workers are built and ready to deploy but **not yet deployed** to
  production.

## Phase 0 — expand (safe while OLD workers serve)
Fast, metadata-only column adds + the new table. Old 4-col PKs stay in force.
```bash
npx tsx scripts/pg.ts db/postgres/rollout/aqu538-00-expand.sql
```

## Phase 1 — build 5-col unique indexes CONCURRENTLY (non-blocking)
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and `pg.ts` runs a
`.sql` file as one implicit transaction — so run each as a **single inline
statement** (one `pg.ts` call each):
```bash
npx tsx scripts/pg.ts "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cells_pkey5 ON cells (project_id, file_id, cell_id, side, target_lang)"
npx tsx scripts/pg.ts "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cell_validators_pkey5 ON cell_validators (project_id, file_id, cell_id, target_lang, username)"
npx tsx scripts/pg.ts "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS file_section_progress_pkey5 ON file_section_progress (project_id, file_id, scope, section_key, target_lang)"
```
**After Phase 1 the DB is in the backward-compatible state:** both the old 4-col PK
(arbiter for old code) and the new 5-col unique index (arbiter for new code) are
valid. Either worker version can serve writes.

**Verify the indexes are VALID** (a CONCURRENTLY build that failed leaves an INVALID
index; Phase 2 would then fail):
```bash
npx tsx scripts/pg.ts "SELECT c.relname, i.indisvalid, i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('cells_pkey5','cell_validators_pkey5','file_section_progress_pkey5')"
```
All three must show `indisvalid = t`. If any is `f`, drop it
(`DROP INDEX CONCURRENTLY <name>`) and re-run that Phase-1 statement.

## Phase 2 — deploy the lane-aware workers
Deploy `main` (sync-worker + auth-worker). New code upserts via
`ON CONFLICT(…, target_lang)` and now finds its `*_pkey5` arbiter. Wait for the old
version to fully drain.

## Phase 3 — contract (promote 5-col to PK)
Only after Phase 2 is confirmed live. Reuses the pre-built indexes (no rebuild):
```bash
npx tsx scripts/pg.ts db/postgres/rollout/aqu538-99-contract.sql
```

## Phase 4 — verify
```bash
npx tsx scripts/pg.ts "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('cells'::regclass,'cell_validators'::regclass,'file_section_progress'::regclass) AND contype='p'"
```
Each PK definition must now list `target_lang`. Then run the repo guard locally:
`npx tsx scripts/check-schema-migrations.ts` (expects 48/48).

---

## Rollback
- **Before Phase 3:** fully reversible. `DROP INDEX CONCURRENTLY cells_pkey5` (etc.);
  the added columns are harmless (all `''`) and may be left or dropped
  (`ALTER TABLE … DROP COLUMN target_lang`). Redeploy the old workers if needed.
- **After Phase 3:** the PK now includes `target_lang`. Safe to reverse **only if no
  project has added a second lane** (no row has `target_lang <> ''`). Check first:
  `SELECT count(*) FROM cells WHERE target_lang <> ''`. If zero, you can swap the PK
  back to 4 columns; if non-zero, real multi-lane data exists and reverting would
  lose the lane distinction — roll forward instead.

## Ordering invariant (the one thing not to get wrong)
A cell may hold two lanes (`''` + `es`) only once the old 4-col PK is gone. So **no
project may add a second target language until Phase 3 has completed on `main`.**
Since the new worker only writes a non-`''` lane when a PM explicitly adds a
language, and the whole Phase-0→3 sequence is one rollout, this is automatic — but
do not pause between deploy and contract with multi-lane enabled.
