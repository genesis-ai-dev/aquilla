-- 0112_fk_project_member_lane_roles.sql — AQU-1416.
--
-- project_member_lane_roles.lane stores lanes.id. 0091 cannot declare the
-- foreign key: it sorts before 0096_lanes. This migration does not rewrite
-- 0091.
--
-- NOT VALID first, then VALIDATE. The table is empty until the grant
-- backfill, and the backfill writes lanes.id, so validation is a small
-- scan. A row whose lane is a language tag fails here on purpose.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_member_lane_roles_lane_fkey'
       AND conrelid = 'public.project_member_lane_roles'::regclass
  ) THEN
    ALTER TABLE public.project_member_lane_roles
      ADD CONSTRAINT project_member_lane_roles_lane_fkey
      FOREIGN KEY (project_id, lane) REFERENCES public.lanes (project_id, id)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_member_lane_roles_lane_fkey'
       AND conrelid = 'public.project_member_lane_roles'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.project_member_lane_roles
      VALIDATE CONSTRAINT project_member_lane_roles_lane_fkey;
  END IF;
END $$;

COMMENT ON COLUMN public.project_member_lane_roles.lane IS
  'lanes.id. The UI shows lanes.name, never this id.';
