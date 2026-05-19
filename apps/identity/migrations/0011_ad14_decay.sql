-- Migration: 0011_ad14_decay.sql
-- Description: AD-14 decay/health projection fields.
--   Adds cells.endorsement_count and migrates the project_settings JSON key
--   from legacy healthSettings to decaySettings when possible.

ALTER TABLE cells
  ADD COLUMN endorsement_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_cells_decay_drags
  ON cells(project_id, endorsement_count);

UPDATE project_settings
   SET settings = json_set(
     json_remove(settings, '$.healthSettings'),
     '$.decaySettings',
     json_extract(settings, '$.healthSettings')
   )
 WHERE json_type(settings, '$.healthSettings') IS NOT NULL
   AND json_type(settings, '$.decaySettings') IS NULL;
