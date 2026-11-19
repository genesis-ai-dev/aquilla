-- 0206_cell_audio_name_lookups.sql — AQU-2682: audio storage asks, before it
-- writes or removes a stored recording, whether any take in the file has ever
-- named it (by its id or by the url it plays), live or removed. These two
-- indexes make that a direct lookup. Unlike the existing partial indexes they
-- cover removed rows too, because a removed take still owns its recording.

CREATE INDEX IF NOT EXISTS idx_cell_audio_name ON cell_audio(project_id, file_id, audio_id);
CREATE INDEX IF NOT EXISTS idx_cell_audio_url ON cell_audio(project_id, file_id, url);
