-- Migration 0022: per-cell subtitle timecodes
-- Adds numeric cue timing (milliseconds) to the cells projection so subtitle
-- character/VTT export survives reload + sync. Previously the cue timestamp
-- lived only as a transient display string in the client (`context`) and was
-- dropped by the server model. Additive + nullable → non-breaking; existing
-- rows get NULL (= no timecode). Applied to the shared aquilla-db D1.
ALTER TABLE cells ADD COLUMN start_ms INTEGER;
ALTER TABLE cells ADD COLUMN end_ms INTEGER;
