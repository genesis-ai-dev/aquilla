// Test-only: what the PGlite harnesses share so a test database is cheap.
//
// A fresh PGlite is an `initdb` (a whole cluster bootstrap) followed by
// db/postgres/schema.sql. The sync-worker suite asks for one per TEST
// (`makeTestDb`), the auth-worker suite one per FILE, and on the CI runner
// that bootstrap was ~2.4 s of every sync-worker test: about 5,300 of them,
// which is where a 36–56 minute `sync-worker-tests` job came from.
//
// The schema is the same for every one of those databases, so it is built
// once and copied:
//
//   1. `writeTestPgTemplate` (each worker's vitest `globalSetup`) builds one
//      database, dumps its data directory to a tar file, and names the file in
//      TEST_PG_TEMPLATE_ENV for the test processes.
//   2. `testPgTemplate` hands that tar to every `new PGlite({ loadDataDir })`.
//      Loading it skips both initdb and the schema: about a fifth of the
//      cost, and still a separate database per caller, with nothing shared.
//
// A suite that reaches a harness without the globalSetup (the root suite's
// contract tests import sync-worker's `makeTestDb`) builds the template in its
// own process on first use, once per test file. Slower, never wrong.
//
// The template is built for each run from the schema.sql on disk at that
// moment, and is never kept between runs. risk-label.yml's migration gate
// depends on that: it puts a PR's schema.sql under the base commit's harness
// and expects the next run to be on it.
//
// This file imports no PGlite of its own. Each package (root, sync-worker,
// auth-worker) installs its own copy, and a template has to be dumped and
// loaded by the copy that will run the tests, so the caller passes it in.
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TEST_LANE_FILL_ON_SQL, TEST_LANE_FILL_SQL } from "./test-lane-fill"

const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../postgres/schema.sql")

/** Names the template tar `writeTestPgTemplate` wrote for this run. */
export const TEST_PG_TEMPLATE_ENV = "AQUILLA_TEST_PG_TEMPLATE"

/** The part of a PGlite the template is built through. */
export interface TemplateEngine {
  exec(sql: string): Promise<unknown>
  dumpDataDir(compression: "none"): Promise<Blob>
  close(): Promise<void>
}

/**
 * One database with the canonical schema and the test lane functions, as an
 * uncompressed data-directory tar. Uncompressed on purpose: it is loaded
 * thousands of times and written once.
 */
export async function buildTestPgTemplate(create: () => TemplateEngine): Promise<Blob> {
  const pg = create()
  try {
    await pg.exec(readFileSync(SCHEMA_FILE, "utf8"))
    // lane_id is NOT NULL. Tests that omit it get a lane minted by this trigger.
    await pg.exec(TEST_LANE_FILL_SQL)
    // A copy starts the way a crashed server does: by replaying whatever the
    // last checkpoint had not flushed. Without this that is the whole schema,
    // on every copy (about a fifth of its start-up).
    await pg.exec("CHECKPOINT")
    return await pg.dumpDataDir("none")
  } finally {
    await pg.close()
  }
}

/**
 * Vitest `globalSetup` body: build the template once for the whole run and
 * point every test process at it. Returns the teardown that removes it.
 */
export async function writeTestPgTemplate(create: () => TemplateEngine): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aquilla-test-pg-"))
  const file = path.join(dir, "template.tar")
  const template = await buildTestPgTemplate(create)
  await writeFile(file, Buffer.from(await template.arrayBuffer()))
  process.env[TEST_PG_TEMPLATE_ENV] = file
  return async () => {
    delete process.env[TEST_PG_TEMPLATE_ENV]
    await rm(dir, { recursive: true, force: true })
  }
}

let template: Promise<Blob> | undefined

/**
 * The template for `new PGlite({ loadDataDir })`. Read (or, without a
 * globalSetup, built) once per test file and reused for every database that
 * file opens. A template file that is named but unreadable is an error, not a
 * reason to build one quietly: the run was set up to share it.
 */
export function testPgTemplate(create: () => TemplateEngine): Promise<Blob> {
  template ??= (async () => {
    const file = process.env[TEST_PG_TEMPLATE_ENV]
    return file ? new Blob([await readFile(file)]) : buildTestPgTemplate(create)
  })()
  return template
}

/**
 * Run on every database loaded from the template, before its first statement.
 * A data directory carries tables, functions and triggers. It does not carry
 * session settings, and the lane fill is switched on by one.
 */
export const TEST_PG_SESSION_SQL = TEST_LANE_FILL_ON_SQL

/**
 * Between tests: every public table empty, every identity back at its start,
 * the lane fill back on.
 *
 * The end state is the one `TRUNCATE … RESTART IDENTITY CASCADE` over every
 * table leaves. Truncating a table gives it and each of its indexes a new
 * file whether or not it held a row, and a test touches a handful of the
 * ~130 tables, so this truncates only the ones that have ever been written
 * to (a relation with no pages has no rows) and lets CASCADE reach what
 * references them. A sequence a table owns can also have moved without its
 * table gaining a page (a default is evaluated before the constraint that
 * rejects the row), so those are restarted by name.
 */
export const TEST_PG_RESET_SQL = `
DO $reset$
DECLARE
  v_tables text;
  v_sequence regclass;
BEGIN
  SELECT string_agg(c.oid::regclass::text, ', ') INTO v_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_relation_size(c.oid) > 0;
  IF v_tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || v_tables || ' RESTART IDENTITY CASCADE';
  END IF;
  FOR v_sequence IN
    SELECT DISTINCT s.oid::regclass
      FROM pg_class s
      JOIN pg_namespace n ON n.oid = s.relnamespace
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_sequences q ON q.schemaname = n.nspname AND q.sequencename = s.relname
     WHERE s.relkind = 'S' AND tn.nspname = 'public' AND q.last_value IS NOT NULL
  LOOP
    EXECUTE 'ALTER SEQUENCE ' || v_sequence::text || ' RESTART';
  END LOOP;
END
$reset$;
${TEST_LANE_FILL_ON_SQL};
`
