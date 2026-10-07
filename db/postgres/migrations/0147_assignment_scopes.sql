-- 0147_assignment_scopes.sql — AQU-1629.
--
-- An assignment's lines were fixed at creation. `assignment.create` resolved
-- its book/chapter scope into `assignment_cells` once and nothing ever
-- re-resolved it, so a line added to an assigned chapter or file never joined
-- the assignment: the assignee's progress could read 100% while the chapter
-- still had open work, and the manager views counted a denominator that no
-- longer described the unit.
--
-- AQU-1068 already made the DENOMINATOR live for the opposite case — a cell
-- REMOVED from a file drops out, because both halves of progress are derived
-- on read by joining `assignment_cells` to the live `cells` projection. That
-- join can only ever shrink the snapshot, never grow it, so additions stayed
-- invisible. This migration makes the membership itself derived for the scopes
-- that are ranges, which is the other half of the same fix.
--
--   * `assignment_scopes` records the RANGE an assignment was given — one row
--     per (assignment, file, chapter), `chapter = ''` meaning the whole file.
--     Written by assignment.create for 'books' and 'chapters' scopes.
--   * `assignment_member_cells` is what every reader joins instead of
--     `assignment_cells`: a range-scoped assignment resolves its scope against
--     live `cells` on every read; an explicit line selection ('cells' scope,
--     AQU-1628) keeps its frozen list, because a selection is exactly the lines
--     the manager picked and must not silently acquire new ones.
--
-- `assignment_cells` is unchanged and still written for every scope — it stays
-- the audit record of what the scope resolved to at creation.
--
-- A chapter scope resolves by the plan board's own chapter key (AQU-1493,
-- `unitSectionKeyExpr` in db/shared/plan-keys.ts, stored placements in
-- `cell_plan_keys` from 0145), the same rule `assignment.create` has used for
-- the snapshot since AQU-1493 — so a heading, or a line added with no
-- reference, is in the chapter the board counts it in, live.

CREATE TABLE IF NOT EXISTS assignment_scopes (
    assignment_id TEXT NOT NULL,
    file_id       TEXT NOT NULL,
    -- The chapter key ("GEN 1") for a 'chapters' scope, as the plan board keys
    -- a chapter and as assignment.create matches one; '' = the whole file (a
    -- 'books' scope). '' rather than NULL so the PK can cover
    -- it — the same sentinel convention the lane columns use.
    chapter       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (assignment_id, file_id, chapter)
);

-- The reverse lookup "which assignments cover this file?", the scope-side twin
-- of assignment_cells_by_file (0093).
CREATE INDEX IF NOT EXISTS idx_assignment_scopes_file ON assignment_scopes(file_id);

-- Backfill from the immutable event log, so assignments created before this
-- migration grow too — the reported bug is older behaviour, and the scope is
-- still right there in the `assignment.create` payload.
--
-- `NOT (entry ? 'cellIds')` rather than a scopeKind test, because that is the
-- branch the handler itself takes per entry (an entry carrying cellIds is an
-- explicit selection, even an empty one).
INSERT INTO assignment_scopes (assignment_id, file_id, chapter)
SELECT DISTINCT
       (e.payload::jsonb)->>'assignmentId',
       entry->>'fileId',
       -- Trimmed like the key the view compares it with: the resolver trims
       -- a chapter before matching it, and the picker's raw text can carry
       -- whitespace.
       TRIM(COALESCE(entry->>'chapter', ''))
  FROM events e
  CROSS JOIN LATERAL jsonb_array_elements((e.payload::jsonb)->'scope') AS entry
 WHERE e.kind = 'assignment.create'
   AND jsonb_typeof((e.payload::jsonb)->'scope') = 'array'
   AND NOT (entry ? 'cellIds')
   AND entry->>'fileId' IS NOT NULL
   AND (e.payload::jsonb)->>'assignmentId' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM assignments a
      WHERE a.assignment_id = (e.payload::jsonb)->>'assignmentId'
   )
ON CONFLICT DO NOTHING;

-- Live membership — what every assignment reader joins instead of
-- `assignment_cells`. It carries the source cell's own grouping columns so a
-- reader that needs them joins `cells` once, through the view, rather than
-- twice: measured against the committed queries, that is what keeps the
-- denominator at parity and holds the plan inspector's two reads to ~2x with
-- no sequential scan, where an id-only view cost 5x and one.
--
-- security_invoker so the RLS backstop on the underlying tables still applies
-- to the caller, exactly as in 0121.
CREATE OR REPLACE VIEW assignment_member_cells WITH (security_invoker = true) AS
  -- An explicit line selection ('cells' scope, AQU-1628), and any assignment
  -- 0147's backfill could not reach: the frozen snapshot. Intersected with live
  -- source cells HERE rather than in each reader, which is where AQU-1068 put
  -- it — so a cell removed from the file still drops out, and no reader has to
  -- remember to do it.
  SELECT a.project_id, ac.assignment_id, c.file_id, c.cell_id,
         c.canonical_ref, c.start_ms, c.type
    FROM assignment_cells ac
    JOIN assignments a ON a.assignment_id = ac.assignment_id
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                AND c.cell_id = ac.cell_id AND c.side = 'source'
   WHERE NOT EXISTS (
     SELECT 1 FROM assignment_scopes s WHERE s.assignment_id = ac.assignment_id
   )
  UNION ALL
  -- A range scope ('books' / 'chapters'), resolved live on every read.
  SELECT a.project_id, s.assignment_id, c.file_id, c.cell_id,
         c.canonical_ref, c.start_ms, c.type
    FROM assignment_scopes s
    JOIN assignments a ON a.assignment_id = s.assignment_id
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = s.file_id
                AND c.side = 'source'
    -- AQU-1493: where a line with no reference is counted on the plan, as the
    -- full progress recompute last stored it (cell_plan_keys, 0145). No row
    -- for a referenced line, nor for an unreferenced one no recompute has
    -- placed yet.
    LEFT JOIN cell_plan_keys ik ON ik.project_id = c.project_id AND ik.file_id = c.file_id
                               AND ik.cell_id = c.cell_id
   WHERE (
     s.chapter = ''
     -- A chapter scope takes the cells the plan board counts in that chapter,
     -- by the board's own key — the same rule assignment.create resolves the
     -- snapshot with (AQU-1493), so a heading, or a line added with no
     -- reference, is in the chapter the board shows it in rather than left
     -- out. This is `unitSectionKeyExpr` from db/shared/plan-keys.ts written
     -- out, and it must stay identical to it: a cell's chapter from its own
     -- reference ("GEN 1" from "GEN 1:1"), else the stored placement, else
     -- the key sectionKeyExpr gives it (a media cell's time bucket, or '').
     -- Equality on the key keeps "GEN 1" out of "GEN 11" without a LIKE
     -- anchor, and a line with no reference and no placement ('') matches no
     -- chapter — it is still in a whole-file scope.
     OR COALESCE(
          NULLIF(TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1)), ''),
          ik.section_key,
          CASE
            WHEN TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1)) <> ''
              THEN TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1))
            WHEN c.start_ms IS NOT NULL
              THEN 't:' || LPAD(((c.start_ms / 300000) * 300000)::text, 12, '0')
            ELSE ''
          END
        ) = s.chapter
   )
   -- Each cell appears once. A cell has exactly one chapter key, so two named
   -- chapters cannot both match it, and the PK makes a (file, chapter) pair
   -- unique — so the only way to double-count is a whole-file row sitting
   -- beside a chapter row for the same file. The whole-file row wins; the
   -- chapter rows it covers drop out. The write path never mixes the two, and
   -- this keeps the view right if anything ever does.
   AND (s.chapter = '' OR NOT EXISTS (
     SELECT 1 FROM assignment_scopes w
      WHERE w.assignment_id = s.assignment_id AND w.file_id = s.file_id
        AND w.chapter = ''
   ));
