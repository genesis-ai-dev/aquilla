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
-- ORDER OF OPERATIONS — CODE FIRST, THEN THIS FILE
--
-- Deploy the sync-worker change BEFORE applying this migration. New code is
-- safe against the old schema in both directions: `ON CONFLICT (project_id,
-- comment_id)` needs a unique index on those columns, which step 1 below
-- creates without touching the old PK, and the extra `AND project_id = ?`
-- predicates are correct under either key. Applying the contract step against
-- OLD code would be the unsafe order — its `ON CONFLICT(comment_id)` names a
-- constraint that no longer exists and every comment.create would error.
--
-- EXPAND → VERIFY → CONTRACT. The table takes live traffic, so the new unique
-- index is built CONCURRENTLY (no write lock) and only swapped in once it is
-- proven valid. Run the three steps as three separate invocations, checking the
-- verification between them — CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, so this file is applied statement by statement:
--
--   set -a; . ./.env; set +a
--   # ── 1. EXPAND ─────────────────────────────────────────────────────────
--   npx tsx scripts/pg.ts "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS \
--     comments_project_comment_pk ON comments (project_id, comment_id)"
--
--   # ── 2. VERIFY — must print indisvalid=t and zero duplicate groups ─────
--   npx tsx scripts/pg.ts "SELECT indisvalid FROM pg_index \
--     WHERE indexrelid = 'comments_project_comment_pk'::regclass"
--   npx tsx scripts/pg.ts "SELECT project_id, comment_id, count(*) FROM comments \
--     GROUP BY 1,2 HAVING count(*) > 1"
--
--   # ── 3. CONTRACT — swap the key over (brief ACCESS EXCLUSIVE lock) ─────
--   npx tsx scripts/pg.ts db/postgres/migrations/0093_comments_project_scoped_pk.sql
--
-- If step 2 shows indisvalid=f the concurrent build failed midway: DROP INDEX
-- CONCURRENTLY comments_project_comment_pk and re-run step 1. Do not proceed to
-- step 3 with an invalid index — USING INDEX would reject it and the table
-- would be left keyless.
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

ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_pkey;

ALTER TABLE comments
  ADD CONSTRAINT comments_pkey PRIMARY KEY USING INDEX comments_project_comment_pk;

COMMIT;
