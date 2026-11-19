-- 0206_cell_audio_name_lookup.sql — AQU-2682: audio storage asks, before it
-- writes or removes a stored recording, whether any take in the file has ever
-- named it, live or removed. This index answers that by the take's id. Unlike
-- the existing partial indexes it covers removed rows too, because a removed
-- take still owns its recording.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- block, and it keeps writes to cell_audio flowing while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cell_audio_name ON cell_audio(project_id, file_id, audio_id);
