-- 0197: files timed to a film go back to the film default, Follows source
-- (AQU-2227). One-time data fix.
--
-- Until this release, a file TIMED TO A FILM was LOCKED to Follows source: the
-- timing resolver returned "dubbing" for it before it read the file's own
-- choice (AQU-2204, in every release tag from 2026.10.27.01; subtitle imports with their
-- film since AQU-646/AQU-1704). A file is timed to a film when it has footage
-- linked, or when an audio cue file is paired with it. AQU-2227 makes that a
-- DEFAULT instead: the file's own stored choice now wins. A file whose own
-- choice says Follows recordings would therefore switch the moment this
-- release deploys, although its users have only ever seen it follow the
-- source.
--
-- So: on every file timed to a film whose own stored choice is Follows
-- recordings, clear that choice. With no choice of its own, such a file
-- resolves to Follows source, as it showed before. A project lead can still
-- switch it to Follows recordings afterwards.
--
-- Where things live:
--   * The choice: `files.meta` JSON, key `timingMode` (written by
--     `file.timing.set`, see buildFileTimingSetStmt). Follows recordings is
--     stored as 'audioFirst'; "Free timing" was its earlier display name, and
--     the stored value has always been 'audioFirst'. Removing the key is
--     exactly what `file.timing.set` with null does.
--   * The film: `files.meta.coreMediaUrl`, read as linked when it is a string
--     with something other than whitespace in it (auth-worker's project load).
--   * The audio cue file: a live `files` row with role 'audio-cues' whose
--     `anchor_file_id` is this file (the app lists only live files, so a
--     deleted cue file does not count).
--
-- Left alone: a stored 'dubbing'; files not timed to a film, whatever they
-- stored; the project-level `audioTimingMode`; every other meta key;
-- `event_id` and `updated_at`, since this corrects a value and is nobody's
-- edit. Soft-deleted files are included, so restoring one later does not
-- switch it either.
--
-- Accepted gap: the event log is not rewritten. A full projection rebuild
-- (`rebuild-projection?fullReplay=1`) of an affected project replays the
-- file's old `file.timing.set` event and puts the choice back. Rebuilds are
-- rare, and that is accepted rather than writing events from a migration.
--
-- If the release on prod PREDATES the AQU-2204 lock (it does not contain
-- commit f33125d92), only subtitle imports with a film were locked there, and
-- this UPDATE must be replaced by the narrower one in the AQU-2227 PR's deploy
-- notes before it is applied.
--
-- Dry run (read-only): the same statement as a SELECT —
--   WITH parsed AS (SELECT id, COALESCE(NULLIF(meta, ''), '{}')::jsonb AS j FROM files)
--   SELECT files.project_id, files.id, files.name
--     FROM files JOIN parsed ON parsed.id = files.id
--    WHERE parsed.j ->> 'timingMode' = 'audioFirst'
--      AND ((jsonb_typeof(parsed.j -> 'coreMediaUrl') = 'string' AND parsed.j ->> 'coreMediaUrl' ~ '\S')
--           OR EXISTS (SELECT 1 FROM files AS cue
--                       WHERE cue.anchor_file_id = files.id AND cue.project_id = files.project_id
--                         AND cue.role = 'audio-cues' AND cue.deleted_at IS NULL));
--
-- Idempotent: a second run finds no file left with the choice to clear.

WITH parsed AS (
  SELECT id, COALESCE(NULLIF(meta, ''), '{}')::jsonb AS j
    FROM files
)
UPDATE files
   SET meta = (parsed.j - 'timingMode')::text
  FROM parsed
 WHERE parsed.id = files.id
   AND parsed.j ->> 'timingMode' = 'audioFirst'
   AND (
         -- a film linked
         (jsonb_typeof(parsed.j -> 'coreMediaUrl') = 'string' AND parsed.j ->> 'coreMediaUrl' ~ '\S')
         -- or an audio cue file paired with it
      OR EXISTS (
           SELECT 1
             FROM files AS cue
            WHERE cue.anchor_file_id = files.id
              AND cue.project_id = files.project_id
              AND cue.role = 'audio-cues'
              AND cue.deleted_at IS NULL
         )
       );
