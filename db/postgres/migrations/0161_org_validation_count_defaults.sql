-- 0161_org_validation_count_defaults.sql — AQU-1771 settings projections
--
-- Two sets of STORED generated columns for AQU-1771, both so the settings
-- blob (several MB on some projects) is never parsed on a read path. Same
-- pattern as 0063, 0092, 0096, 0123 and 0150.
--
-- 1. org_settings: the org-level defaults for how many validations make a
--    cell (validationCount) or a recorded take (validationCountAudio) count as
--    validated. A project may still set its own; absent on the project falls
--    through to the org, and absent on both reads as 1. Same shape as
--    count_structural (0092). Lets the org dashboard, the progress reads and
--    the Monday push resolve the effective threshold in SQL.
--
-- 2. project_settings: the project's own, stricter-only floors for who sees
--    its member list (rosterViewMinRole) and each member's progress
--    (memberProgressViewMinRole). Read on every roster and named-progress
--    check — the member list, mention suggestions, the Team card and plan
--    reads, the activity panel, the access screens, the org's members grid
--    and Team workload — and by the org Security page's "N projects are
--    stricter" count. NULL unless the key holds a JSON number.
--
-- DEPLOY: part 2 adds generated columns to project_settings, so Postgres
-- rewrites that table once, holding its lock for the rewrite (as the earlier
-- generated-column migrations did). Both columns are added in ONE ALTER so the
-- table is rewritten once, not twice.
--
-- Idempotent. A database loaded from schema.sql already has all four.
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS validation_count TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED;

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS validation_count_audio TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED;

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS roster_view_min_role TEXT
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof((settings::jsonb) -> 'rosterViewMinRole') = 'number' THEN (settings::jsonb) ->> 'rosterViewMinRole' END) STORED,
  ADD COLUMN IF NOT EXISTS member_progress_view_min_role TEXT
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof((settings::jsonb) -> 'memberProgressViewMinRole') = 'number' THEN (settings::jsonb) ->> 'memberProgressViewMinRole' END) STORED;
