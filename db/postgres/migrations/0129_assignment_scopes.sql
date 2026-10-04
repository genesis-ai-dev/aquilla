-- 0129_assignment_scopes.sql — AQU-1629.
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

CREATE TABLE IF NOT EXISTS assignment_scopes (
    assignment_id TEXT NOT NULL,
    file_id       TEXT NOT NULL,
    -- Canonical chapter prefix ("GEN 1") for a 'chapters' scope; '' = the
    -- whole file (a 'books' scope). '' rather than NULL so the PK can cover
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
       COALESCE(entry->>'chapter', '')
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
  -- 0129's backfill could not reach: the frozen snapshot. Intersected with live
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
                -- Chapter scope narrows by canonical_ref exactly as
                -- assignment.create does: "GEN 1" -> LIKE 'GEN 1:%', where the
                -- ':' is what stops "GEN 11:1" matching. A NULL ref (an
                -- unversified or media cell) matches no chapter, and every one
                -- of them is in a whole-file scope.
                AND (s.chapter = '' OR c.canonical_ref LIKE s.chapter || ':%')
   -- Each cell appears once. Two named chapters cannot both match one ref (the
   -- ':' anchor), and the PK makes a (file, chapter) pair unique — so the only
   -- way to double-count is a whole-file row sitting beside a chapter row for
   -- the same file. The whole-file row wins; the chapter rows it covers drop
   -- out. The write path never mixes the two, and this keeps the view right if
   -- anything ever does.
   WHERE s.chapter = '' OR NOT EXISTS (
     SELECT 1 FROM assignment_scopes w
      WHERE w.assignment_id = s.assignment_id AND w.file_id = s.file_id
        AND w.chapter = ''
   );
