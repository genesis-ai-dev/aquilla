-- Migration 0064: audio artifacts for the Agent API LinkMedia command
-- (Agent API v1.1 §3, W2-B).
--
-- Extends the artifacts table (0056) with a `kind` discriminator and an
-- `audio_id`:
--   * kind    — 'source' (verbatim import original, the existing behaviour) or
--               'audio' (an uploaded clip a LinkMedia changeset attaches to a
--               cell). Defaults to 'source' so existing rows + the source
--               upload path are unchanged.
--   * audio_id — for audio artifacts, the full R2 object name (`<id>.<ext>`)
--               the per-file audio layout used by audio.ts expects, and the
--               value stamped into the compiled cell.audio.attach payload. NULL
--               for source artifacts.
--
-- Audio bytes land in the EXISTING audio R2 layout
-- (`{prefix}projects/{projectId}/files/{artifactId}/audio/{audio_id}`); a
-- LinkMedia commit copies them under the target cell's file so the app's native
-- /audio playback route serves externally-uploaded audio with no special-casing.

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'source';
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS audio_id TEXT;
