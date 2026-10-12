-- Migration 0127 (AQU-1559): which of the upstream's files a source link follows.
--
-- Until this slice a link was all-or-nothing: `source_project_id` meant "mirror
-- every file this upstream has, including the ones it gains later". A team that
-- wanted one book's source out of a project holding a whole Bible got all 66 and
-- had to delete the rest by hand — and the link kept bringing new ones in.
--
-- NULL is the whole-project link and stays the default, so every existing row
-- keeps exactly today's behaviour with no backfill. A JSON array of UPSTREAM
-- file ids is a fixed-list link: the mirror sync (sync-worker
-- events/link-sync.ts) folds only those files, and files the upstream gains
-- later are not among them, so they do not arrive. Detach reads the same list
-- (auth-worker services/source-linking.ts) so it copies only what the link
-- actually followed.
--
-- TEXT holding JSON rather than JSONB, matching `files.meta` and the rest of
-- this column family (`source_link_mode`/`consumes`/`gate` are TEXT): every
-- reader parses it in JS and degrades to "whole project" on a malformed blob,
-- where a JSONB cast would throw mid-sync and fail the whole mirror batch over
-- one bad row (the AQU-1547 posture). Nothing filters or indexes on it in SQL —
-- it is read once per sync, by project id.
--
-- Upstream file ids, not the downstream's deterministic mirror ids: the
-- selection has to survive a rename (ids do, names do not) and has to be
-- answerable before any mirror row exists.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS source_link_file_ids TEXT;
