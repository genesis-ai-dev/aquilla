// Test-only stand-in for "every content row has a lane_id".
//
// schema.sql declares lane_id NOT NULL with a composite FK to lanes. Production
// writers resolve the id, and the backfill fills old rows before migrations
// 0104–0111 enforce NOT NULL. Most unit tests never mention lanes: they seed a
// cell (or the projection inserts one) and stop. This BEFORE trigger, installed
// only by the PGlite harnesses, mints the lane that row's tag implies and
// stamps its id so those tests keep passing.
//
// AQU-1611b: projection writers no longer fill target_lang, so a row they
// insert carries the column default ''. The trigger still mints from the
// stored tag when a fixture INSERT names the column and leaves lane_id null.
// A writer statement does not: its lane_id subquery is the only place the
// event tag still appears. rewriteTestLaneResolve turns that subquery, in
// test executors only, into aquilla_test_resolve_* which looks the lane up
// and, while aquilla.test_lane_fill is on, mints it from the bound tag.
// Production SQL is unchanged. With the GUC off, the functions only look
// up, so a missing lane still fails the NOT NULL constraint.
//
// It does not run in production, dev-stack, or e2e. Set the custom GUC
// aquilla.test_lane_fill to 'off' in a test that needs the real rejection
// (a NULL lane_id fails the NOT NULL constraint).
//
// SECURITY DEFINER so a test that SET ROLE app_runtime can still mint the
// lane. The row's own RLS check still runs after the trigger.
//
// A minted target lane stores no name. `laneLanguage` reads a stored name as
// the language the model is told (AQU-1592), so the old 'Default' placeholder
// was sent to the model in place of the project target.

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
      CASE WHEN v_role = 'source' THEN 'Source' ELSE NULL END,
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

// Same id formula as the trigger, so a lane minted from a bound tag and a
// lane minted from a fixture column agree when the tag agrees.
const RESOLVE_SQL = `
CREATE OR REPLACE FUNCTION aquilla_test_resolve_target_lane(p_project text, p_tag text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tag text := COALESCE(p_tag, '');
  v_id text;
BEGIN
  SELECT id INTO v_id FROM lanes
   WHERE project_id = p_project AND role = 'target'
     AND legacy_tag IS NOT DISTINCT FROM v_tag
   LIMIT 1;
  IF v_id IS NOT NULL OR current_setting('aquilla.test_lane_fill', true) = 'off' THEN
    RETURN v_id;
  END IF;
  v_id := substr(md5(p_project || '|target|' || v_tag), 1, 8);
  BEGIN
    INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
    VALUES (
      v_id, p_project, 'target', NULL,
      CASE WHEN v_tag <> '' THEN v_tag ELSE NULL END,
      v_tag, 0
    );
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  SELECT id INTO v_id FROM lanes
   WHERE project_id = p_project AND role = 'target'
     AND legacy_tag IS NOT DISTINCT FROM v_tag
   LIMIT 1;
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION aquilla_test_resolve_source_lane(p_project text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id text;
BEGIN
  SELECT id INTO v_id FROM lanes
   WHERE project_id = p_project AND role = 'source'
   LIMIT 1;
  IF v_id IS NOT NULL OR current_setting('aquilla.test_lane_fill', true) = 'off' THEN
    RETURN v_id;
  END IF;
  v_id := substr(md5(p_project || '|source|'), 1, 8);
  BEGIN
    INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
    VALUES (v_id, p_project, 'source', 'Source', NULL, NULL, 0);
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  SELECT id INTO v_id FROM lanes
   WHERE project_id = p_project AND role = 'source'
   LIMIT 1;
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION aquilla_test_resolve_role_lane(
  p_project text, p_role text, p_role_again text, p_tag text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_role = 'source' THEN
    RETURN aquilla_test_resolve_source_lane(p_project);
  END IF;
  RETURN aquilla_test_resolve_target_lane(p_project, p_tag);
END
$fn$;
`

export const TEST_LANE_FILL_SQL = `${FUNCTION_SQL}\n${TRIGGER_SQL}\n${RESOLVE_SQL}`

const TARGET_RESOLVE =
  /\(SELECT id FROM public\.lanes WHERE project_id = (\$\d+|[A-Za-z_][\w.]*) AND role = 'target' AND legacy_tag = (\$\d+|[A-Za-z_][\w.]*)\)/g

const SOURCE_RESOLVE =
  /\(SELECT id FROM public\.lanes WHERE project_id = (\$\d+|[A-Za-z_][\w.]*) AND role = 'source'\)/g

const ROLE_RESOLVE =
  /\(SELECT id FROM public\.lanes WHERE project_id = (\$\d+)\s+AND\s+\(\s*\(\s*(\$\d+) = 'source' AND role = 'source'\)\s+OR\s+\(\s*(\$\d+) <> 'source' AND role = 'target' AND legacy_tag = (\$\d+)\s*\)\s*\)\s+LIMIT 1\)/g

function statementWrites(sql: string): boolean {
  const body = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trimStart()
  if (/^(insert|update)\b/i.test(body)) return true
  return /^with\b/i.test(body) && /\binsert\s+into\b/i.test(body)
}

/**
 * Test executors only. Production lane lookup stays a scalar subquery that
 * returns NULL when the lane is missing. Here, while the fill GUC is on,
 * that same lookup mints the lane from the tag the writer already binds,
 * because the projection column no longer carries it.
 *
 * Reads are left alone: a SELECT must not create a lane as a side effect.
 */
export function rewriteTestLaneResolve(sql: string): string {
  if (!statementWrites(sql)) return sql
  // cell_backtranslations.lane_id is still nullable. A missing lane stays
  // NULL there, and COALESCE keeps an id already stored. Minting would
  // invent a lane the production subquery does not.
  if (/\bcell_backtranslations\b/i.test(sql)) return sql
  return sql
    .replace(ROLE_RESOLVE, (_m, project, role, roleAgain, tag) =>
      `(SELECT aquilla_test_resolve_role_lane(${project}, ${role}, ${roleAgain}, ${tag}))`)
    .replace(TARGET_RESOLVE, (_m, project, tag) =>
      `(SELECT aquilla_test_resolve_target_lane(${project}, ${tag}))`)
    .replace(SOURCE_RESOLVE, (_m, project) =>
      `(SELECT aquilla_test_resolve_source_lane(${project}))`)
}

export async function installTestLaneFill(
  exec: (sql: string) => Promise<unknown>,
): Promise<void> {
  await exec(TEST_LANE_FILL_SQL)
  await exec(`SELECT set_config('aquilla.test_lane_fill', 'on', false)`)
}
