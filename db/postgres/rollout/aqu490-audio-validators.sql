-- AQU-490 rollout: recover `role` and `created_by` for takes that predate 0096.
--
-- Deliberately NOT in the migration. Both statements read the event log, which
-- has no index on `kind` and stores its payload as TEXT, so recovering the
-- earliest attach per take is a scan of one project's whole history with a
-- per-row TEXT→jsonb cast. Run it project by project, largest last, and look
-- at the row counts first:
--
--   SELECT project_id, COUNT(*) FROM cell_audio GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
--
-- Every statement below is scoped by :project_id on purpose. Unscoped, the
-- second one scans the event log of every project at once.
--
-- Safe to re-run: both are guarded so an already-corrected row is left alone.
--
-- PRE-FLIGHT. Statement 1 is a string heuristic, so corroborate it against an
-- independent signal before trusting it on a project: an imported clip is
-- SHARED across many cells, a recording belongs to exactly one. The two should
-- name the same set.
--
--   WITH spread AS (
--     SELECT audio_id,
--            COUNT(DISTINCT cell_id) AS cells,
--            BOOL_OR(POSITION('-' || file_id || '-' IN audio_id) > 0) AS file_seeded
--       FROM cell_audio WHERE project_id = :'project_id' GROUP BY 1)
--   SELECT COUNT(*) FILTER (WHERE cells > 1 AND file_seeded)     AS agree_source,
--          COUNT(*) FILTER (WHERE cells > 1 AND NOT file_seeded) AS missed_by_heuristic,
--          COUNT(*) FILTER (WHERE cells = 1 AND file_seeded)     AS suspect_single
--     FROM spread;
--
-- `missed_by_heuristic` must be 0. `suspect_single` is not automatically wrong
-- — a one-cell file's clip is legitimately both — but inspect it by hand. Run
-- across this machine's whole dev database (11,604 takes over 8 projects,
-- 2026-09-20) both columns were 0 and the sets matched exactly: 4 source clips
-- in audio-first-test covering 508 rows, 1 in The Chosen — Armenian covering
-- 189.

\set ON_ERROR_STOP on

BEGIN;

-- 1. role.
--
-- The shared programme audio an import attaches is seeded with the FILE id;
-- a take somebody recorded is seeded with the CELL id. That convention is
-- `audioIdSeededWith` in src/lib/audio/upload.ts, and it is the only per-row
-- signal that exists for historical rows. It is a string heuristic, which is
-- why it runs ONCE here and is recorded as a column, rather than being
-- re-evaluated inside the projection on every recompute.
--
-- Anything in the generatedVoice slot is a dub (a TTS translation), and
-- anything carrying a voice_id likewise — only the imported clip is 'source'.
--
-- The TypeScript twin (`audioIdSeededWith`) normalises its needle first —
-- non-[A-Za-z0-9._-] to '_', truncated to 64 chars — and this does not. Checked
-- rather than assumed: every file_id in cell_audio is a 36-character uuidv7, so
-- both transformations are no-ops and the two agree. Re-check if file ids ever
-- stop being uuids.
UPDATE cell_audio ca
   SET role = 'source'
 WHERE ca.project_id = :'project_id'
   AND ca.role = 'dub'
   AND ca.slot = 'recording'
   AND ca.voice_id IS NULL
   AND POSITION('-' || ca.file_id || '-' IN ca.audio_id) > 0;

-- 2. created_by — the EARLIEST attach, not the latest.
--
-- cell_audio.event_id is overwritten by every partial re-attach: the
-- transcription that lands ~800ms after a recording, a timings refresh, a
-- trim persist. Joining on it would name whoever last touched the take, so a
-- reviewer who trimmed somebody else's recording would become its "recorder"
-- — and would then be refused permission to validate it on a project with
-- self-validation off. DISTINCT ON … ORDER BY server_seq ASC takes the attach
-- that created it.
UPDATE cell_audio ca
   SET created_by = src.author
  FROM (
    SELECT DISTINCT ON (e.file_id, e.cell_id, e.payload::jsonb->>'audioId')
           e.file_id,
           e.cell_id,
           e.payload::jsonb->>'audioId' AS audio_id,
           e.author
      FROM events e
     WHERE e.project_id = :'project_id'
       AND e.kind = 'cell.audio.attach'
     ORDER BY e.file_id, e.cell_id, e.payload::jsonb->>'audioId', e.server_seq ASC
  ) src
 WHERE ca.project_id = :'project_id'
   AND ca.created_by IS NULL
   AND src.file_id  = ca.file_id
   AND src.cell_id  = ca.cell_id
   AND src.audio_id = ca.audio_id;

COMMIT;

-- created_by stays NULL for any take whose attach event is not in the log.
-- That is not a failure of this script and not a state to design around: the
-- projection is the only writer of cell_audio in production, so the event is
-- normally there. It does happen on bulk-seeded fixtures (bible-audio-test on
-- this machine has 9,578 takes and 10 attach events), and it will happen to
-- anything whose history is ever pruned. Readers must treat a NULL recorder as
-- "unknown", never as a match — a self-validation check that compares NULL to
-- the caller must not silently pass. The next re-attach fills it in, since
-- created_by is COALESCEd rather than assigned.
--
-- Afterwards, reproject the project so the histograms stop reading '{}':
--   pnpm neon:backfill:progress:prod --project <id>
