-- 0074: durable, inspectable contextual-autopilot activity (AQU-826).
--
-- This is deliberately an APPEND-ONLY product activity stream, not an LLM
-- trace sink. Rows contain a small, sanitized vocabulary of progress facts;
-- prompts, draft text, model reasoning, and token deltas belong nowhere in
-- this table. db/shared/contextual-runs.ts applies a per-kind detail allowlist
-- before every insert, and the byte checks below provide a second bound.

-- postgres.js infers a ?::jsonb parameter's type and serializes it. Older
-- scene-brief writes pre-stringified provenance first, so valid objects landed
-- as JSONB scalar strings and `provenance ->> 'runId'` could not find them.
-- Parse each scalar independently: malformed JSON and valid non-object JSON
-- remain byte-for-byte untouched, and a concurrent edit wins the row guard.
DO $normalize_scene_provenance$
DECLARE
  legacy RECORD;
  parsed jsonb;
BEGIN
  FOR legacy IN
    SELECT id, provenance, provenance #>> '{}' AS payload
      FROM scene_briefs
     WHERE jsonb_typeof(provenance) = 'string'
  LOOP
    BEGIN
      parsed := legacy.payload::jsonb;
      IF jsonb_typeof(parsed) = 'object' THEN
        UPDATE scene_briefs
           SET provenance = parsed
         WHERE id = legacy.id AND provenance = legacy.provenance;
      END IF;
    EXCEPTION WHEN others THEN
      NULL; -- preserve any scalar Postgres cannot safely decode as jsonb
    END;
  END LOOP;
END
$normalize_scene_provenance$;

-- The same adapter bug affected contextual JSON written before this release.
-- Normalize only scalar strings that parse to objects; malformed or
-- non-object values are deliberately preserved so the migration is lossless.
DO $normalize_contextual_json$
DECLARE
  legacy RECORD;
  parsed jsonb;
BEGIN
  FOR legacy IN
    SELECT id, role_snapshot AS original, role_snapshot #>> '{}' AS payload
      FROM contextual_runs WHERE jsonb_typeof(role_snapshot) = 'string'
  LOOP
    BEGIN
      parsed := legacy.payload::jsonb;
      IF jsonb_typeof(parsed) = 'object' THEN
        UPDATE contextual_runs SET role_snapshot = parsed
         WHERE id = legacy.id AND role_snapshot = legacy.original;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;

  FOR legacy IN
    SELECT id, span_cursor AS original, span_cursor #>> '{}' AS payload
      FROM contextual_runs WHERE jsonb_typeof(span_cursor) = 'string'
  LOOP
    BEGIN
      parsed := legacy.payload::jsonb;
      IF jsonb_typeof(parsed) = 'object' THEN
        UPDATE contextual_runs SET span_cursor = parsed
         WHERE id = legacy.id AND span_cursor = legacy.original;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;

  FOR legacy IN
    SELECT id, verdicts AS original, verdicts #>> '{}' AS payload
      FROM contextual_drafts WHERE jsonb_typeof(verdicts) = 'string'
  LOOP
    BEGIN
      parsed := legacy.payload::jsonb;
      IF jsonb_typeof(parsed) = 'object' THEN
        UPDATE contextual_drafts SET verdicts = parsed
         WHERE id = legacy.id AND verdicts = legacy.original;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;

  FOR legacy IN
    SELECT id, provenance AS original, provenance #>> '{}' AS payload
      FROM contextual_drafts WHERE jsonb_typeof(provenance) = 'string'
  LOOP
    BEGIN
      parsed := legacy.payload::jsonb;
      IF jsonb_typeof(parsed) = 'object' THEN
        UPDATE contextual_drafts SET provenance = parsed
         WHERE id = legacy.id AND provenance = legacy.original;
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END
$normalize_contextual_json$;

-- Project history and run-scoped scene evidence are both newest-tail reads.
CREATE INDEX IF NOT EXISTS contextual_runs_project_time
  ON contextual_runs(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS contextual_runs_project_lane_time
  ON contextual_runs(project_id, file_id, target_lang, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS scene_briefs_run_provenance_time
  ON scene_briefs(project_id, (provenance ->> 'runId'), created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS contextual_drafts_project_status_run_time
  ON contextual_drafts(project_id, status, run_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS contextual_run_events (
  id text PRIMARY KEY,                  -- uuidv7; time ordered within one process
  run_id text NOT NULL,
  project_id text NOT NULL,
  file_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'run_created',
    'run_state',
    'span_started',
    'phase',
    'scene_ready',
    'drafts_staged',
    'span_outcome',
    'steering_queued',
    'draft_reviewed'
  )),
  span_id text,
  span_label text,
  status text,
  phase text CHECK (phase IS NULL OR phase IN ('reading','drafting','checking','staging')),
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object')
    CHECK (octet_length(details::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(id) = 36),
  CHECK (octet_length(run_id) <= 512),
  CHECK (octet_length(project_id) <= 512),
  CHECK (octet_length(file_id) <= 512),
  CHECK (span_id IS NULL OR octet_length(span_id) <= 512),
  CHECK (status IS NULL OR octet_length(status) <= 64),
  CHECK (octet_length(summary) <= 512),
  CHECK (span_label IS NULL OR octet_length(span_label) <= 512)
);

-- Stable ordering uses (created_at, id): timestamps can collide inside one
-- wave, while uuidv7 provides a deterministic tie-breaker.
CREATE INDEX IF NOT EXISTS contextual_run_events_run_time
  ON contextual_run_events(run_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS contextual_run_events_project_time
  ON contextual_run_events(project_id, created_at DESC, id DESC);

-- Short-lived weighted leases are the cross-isolate authority and queue for
-- the project model-work ceiling. Every runOneTick wave holds one; waiters
-- keep polling durable run state so pause/terminate remains responsive.
CREATE TABLE IF NOT EXISTS contextual_project_leases (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  run_id text NOT NULL UNIQUE,
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(id) = 36),
  CHECK (octet_length(project_id) <= 512),
  CHECK (octet_length(run_id) <= 512)
);
CREATE INDEX IF NOT EXISTS contextual_project_leases_project_expiry
  ON contextual_project_leases(project_id, expires_at);

-- Agent-authored SQL executes with BOTH `app.user_id` and `app.project_id`.
-- Pin rows to that exact project as well as membership: membership alone
-- would let a hostile cross join read another project the same user belongs
-- to. Background tick/route I/O uses neither GUC and keeps its bare path.
-- Tick/route activity I/O intentionally uses the bare runtime handle: an
-- absent (or explicit admin-empty) GUC therefore retains its existing access.
-- This two-mode policy is narrow to this append-only telemetry table; normal
-- user request paths still authorize at the route before using the bare mode.
ALTER TABLE contextual_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_run_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_contextual_run_events_select ON contextual_run_events;
CREATE POLICY rls_contextual_run_events_select ON contextual_run_events
  AS PERMISSIVE
  FOR SELECT
  TO app_runtime
  USING (
    (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NULL
    )
    OR (
      NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NOT NULL
      AND project_id = current_setting('app.project_id', true)
      AND app_user_can_access_project(project_id)
    )
  );

DROP POLICY IF EXISTS rls_contextual_run_events_insert ON contextual_run_events;
CREATE POLICY rls_contextual_run_events_insert ON contextual_run_events
  AS PERMISSIVE
  FOR INSERT
  TO app_runtime
  WITH CHECK (
    (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NULL
    )
    OR (
      NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NOT NULL
      AND project_id = current_setting('app.project_id', true)
      AND app_user_can_access_project(project_id)
    )
  );

-- 0070/0071 intentionally did not grant their new tables to app_runtime:
-- 0034 requires every future table to opt into permissions only alongside an
-- RLS policy. The contextual routes/tick use a bare handle; model-authored SQL
-- carries both scoped GUCs. This helper centralizes that exact two-mode rule.
CREATE OR REPLACE FUNCTION app_contextual_project_scope(p_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $scope$
  SELECT (
    (
      NULLIF(current_setting('app.user_id', true), '') IS NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NULL
    )
    OR (
      NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
      AND NULLIF(current_setting('app.project_id', true), '') IS NOT NULL
      AND p_project_id = current_setting('app.project_id', true)
      AND app_user_can_access_project(p_project_id)
    )
  )
$scope$;
REVOKE ALL ON FUNCTION app_contextual_project_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_contextual_project_scope(text) TO app_runtime;

ALTER TABLE scene_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_briefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scene_briefs_select ON scene_briefs;
CREATE POLICY rls_scene_briefs_select ON scene_briefs FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_scene_briefs_insert ON scene_briefs;
CREATE POLICY rls_scene_briefs_insert ON scene_briefs FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_scene_briefs_update ON scene_briefs;
CREATE POLICY rls_scene_briefs_update ON scene_briefs FOR UPDATE TO app_runtime
  USING (app_contextual_project_scope(project_id))
  WITH CHECK (app_contextual_project_scope(project_id));

ALTER TABLE contextual_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_runs_select ON contextual_runs;
CREATE POLICY rls_contextual_runs_select ON contextual_runs FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_runs_insert ON contextual_runs;
CREATE POLICY rls_contextual_runs_insert ON contextual_runs FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_runs_update ON contextual_runs;
CREATE POLICY rls_contextual_runs_update ON contextual_runs FOR UPDATE TO app_runtime
  USING (app_contextual_project_scope(project_id))
  WITH CHECK (app_contextual_project_scope(project_id));

ALTER TABLE contextual_steering ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_steering FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_steering_select ON contextual_steering;
CREATE POLICY rls_contextual_steering_select ON contextual_steering FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_steering_insert ON contextual_steering;
CREATE POLICY rls_contextual_steering_insert ON contextual_steering FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_steering_update ON contextual_steering;
CREATE POLICY rls_contextual_steering_update ON contextual_steering FOR UPDATE TO app_runtime
  USING (app_contextual_project_scope(project_id))
  WITH CHECK (app_contextual_project_scope(project_id));

ALTER TABLE contextual_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_drafts_select ON contextual_drafts;
CREATE POLICY rls_contextual_drafts_select ON contextual_drafts FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_drafts_insert ON contextual_drafts;
CREATE POLICY rls_contextual_drafts_insert ON contextual_drafts FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_drafts_update ON contextual_drafts;
CREATE POLICY rls_contextual_drafts_update ON contextual_drafts FOR UPDATE TO app_runtime
  USING (app_contextual_project_scope(project_id))
  WITH CHECK (app_contextual_project_scope(project_id));

ALTER TABLE contextual_project_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE contextual_project_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_contextual_project_leases_select ON contextual_project_leases;
CREATE POLICY rls_contextual_project_leases_select ON contextual_project_leases FOR SELECT TO app_runtime
  USING (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_project_leases_insert ON contextual_project_leases;
CREATE POLICY rls_contextual_project_leases_insert ON contextual_project_leases FOR INSERT TO app_runtime
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_project_leases_update ON contextual_project_leases;
CREATE POLICY rls_contextual_project_leases_update ON contextual_project_leases FOR UPDATE TO app_runtime
  USING (app_contextual_project_scope(project_id))
  WITH CHECK (app_contextual_project_scope(project_id));
DROP POLICY IF EXISTS rls_contextual_project_leases_delete ON contextual_project_leases;
CREATE POLICY rls_contextual_project_leases_delete ON contextual_project_leases FOR DELETE TO app_runtime
  USING (app_contextual_project_scope(project_id));

GRANT SELECT, INSERT, UPDATE ON TABLE scene_briefs TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE contextual_runs TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE contextual_steering TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE contextual_drafts TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contextual_project_leases TO app_runtime;

-- Runtime can append and inspect, never rewrite history. Tenant scoping stays
-- at the authenticated route/tick boundary, matching the sibling contextual
-- tables whose background driver has no request-scoped RLS identity.
GRANT SELECT, INSERT ON TABLE contextual_run_events TO app_runtime;
