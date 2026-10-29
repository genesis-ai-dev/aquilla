// AQU-2223 — migration 0188 copies the retired `settings.archivedLanes` mirror
// onto `lanes.archived_at`.
//
// WHY: the write path, the external API and the drafting gate stop reading the
// mirror in the same release. A lane archived the old way — a settings PATCH,
// before the archive route stamped the row — is held archived only by the
// mirror. If this copy missed it, that lane would quietly reopen and accept
// writes again (AQU-1462). If it matched too much, an open lane would freeze.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0188_archived_lanes_onto_rows.sql",
  ),
  "utf8",
)

const PROJECT = "proj-0188"
const EARLIER = "2026-01-02T03:04:05.000Z"

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function seed(td: TestDb, archivedLanes: unknown): Promise<void> {
  await td.pg.query(`INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)`, [
    PROJECT,
    JSON.stringify({ archivedLanes, systemPrompt: "keep me" }),
  ])
  const lanes: [string, string, string | null, string | null, string | null][] = [
    // id, legacy_tag, name, archived_at, language
    ["lane-def", "", "English", null, "English"],
    ["lane-es", "es", "Spanish", null, "Spanish"],
    ["lane-fr", "fr", null, null, "French"],
    ["lane-de", "de", "German", EARLIER, "German"],
    ["lane-pt", "pt", null, null, "Portuguese"],
  ]
  for (const [id, tag, name, archivedAt, language] of lanes) {
    await td.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position, archived_at)
       VALUES ($1, $2, 'target', $3, $4, $5, 0, $6)`,
      [id, PROJECT, language, name, tag, archivedAt],
    )
  }
}

async function archived(td: TestDb): Promise<Record<string, string | null>> {
  const { rows } = await td.pg.query<{ id: string; archived_at: Date | null }>(
    `SELECT id, archived_at FROM lanes WHERE project_id = $1 ORDER BY id`,
    [PROJECT],
  )
  return Object.fromEntries(rows.map((row) => [row.id, row.archived_at ? row.archived_at.toISOString() : null]))
}

describe("migration 0188", () => {
  it("archives the rows the old rule called archived, by tag or name in any case, and nothing else", async () => {
    const td = (t = await makeTestDb())
    // "SPANISH" names lane-es by name; "fr" its tag; "English" would name the
    // '' lane, which the mirror never could; "de" is already archived; 7 and ""
    // are junk the readers skipped.
    await seed(td, ["SPANISH", "fr", "English", "de", 7, ""])

    await td.pg.exec(MIGRATION)
    const after = await archived(td)
    expect(after["lane-es"]).not.toBeNull()
    expect(after["lane-fr"]).not.toBeNull()
    expect(after["lane-def"]).toBeNull()
    expect(after["lane-pt"]).toBeNull()
    // An earlier archive keeps its own timestamp.
    expect(after["lane-de"]).toBe(EARLIER)

    // The blob is history: not rewritten.
    const { rows } = await td.pg.query<{ settings: string }>(
      `SELECT settings FROM project_settings WHERE project_id = $1`,
      [PROJECT],
    )
    expect(JSON.parse(rows[0].settings)).toEqual({
      archivedLanes: ["SPANISH", "fr", "English", "de", 7, ""],
      systemPrompt: "keep me",
    })

    // Safe to re-run: nothing moves the second time.
    await td.pg.exec(MIGRATION)
    expect(await archived(td)).toEqual(after)
  })

  it("leaves a project alone whose mirror is absent or not a list", async () => {
    const td = (t = await makeTestDb())
    await seed(td, "es")
    await td.pg.exec(MIGRATION)
    const after = await archived(td)
    expect(Object.entries(after).filter(([, at]) => at !== null)).toEqual([["lane-de", EARLIER]])
  })
})
