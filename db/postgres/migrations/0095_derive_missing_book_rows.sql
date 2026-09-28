-- AQU-1278: give every Scripture file its BOOK rows, derived from the chapter
-- rows it already has.
--
-- The plan board plans a Scripture file one row per book, and it decides
-- which files are Scripture by looking for rows at scope = 'book' in this
-- table. Files projected before AQU-1093 wrote book rows have none, so on the
-- board a whole Bible collapses into a single row named after the file, and
-- every per-book target date, shortfall and link is inert for it.
--
-- WHY A DERIVATION AND NOT A REPROJECTION. Those files DO have their
-- 'section' rows — one per chapter — and a book row is nothing but the sum of
-- its chapters: every counter adds, the two histograms merge bucket by
-- bucket, the newest edit is the newest of them, and the revision watermark
-- is shared. Checked on a database that has both: all 432 book rows equal the
-- merge of their chapter rows on every column. So this is an aggregate over a
-- small, indexed table rather than a rescan of every cell in production, and
-- it needs no ops flag and no separate backfill run — it rides `neon:apply`,
-- which every deploy is gated on.
--
-- THE SAME GATE THE PROJECTION USES. The projection writes book rows only for
-- a file where some source cell carries a VERSE-shaped reference ("GEN 1:1")
-- — see HAS_BOOKS_CTE_SQL: chapter- or code-only labels ("GEN 1", "GEN") are
-- deliberately not enough, so a document that happens to use two-token
-- headings never sprouts book rows. This derivation asks the identical
-- question of the identical table, and only for the files it is about to
-- touch, so it cannot create a book row the projection would refuse — and
-- the next recompute (which deletes and rewrites section and book rows
-- together) would never delete something this wrote and put nothing back.
--
-- Idempotent: only files with no book rows are considered, and the insert
-- ignores a conflicting key. Safe to re-run. The projection overwrites these
-- rows on the file's next recompute, exactly as it overwrites its own.
--
-- Not applied automatically to live Neon branches; `neon:apply` runs it.

BEGIN;

WITH candidate AS (
  -- Files with chapter rows and no book rows, that the projection agrees are
  -- Scripture. `sc` is the chapter rows themselves; the EXISTS on cells stops
  -- at the first verse-shaped reference it finds.
  SELECT DISTINCT sc.project_id, sc.file_id
    FROM file_section_progress sc
    JOIN files f
      ON f.project_id = sc.project_id AND f.id = sc.file_id AND f.deleted_at IS NULL
   WHERE sc.scope = 'section'
     AND sc.section_key NOT LIKE 't:%'
     AND NOT EXISTS (
       SELECT 1 FROM file_section_progress b
        WHERE b.project_id = sc.project_id AND b.file_id = sc.file_id AND b.scope = 'book')
     AND EXISTS (
       SELECT 1 FROM cells c
        WHERE c.project_id = sc.project_id AND c.file_id = sc.file_id AND c.side = 'source'
          AND COALESCE(c.canonical_ref, '') ~ '^\S+ \d+:\d+')
), chapter AS (
  -- Every chapter row of a candidate, tagged with the book it belongs to:
  -- the first token of its key, which is exactly the projection's bookKeyExpr.
  SELECT s.*, SPLIT_PART(s.section_key, ' ', 1) AS book_key
    FROM file_section_progress s
    JOIN candidate k ON k.project_id = s.project_id AND k.file_id = s.file_id
   WHERE s.scope = 'section'
     AND s.section_key NOT LIKE 't:%'
), hist AS (
  -- The validator histogram merges bucket by bucket across the chapters.
  SELECT project_id, file_id, target_lang, book_key,
         jsonb_object_agg(bucket, n) AS validator_histogram
    FROM (
      SELECT ch.project_id, ch.file_id, ch.target_lang, ch.book_key,
             kv.key AS bucket, SUM(kv.value::integer) AS n
        FROM chapter ch, LATERAL jsonb_each_text(ch.validator_histogram) kv
       GROUP BY ch.project_id, ch.file_id, ch.target_lang, ch.book_key, kv.key
    ) per_bucket
   GROUP BY project_id, file_id, target_lang, book_key
), structural_hist AS (
  -- Same merge for the structural histogram. Zero buckets never appear in a
  -- chapter's map (the projection FILTERs them out), so none appear here.
  SELECT project_id, file_id, target_lang, book_key,
         jsonb_object_agg(bucket, n) AS structural_validator_histogram
    FROM (
      SELECT ch.project_id, ch.file_id, ch.target_lang, ch.book_key,
             kv.key AS bucket, SUM(kv.value::integer) AS n
        FROM chapter ch, LATERAL jsonb_each_text(ch.structural_validator_histogram) kv
       GROUP BY ch.project_id, ch.file_id, ch.target_lang, ch.book_key, kv.key
    ) per_bucket
   GROUP BY project_id, file_id, target_lang, book_key
), book AS (
  SELECT ch.project_id, ch.file_id, ch.target_lang, ch.book_key,
         SUM(ch.total_count)::integer                       AS total_count,
         SUM(ch.filled_count)::integer                      AS filled_count,
         SUM(ch.structural_count)::integer                  AS structural_count,
         SUM(ch.structural_filled_count)::integer           AS structural_filled_count,
         SUM(ch.audio_count)::integer                       AS audio_count,
         SUM(ch.audio_validated_count)::integer             AS audio_validated_count,
         SUM(ch.structural_audio_count)::integer            AS structural_audio_count,
         SUM(ch.structural_audio_validated_count)::integer  AS structural_audio_validated_count,
         MAX(ch.last_edit_at)                               AS last_edit_at,
         MAX(ch.revision)                                   AS revision,
         MAX(ch.updated_at)                                 AS updated_at
    FROM chapter ch
   GROUP BY ch.project_id, ch.file_id, ch.target_lang, ch.book_key
)
INSERT INTO file_section_progress (
  project_id, file_id, scope, section_key, target_lang,
  total_count, filled_count, validator_histogram,
  structural_count, structural_filled_count, structural_validator_histogram,
  audio_count, audio_validated_count, last_edit_at,
  structural_audio_count, structural_audio_validated_count,
  revision, updated_at
)
SELECT b.project_id, b.file_id, 'book', b.book_key, b.target_lang,
       b.total_count, b.filled_count, COALESCE(h.validator_histogram, '{}'::jsonb),
       b.structural_count, b.structural_filled_count, COALESCE(sh.structural_validator_histogram, '{}'::jsonb),
       b.audio_count, b.audio_validated_count, b.last_edit_at,
       b.structural_audio_count, b.structural_audio_validated_count,
       b.revision, b.updated_at
  FROM book b
  LEFT JOIN hist h
    ON h.project_id = b.project_id AND h.file_id = b.file_id
   AND h.target_lang = b.target_lang AND h.book_key = b.book_key
  LEFT JOIN structural_hist sh
    ON sh.project_id = b.project_id AND sh.file_id = b.file_id
   AND sh.target_lang = b.target_lang AND sh.book_key = b.book_key
ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO NOTHING;

COMMIT;
