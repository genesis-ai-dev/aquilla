-- 0209_cell_audio_stored_url_lookup.sql — AQU-2682: the same question by the
-- url a take plays. Only `frontier-audio://` urls name a stored recording, so
-- only those are indexed: an outside link (a signed media url can run to
-- several KB) is never in this index and can never exceed its row size, on
-- existing rows or new ones.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block, and it keeps writes to cell_audio flowing while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cell_audio_stored_url ON cell_audio(project_id, file_id, url) WHERE url LIKE 'frontier-audio://%';
