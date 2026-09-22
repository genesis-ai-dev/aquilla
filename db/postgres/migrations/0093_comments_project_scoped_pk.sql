-- Migration 0093: repoint the `comments` primary key from the global
-- `comment_id` to the project-scoped `(project_id, comment_id)` (AQU-1296).
--
-- THE BUG
--
-- `comments.comment_id` was declared a global PRIMARY KEY, but comment ids are
-- not globally unique. The Codex importer namespaces the event id
-- (`comment-create:${projectId}:${legacyId}`) and the file id
-- (`fileIdFor(projectKey, stem)`) per project, and leaves `payload.commentId`
-- as the raw legacy id. Two projects importing the same source repo — a fork, a
-- re-import, a migration rehearsal — therefore emit identical comment ids.
-- `comment.create` projected with `ON CONFLICT(comment_id) DO NOTHING`, so the
-- FIRST project to claim an id owned the only row that could ever exist for it
-- and every later project's insert was silently swallowed: the event landed in
-- the log, the row never appeared, and nothing was logged.
--
-- Observed in production on ~20 project pairs (Pattani Malay Bible: 701 of 1461
-- comment.create events invisible; Burmese Old Testament: 2647 of 4527). The
-- already-stranded rows are re-homed out of band from the event log, which is
-- the source of truth — this migration is the schema half of the fix so it
-- cannot recur.
--
-- The same missing scope made `comment.edit` / `comment.delete` /
-- `comment.resolve` and the `prefetchCommentAuthors` authorization lookup match
-- on `comment_id` alone, so an action in project A could read or write project
-- B's row. Those are fixed in the same commit (sync-worker/src/events/
-- event-projection.ts, sync-worker/src/events/route.ts).
--
-- ORDER: PREPARE INDEX → VERIFY → DEPLOY COMPATIBLE WORKER → APPLY.
--
-- 1. pnpm neon:prepare:comments:prod (or :dev) creates the unique index
--    CONCURRENTLY in its own query and verifies its columns and validity.
--    It preserves the old primary key, so the old worker remains compatible.
-- 2. Deploy a sync-worker using ON CONFLICT (project_id, comment_id).
--    Confirm all production traffic uses it before proceeding. The old
--    ON CONFLICT(comment_id) worker fails after the global key is removed.
-- 3. pnpm neon:apply:prod (or :dev) executes this transaction and records
--    completion in schema_migrations. Do not baseline to skip this migration.
--
-- CREATE INDEX CONCURRENTLY cannot run in the migration runner's multi-
-- statement transaction. Preparation is deliberately a separate command.
-- A database already migrated manually is recognized by its primary-key
-- columns, not the temporary index name: PostgreSQL renames the index when
-- attaching it to comments_pkey. Replaying this file preserves that key.
-- Missing/invalid preparation fails before the drop and rolls back the file.
-- See docs/runbooks/comments-primary-key-rollout.md for the deploy gate.
--
-- No foreign key references comments(comment_id) anywhere in the schema
-- (`parent_comment_id` is a plain TEXT column, not an FK), so nothing dangles
-- when the old constraint is dropped.
--
-- AFTER APPLYING, the reconciliation invariant must return zero rows — it is
-- what turns the next recurrence from silent into loud
-- (`npm run db:check:comments`, scripts/check-comment-projection.ts):
--
--   SELECT project_id, count(*) AS invisible
--     FROM events e
--    WHERE e.kind = 'comment.create'
--      AND NOT EXISTS (SELECT 1 FROM comments c
--                       WHERE c.comment_id = e.payload::json->>'commentId'
--                         AND c.project_id = e.project_id)
--    GROUP BY 1 HAVING count(*) > 0;

-- ── 3. CONTRACT ────────────────────────────────────────────────────────────
-- Drop the global key and promote the already-built project-scoped index in
-- one transaction, so there is no window in which the table has no primary key.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE comments IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  key_name text;
  key_columns text[];
BEGIN
  SELECT c.conname, ARRAY(
    SELECT a.attname::text
    FROM unnest(c.conkey) WITH ORDINALITY k(n, pos)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
    ORDER BY k.pos
  ) INTO key_name, key_columns
  FROM pg_constraint c
  WHERE c.conrelid = 'comments'::regclass AND c.contype = 'p';

  IF key_columns = ARRAY['project_id', 'comment_id'] THEN
    RETURN;
  END IF;
  IF key_columns IS DISTINCT FROM ARRAY['comment_id'] THEN
    RAISE EXCEPTION 'Unexpected comments primary key: %', key_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indexrelid = to_regclass('comments_project_comment_pk')
      AND i.indrelid = 'comments'::regclass
      AND i.indisvalid AND i.indisready AND i.indisunique
      AND NOT i.indisprimary AND am.amname = 'btree'
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND ARRAY(
        SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY k(n, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n
        ORDER BY k.pos
      ) = ARRAY['project_id', 'comment_id']
  ) THEN
    RAISE EXCEPTION
      'Missing or invalid index on (project_id, comment_id); run neon-target.ts <production|dev> prepare-comments-key, then verify worker compatibility before apply';
  END IF;

  EXECUTE format('ALTER TABLE comments DROP CONSTRAINT %I', key_name);
  ALTER TABLE comments ADD CONSTRAINT comments_pkey
    PRIMARY KEY USING INDEX comments_project_comment_pk;
END $$;

COMMIT;
