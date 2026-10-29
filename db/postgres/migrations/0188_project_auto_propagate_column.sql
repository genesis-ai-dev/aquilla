-- 0188_project_auto_propagate_column.sql — AQU-2263
--
-- Whether a project sets its own "Auto-propagate repetitions" answer (AQU-1391),
-- so the org's Project defaults page can say "N projects set their own" under
-- that default and the "reset project overrides" endpoint can clear them,
-- without parsing every multi-MB settings blob. The same pattern as
-- count_structural (0092) and the media columns (0176). NULL = the project
-- follows its organization. Nothing reads it for a decision.
--
-- Idempotent; a database loaded from schema.sql already has it.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS auto_propagate_repetitions TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'autoPropagateRepetitions') STORED;
