-- 0194: files with a film linked go back to the film default, Follows source
-- (AQU-2227). One-time data fix.
--
-- Until this release, linking a film LOCKED a file to Follows source: the
-- timing resolver returned "dubbing" for any file with `coreMediaUrl` set,
-- before it read the file's own choice (AQU-2204; subtitle imports with their
-- film since AQU-646/AQU-1704). AQU-2227 makes the film a DEFAULT instead: the
-- file's own stored choice now wins. A file whose own choice says Follows
-- recordings would therefore switch the moment this release deploys, and hide
-- its film, although its users have only ever seen it follow the source.
--
-- So: on every file with a film linked whose own stored choice is Follows
-- recordings, clear that choice. With no choice of its own, a file with a film
-- resolves to Follows source, as it showed before. A project lead can still
-- switch it to Follows recordings afterwards.
--
-- Where the choice lives: `files.meta` JSON, key `timingMode` (written by
-- `file.timing.set`, see buildFileTimingSetStmt). Follows recordings is stored
-- as 'audioFirst'; "Free timing" was its earlier display name, and the stored
-- value has always been 'audioFirst' (the handler accepts only 'dubbing',
-- 'audioFirst' or null). The film is `files.meta.coreMediaUrl`, a non-empty
-- string when linked (the client treats it by truthiness; an unlink removes
-- the key). Removing the key is exactly what `file.timing.set` with null does.
--
-- Left alone: a stored 'dubbing'; files with no film, whatever they stored
-- (including a file whose only link to a film is an audio cue file); the
-- project-level `audioTimingMode`; every other meta key; `event_id` and
-- `updated_at`, since this corrects a value and is nobody's edit. Soft-deleted
-- files are included, so restoring one later does not switch it either.
--
-- The event log is not rewritten. A projection rebuild that replays a file's
-- old `file.timing.set` event (a full replay, `?fullReplay=1`) would put that
-- choice back on the file.
--
-- Dry run (read-only) — the files this will change:
--   SELECT project_id, id, name
--     FROM files
--    WHERE COALESCE(NULLIF(meta, ''), '{}')::jsonb ->> 'timingMode' = 'audioFirst'
--      AND NULLIF(COALESCE(NULLIF(meta, ''), '{}')::jsonb ->> 'coreMediaUrl', '') IS NOT NULL;
--
-- Idempotent: a second run finds no file left with the choice to clear.

UPDATE files
   SET meta = (COALESCE(NULLIF(meta, ''), '{}')::jsonb - 'timingMode')::text
 WHERE COALESCE(NULLIF(meta, ''), '{}')::jsonb ->> 'timingMode' = 'audioFirst'
   AND NULLIF(COALESCE(NULLIF(meta, ''), '{}')::jsonb ->> 'coreMediaUrl', '') IS NOT NULL;
