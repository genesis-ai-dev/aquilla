// AQU-1686 — migration 0150 projects the Bible data switches out of the
// project_settings blob.
//
// WHY: the aquifer gate now answers from these columns alone, so the
// expression IS the gate's rule for what counts as an explicit choice. It must
// read exactly what the old inline `->>` read did (the trust invariant: an
// explicit OFF is always respected), and the migration must be safe to re-run.
import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { expect, it } from "vitest"

const MIGRATION = readFileSync(
  new URL("../../../db/postgres/migrations/0150_project_settings_bible_data.sql", import.meta.url),
  "utf8",
)

it("reads the explicit switch as the gate did, projects the enrichment map, and re-runs cleanly", async () => {
  const pg = new PGlite()
  try {
    await pg.exec(`CREATE TABLE project_settings (
      project_id TEXT PRIMARY KEY,
      settings   TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO project_settings VALUES
      ('on',      '{"bibleResourcesEnabled":true}'),
      ('off',     '{"bibleResourcesEnabled":false}'),
      ('unset',   '{"targetLanguage":"fr"}'),
      ('str-off', '{"bibleResourcesEnabled":"false"}'),
      ('garbage', '{"bibleResourcesEnabled":1}'),
      ('enrich',  '{"bibleEnrichments":{"voices":false,"autopilot":true}}');`)

    await pg.exec(MIGRATION)
    const read = async () =>
      (await pg.query<{ project_id: string; bible_resources_enabled: boolean | null; bible_enrichments: unknown }>(
        "SELECT project_id, bible_resources_enabled, bible_enrichments FROM project_settings ORDER BY project_id",
      )).rows

    expect(await read()).toEqual([
      { project_id: "enrich", bible_resources_enabled: null, bible_enrichments: { voices: false, autopilot: true } },
      // Not 'true'/'false' → no explicit choice; the gate derives from files.
      { project_id: "garbage", bible_resources_enabled: null, bible_enrichments: null },
      { project_id: "off", bible_resources_enabled: false, bible_enrichments: null },
      { project_id: "on", bible_resources_enabled: true, bible_enrichments: null },
      // The old `->>` read counted the string too, so it is still an OFF.
      { project_id: "str-off", bible_resources_enabled: false, bible_enrichments: null },
      { project_id: "unset", bible_resources_enabled: null, bible_enrichments: null },
    ])

    // Re-running is a no-op (IF NOT EXISTS), as the migration runner requires.
    await pg.exec(MIGRATION)

    // A settings write recomputes both columns, so they cannot drift.
    await pg.exec(`UPDATE project_settings
      SET settings = '{"bibleResourcesEnabled":false,"bibleEnrichments":{"places":false}}'
      WHERE project_id = 'unset'`)
    const unset = (await read()).find((row) => row.project_id === "unset")
    expect(unset).toEqual({ project_id: "unset", bible_resources_enabled: false, bible_enrichments: { places: false } })
  } finally {
    await pg.close()
  }
})
