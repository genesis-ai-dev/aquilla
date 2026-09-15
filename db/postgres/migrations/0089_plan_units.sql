-- AQU-1094/1095: per-unit planning metadata — the target date a manager plans
-- against and the explicit mark that says a unit is finished.
--
-- Keyed on (project_id, file_id, section_key) where section_key is '' for a
-- file-grain unit and a Bible book code for a sub-file one, mirroring
-- file_section_progress's 'file' and 'book' scopes. Sub-file units exist only
-- where the subdivision carries STABLE CANONICAL IDENTITY, which is the whole
-- reason a Done mark can be trusted to find its unit again after a re-import.
--
-- Deliberately NOT an event. Events are the document's history — what the text
-- says and who said it. A target date is a manager's plan ABOUT the document,
-- it has no chain, no conflict semantics and nothing to replay; storing it as
-- a row keeps the event log meaning one thing.
--
-- Deliberately NOT lane-keyed either. A book is due when it is due; the date
-- does not change because you are looking at the French tab. Progress is
-- per-lane and comes from file_section_progress; the plan is not.
--
-- Conventions borrowed from their nearest neighbours: target_date is TEXT
-- 'YYYY-MM-DD' like projects.deadline_at (a calendar date, not an instant —
-- TIMESTAMPTZ would timezone-shift it), done_at is epoch-ms like
-- cells.last_edit_at, done_by is a username like cells.last_editor.

CREATE TABLE IF NOT EXISTS plan_units (
    project_id  TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    section_key TEXT NOT NULL DEFAULT '',
    target_date TEXT,
    done_at     BIGINT,
    done_by     TEXT,
    updated_at  BIGINT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (project_id, file_id, section_key),
    -- Rejects '2026-13-45' shapes at the boundary. The route validates the
    -- calendar too (Date round-trip); this is the backstop that keeps a bad
    -- row out however it was written.
    CONSTRAINT plan_units_target_date_check
      CHECK (target_date IS NULL OR target_date ~ '^\d{4}-\d{2}-\d{2}$'),
    -- Provenance is all-or-nothing: a Done mark always knows who made it.
    CONSTRAINT plan_units_done_provenance_check
      CHECK ((done_at IS NULL) = (done_by IS NULL))
);

-- No secondary index: every read is keyed by (project_id) or
-- (project_id, file_id), both covered by the primary key's leading columns.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE plan_units TO app_runtime;
ALTER TABLE plan_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_plan_units_project_access ON plan_units;
CREATE POLICY rls_plan_units_project_access ON plan_units
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));
