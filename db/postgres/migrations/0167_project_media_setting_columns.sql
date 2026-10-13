-- 0167_project_media_setting_columns.sql — AQU-1768
--
-- Org-level defaults for the media settings (timing lock, track editing, who
-- may add or remove lines, audio self-validation, the audio validation role
-- floor). A project may still set its own; absent on the project falls
-- through to the org's, then to each reader's built-in default.
--
-- These STORED generated columns say whether a project has its own value, so
-- the org settings page can count overrides and the "reset project overrides"
-- endpoint can clear them without parsing every multi-MB settings blob (the
-- same reason as validation_count / count_structural). The enforcement paths
-- read the blob they already load; nothing reads these for a decision.
--
-- One ALTER so the table is rewritten once. Idempotent; a database loaded from
-- schema.sql already has all five.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS timing_locked TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'timingLocked') STORED,
  ADD COLUMN IF NOT EXISTS allow_track_editing TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'allowTrackEditing') STORED,
  ADD COLUMN IF NOT EXISTS cell_editing_floor TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'cellEditingFloor') STORED,
  ADD COLUMN IF NOT EXISTS allow_self_validation_audio TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'allowSelfValidationAudio') STORED,
  ADD COLUMN IF NOT EXISTS validation_role_floor_audio TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationRoleFloorAudio') STORED;
