-- Transactional markers for directory inputs. A bulk statement touches each
-- affected scope once; project scopes follow the project across org moves.
CREATE TABLE IF NOT EXISTS portfolio_directory_revisions (
  scope text PRIMARY KEY,
  revision uuid NOT NULL DEFAULT gen_random_uuid()
);

CREATE OR REPLACE FUNCTION bump_portfolio_directory_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changes text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO public.portfolio_directory_revisions(scope) VALUES ('reset')
    ON CONFLICT (scope) DO UPDATE SET revision = excluded.revision;
    RETURN NULL;
  END IF;
  changes := CASE TG_OP
    WHEN 'INSERT' THEN format('SELECT %I AS id FROM new_rows', TG_ARGV[1])
    WHEN 'DELETE' THEN format('SELECT %I AS id FROM old_rows', TG_ARGV[1])
    ELSE format('SELECT %1$I AS id FROM old_rows UNION ALL SELECT %1$I FROM new_rows', TG_ARGV[1])
  END;
  -- Opening a project may update last_active_at. Only membership and role
  -- changes affect this directory; activity tracking must not evict it.
  IF TG_TABLE_NAME = 'org_members' AND TG_OP = 'UPDATE' THEN
    changes := 'SELECT coalesce(o.org_id,n.org_id) AS id
      FROM old_rows o FULL JOIN new_rows n USING (org_id,user_id)
      WHERE n.org_id IS NULL OR o.org_id IS NULL OR n.role_level IS DISTINCT FROM o.role_level';
  END IF;
  EXECUTE format('INSERT INTO public.portfolio_directory_revisions(scope)
    SELECT DISTINCT %L || id::text FROM (%s) changed WHERE id IS NOT NULL ORDER BY 1
    ON CONFLICT (scope) DO UPDATE SET revision = excluded.revision', TG_ARGV[0], changes);
  RETURN NULL;
END $$;

DO $$
DECLARE
  dep record;
  op text;
  refs text;
BEGIN
  FOR dep IN SELECT * FROM (VALUES
    ('projects','p:','id'), ('cells','p:','project_id'), ('files','p:','project_id'),
    ('cell_audio','p:','project_id'), ('lanes','p:','project_id'),
    ('file_section_progress','p:','project_id'), ('plan_units','p:','project_id'),
    ('project_settings','p:','project_id'), ('langquest_links','p:','project_id'),
    ('group_project_grants','p:','project_id'), ('project_members','p:','project_id'),
    ('project_member_lane_roles','p:','project_id'), ('org_settings','o:','org_id'),
    ('org_members','o:','org_id'), ('group_members','u:','user_id')
  ) AS inputs(tbl, prefix, col) LOOP
    FOREACH op IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      refs := CASE op WHEN 'INSERT' THEN 'REFERENCING NEW TABLE AS new_rows'
        WHEN 'UPDATE' THEN 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'REFERENCING OLD TABLE AS old_rows' ELSE '' END;
      EXECUTE format('CREATE OR REPLACE TRIGGER %I AFTER %s ON public.%I %s
        FOR EACH STATEMENT EXECUTE FUNCTION bump_portfolio_directory_revision(%L,%L)',
        'portfolio_revision_' || lower(op), op, dep.tbl, refs, dep.prefix, dep.col);
    END LOOP;
  END LOOP;
END $$;

-- Install the read surface last: a partially initialized DB may have the
-- backing table without its triggers, and must use the normal rollup.
CREATE OR REPLACE FUNCTION portfolio_directory_revisions_v1()
RETURNS SETOF portfolio_directory_revisions LANGUAGE sql STABLE AS $$
  SELECT * FROM public.portfolio_directory_revisions
$$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON portfolio_directory_revisions TO app_runtime;
    GRANT EXECUTE ON FUNCTION portfolio_directory_revisions_v1() TO app_runtime;
  END IF;
END $$;
