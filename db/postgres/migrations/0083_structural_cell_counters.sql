-- AQU-1083: do chapter headings and section titles count as translatable content?
--
-- Structural cells (cells.type IN ('heading','paratext') — book titles, chapter
-- markers, section heads) are counted as one unit of progress each today, so a
-- book whose every verse is translated and validated still reads below 100%.
-- Randall Tan (ETEN) on the 2026-08-18 Projects Sync: tracking "incorrectly
-- counts chapter headings and subtitles rather than actual translated content".
--
-- Whether they count is a team policy, so it becomes a setting. The counters
-- here are the mechanism, and they are deliberately POLICY-BLIND: every counter
-- records its structural subset alongside the existing total, and a reader that
-- excludes computes total − structural. That is what lets the setting be
-- toggled without reprojecting a single cell — an acceptance criterion — and it
-- keeps every existing column meaning exactly what it means today.
--
-- The degradation direction is safe by construction: these default to 0, and
-- subtracting 0 is today's behaviour. A file that has not been backfilled reads
-- as it always did. It can under-report progress, which is the complaint being
-- fixed, but it can never over-report it or invent completion.
--
-- NOT applied automatically to live Neon branches: the backfill is one
-- aggregate pass over `cells` per file, and a migration file runs as a single
-- transaction. Apply by hand, in a window, BEFORE deploying anything that reads
-- these columns (neon:status is a deploy precondition and will fail until then):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0083_structural_cell_counters.sql

BEGIN;

-- Per-file rollups, read by the org portfolio and the file list.
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS structural_cell_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS structural_filled_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS structural_approved_count INTEGER NOT NULL DEFAULT 0,
  -- ai_drafted rides along because the dashboard divides it by the same total.
  -- Shrink the denominator without shrinking this and a scripture project whose
  -- headings were machine-drafted reads over 100% AI-drafted.
  ADD COLUMN IF NOT EXISTS structural_ai_drafted_count INTEGER NOT NULL DEFAULT 0;

-- Per-file and per-section progress, read by the editor and the drill-downs.
-- The histogram mirrors validator_histogram's encoding exactly (keys are exact
-- endorsement counts capped at 15) so a reader can subtract it bucket-wise.
ALTER TABLE file_section_progress
  ADD COLUMN IF NOT EXISTS structural_count               INTEGER NOT NULL DEFAULT 0 CHECK (structural_count >= 0),
  ADD COLUMN IF NOT EXISTS structural_filled_count        INTEGER NOT NULL DEFAULT 0 CHECK (structural_filled_count >= 0),
  ADD COLUMN IF NOT EXISTS structural_validator_histogram JSONB   NOT NULL DEFAULT '{}'::jsonb;

-- The effective policy has to be resolvable in SQL by the org dashboard, which
-- fans out over every project and must never parse the multi-MB settings blob
-- inline (the 15s timeout in getOrgPortfolio). Same STORED generated-column
-- treatment migration 0063 gave validationCount and targetLanes.
--
-- NULL means "unset": absent on the project falls through to the org, absent on
-- both means headings COUNT, which is today's behaviour.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS count_structural TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'countStructuralCells') STORED;

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS count_structural TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'countStructuralCells') STORED;

-- Backfill. Structural membership is a property of the SOURCE row, but
-- filled/approved count TARGET rows whose own type is null, so both aggregates
-- resolve the type through the paired source row via idx_cells_pair_lookup.
--
-- The guard clause at the end makes a re-run a cheap no-op, per the convention
-- that every migration in this tree is idempotent.
WITH structural AS (
  SELECT s.project_id,
         s.file_id,
         COUNT(DISTINCT s.cell_id)::integer AS cell_count,
         COUNT(*) FILTER (
           WHERE t.cell_id IS NOT NULL AND TRIM(t.value) <> ''
         )::integer AS filled_count,
         COUNT(*) FILTER (
           WHERE t.cell_id IS NOT NULL AND t.validated = 1
         )::integer AS approved_count,
         COUNT(*) FILTER (
           WHERE t.cell_id IS NOT NULL AND t.ai_drafted = 1
         )::integer AS ai_drafted_count
    FROM cells s
    LEFT JOIN cells t
      ON t.project_id = s.project_id
     AND t.file_id    = s.file_id
     AND t.cell_id    = s.cell_id
     AND t.side       = 'target'
   WHERE s.side = 'source'
     AND s.type IN ('heading', 'paratext')
   GROUP BY s.project_id, s.file_id
)
UPDATE files f
   SET structural_cell_count       = structural.cell_count,
       structural_filled_count     = structural.filled_count,
       structural_approved_count   = structural.approved_count,
       structural_ai_drafted_count = structural.ai_drafted_count
  FROM structural
 WHERE structural.project_id = f.project_id
   AND structural.file_id    = f.id
   AND (f.structural_cell_count       IS DISTINCT FROM structural.cell_count
     OR f.structural_filled_count     IS DISTINCT FROM structural.filled_count
     OR f.structural_approved_count   IS DISTINCT FROM structural.approved_count
     OR f.structural_ai_drafted_count IS DISTINCT FROM structural.ai_drafted_count);

-- file_section_progress is per target lane, so the structural aggregates are
-- computed per lane too. `scope='file'` rows key on section_key = '' and
-- target_lang = ''; section rows key on the canonical chapter prefix, the same
-- SPLIT_PART expression sectionKeyExpr uses in progress-projection.ts.
WITH paired AS (
  SELECT p.project_id,
         p.file_id,
         p.scope,
         p.section_key,
         p.target_lang,
         CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
         LEAST(COALESCE(t.endorsement_count, 0), 15) AS bucket
    FROM file_section_progress p
    JOIN cells s
      ON s.project_id = p.project_id
     AND s.file_id    = p.file_id
     AND s.side       = 'source'
     AND s.type IN ('heading', 'paratext')
     AND (
       p.scope = 'file'
       OR BTRIM(SPLIT_PART(COALESCE(s.canonical_ref, ''), ':', 1)) = p.section_key
     )
    LEFT JOIN cells t
      ON t.project_id  = s.project_id
     AND t.file_id     = s.file_id
     AND t.cell_id     = s.cell_id
     AND t.side        = 'target'
     AND t.target_lang = p.target_lang
), totals AS (
  SELECT project_id, file_id, scope, section_key, target_lang,
         COUNT(*)::integer AS total,
         COALESCE(SUM(filled), 0)::integer AS filled
    FROM paired
   GROUP BY project_id, file_id, scope, section_key, target_lang
), histograms AS (
  SELECT project_id, file_id, scope, section_key, target_lang,
         jsonb_object_agg(bucket::text, n) AS histogram
    FROM (
      SELECT project_id, file_id, scope, section_key, target_lang,
             bucket, COUNT(*)::integer AS n
        FROM paired
       GROUP BY project_id, file_id, scope, section_key, target_lang, bucket
    ) b
   GROUP BY project_id, file_id, scope, section_key, target_lang
)
UPDATE file_section_progress p
   SET structural_count               = totals.total,
       structural_filled_count        = totals.filled,
       structural_validator_histogram = COALESCE(histograms.histogram, '{}'::jsonb)
  FROM totals
  LEFT JOIN histograms
    ON histograms.project_id  = totals.project_id
   AND histograms.file_id     = totals.file_id
   AND histograms.scope       = totals.scope
   AND histograms.section_key = totals.section_key
   AND histograms.target_lang = totals.target_lang
 WHERE totals.project_id  = p.project_id
   AND totals.file_id     = p.file_id
   AND totals.scope       = p.scope
   AND totals.section_key = p.section_key
   AND totals.target_lang = p.target_lang
   AND (p.structural_count               IS DISTINCT FROM totals.total
     OR p.structural_filled_count        IS DISTINCT FROM totals.filled
     OR p.structural_validator_histogram IS DISTINCT FROM COALESCE(histograms.histogram, '{}'::jsonb));

COMMIT;
