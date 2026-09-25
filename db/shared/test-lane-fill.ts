// Test-only stand-in for "every content row has a lane_id".
//
// schema.sql declares lane_id NOT NULL with a composite FK to lanes. Production
// writers resolve the id, and the backfill fills old rows before migrations
// 0104–0111 enforce NOT NULL. Most unit tests never mention lanes: they seed a
// cell (or the projection inserts one) and stop. This BEFORE trigger, installed
// only by the PGlite harnesses, mints the lane that row's tag implies and
// stamps its id so those tests keep passing.
//
// It does not run in production, dev-stack, or e2e. Set the custom GUC
// aquilla.test_lane_fill to 'off' in a test that needs the real rejection
// (a NULL lane_id fails the NOT NULL constraint).
//
// SECURITY DEFINER so a test that SET ROLE app_runtime can still mint the
// lane. The row's own RLS check still runs after the trigger.

const LANE_TABLES = [
  "cells",
  "cell_validators",
  "file_section_progress",
  "assignments",
  "artifact_bindings",
  "scene_briefs",
  "contextual_runs",
  "contextual_drafts",
] as const

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION aquilla_test_fill_lane_id() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_tag text;
  v_id text;
BEGIN
  IF current_setting('aquilla.test_lane_fill', true) = 'off' THEN
    RETURN NEW;
  END IF;
  IF NEW.lane_id IS NOT NULL AND btrim(NEW.lane_id) <> '' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'cells' THEN
    IF NEW.side = 'source' THEN
      v_role := 'source';
      v_tag := NULL;
    ELSE
      v_role := 'target';
      v_tag := COALESCE(NEW.target_lang, '');
    END IF;
  ELSIF TG_TABLE_NAME = 'artifact_bindings' THEN
    IF NEW.binding_role = 'source' THEN
      v_role := 'source';
      v_tag := NULL;
    ELSE
      v_role := 'target';
      v_tag := COALESCE(NEW.target_lang, '');
    END IF;
  ELSE
    v_role := 'target';
    v_tag := COALESCE(NEW.target_lang, '');
  END IF;

  IF v_role = 'source' THEN
    SELECT id INTO v_id FROM lanes
     WHERE project_id = NEW.project_id AND role = 'source'
     LIMIT 1;
  ELSE
    SELECT id INTO v_id FROM lanes
     WHERE project_id = NEW.project_id AND role = 'target'
       AND legacy_tag IS NOT DISTINCT FROM v_tag
     LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    v_id := substr(md5(NEW.project_id || '|' || v_role || '|' || COALESCE(v_tag, '')), 1, 8);
    INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
    VALUES (
      v_id,
      NEW.project_id,
      v_role,
      CASE WHEN v_role = 'source' THEN 'Source' ELSE COALESCE(NULLIF(v_tag, ''), 'Default') END,
      CASE WHEN v_role = 'target' AND v_tag IS NOT NULL AND v_tag <> '' THEN v_tag ELSE NULL END,
      CASE WHEN v_role = 'source' THEN NULL ELSE v_tag END,
      0
    );
  END IF;

  NEW.lane_id := v_id;
  RETURN NEW;
END
$fn$;
`

const TRIGGER_SQL = LANE_TABLES.map(
  (table) => `
DROP TRIGGER IF EXISTS aquilla_test_fill_lane_id ON ${table};
CREATE TRIGGER aquilla_test_fill_lane_id
  BEFORE INSERT OR UPDATE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION aquilla_test_fill_lane_id();
`,
).join("\n")

export const TEST_LANE_FILL_SQL = `${FUNCTION_SQL}\n${TRIGGER_SQL}`

export async function installTestLaneFill(
  exec: (sql: string) => Promise<unknown>,
): Promise<void> {
  await exec(TEST_LANE_FILL_SQL)
  await exec(`SELECT set_config('aquilla.test_lane_fill', 'on', false)`)
}
