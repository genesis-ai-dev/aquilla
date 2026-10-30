-- Two-step transcription P0 (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §1).
--
-- What ASR heard for a clip, kept apart from its transcript. The transcript
-- (timings_json, and cells.transcription for a source segment) is overwritten
-- by every correction, so until now the machine's output was gone after the
-- first human edit — and with it the "heard X, a person settled on Y" pairs the
-- cleanup step learns from.
--
-- asr_text / asr_model are written only by an attach that carries `asr` (the
-- transcription path). A correction never sends it and the projection keeps the
-- stored value, so the pair survives. asr_text is the text BEFORE learned
-- corrections are applied: the pair must show the real ASR error.
--
-- transcript_ai is the provenance of an AI cleanup ({ model, at, changes }, as
-- JSON text) while the transcript is still the AI's. Any later attach that
-- carries new timings without it (a human correction, a fresh ASR run) clears
-- it, as does a source-editor commit of the transcription.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS asr_text TEXT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS asr_model TEXT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS transcript_ai TEXT;
