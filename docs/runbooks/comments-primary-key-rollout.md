# Comments primary-key rollout

AQU-1329 repairs the AQU-1296 migration runner path. The final primary key is
`(project_id, comment_id)`. Existing comments and their identifiers stay intact.

## Inspect before applying

Read the target database's `pg_constraint`, `pg_index`, and `schema_migrations`.
Check the primary-key **columns**, not just its name. PostgreSQL renames the
prepared index to `comments_pkey` when it becomes that named constraint.

An already-migrated database needs no index preparation. Running the corrected
migration with a missing ledger entry preserves the existing composite key and
lets the runner record it. Do not baseline the entire database to hide one row.

## Prepare, deploy, then apply

1. Run `pnpm neon:prepare:comments:prod` (or `:dev`). It creates the unique index
   concurrently, validates its shape and readiness, and preserves the global key.
   This operation is separate from transactional migration execution.
2. Prepare any other additive migrations required by the intended worker release.
   Execute their actual SQL files and record only successful migrations. Do not
   mark the comments migration applied while its primary key is still global.
3. Build and verify the intended worker release. Confirm it uses
   `ON CONFLICT (project_id, comment_id)` and scopes comment mutations and author
   lookups to the project. Deploy it and verify that **all traffic** uses it.
4. Run `pnpm neon:apply:prod` (or `:dev`). The comments migration validates the
   index again under a table lock, swaps the key transactionally, and records
   successful completion. Its lock wait is bounded at five seconds; contention
   fails safely and can be retried after investigating the blocker.
5. Run `pnpm neon:status:prod` (or `:dev`). Check the actual composite primary key
   as well: the general schema checker does not compare primary-key columns.
   Run `pnpm db:check:comments` with the intended target's credentials to detect
   historical projection gaps. Repairing those gaps is separate from this DDL.

The old worker uses `ON CONFLICT(comment_id)` and fails after the global key is
removed. Never apply the contract just to make the deploy schema gate green.
The normal deploy wrapper therefore cannot drive this rollout unchanged: its
`neon:status` gate sees the intentionally pending contract migration. After
explicitly verifying the expanded schema and passing the release tests, use the
existing verified worker deployment entry point for the intended environment,
then apply the contract. Do not remove the normal deploy gate or falsify the ledger.

If preparation finds an invalid or wrongly shaped index, it stops. Inspect why
before dropping or rebuilding anything; `IF NOT EXISTS` does not certify an index.
The migration rejects unexpected primary keys and preserves the existing key and
rows when preparation, lock acquisition, or the contract fails.

## Verification

- `pnpm exec vitest run scripts/comments-key-migration.test.ts scripts/neon-schema-contract.test.ts --maxWorkers=1`
- `pnpm test:neon:comments` against the local Docker PostgreSQL instance.
- `npm run build`
- Affected comment smoke journeys during implementation; full smoke before deployment.

The unit tests run the actual SQL through PostgreSQL (PGlite). The local integration
suite uses node-postgres and the same preparation/file-execution functions as the
CLI, including real concurrent index creation, a failed concurrent build, ledger
recording, manual migration reconciliation, and rollback with a dependent FK.
Tests use their own disposable schemas and never reset the local dev database.
