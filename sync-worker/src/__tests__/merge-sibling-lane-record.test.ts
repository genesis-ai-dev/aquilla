// AQU-1550: the lane a sibling merge folds onto has to exist as a real lane.
//
// Every cell row points at a `lanes` row (`cells.lane_id` is NOT NULL with a
// foreign key, AQU-1240). The fold writes its cells through the standard
// projection, which looks the lane up by tag — and nothing created that lane:
// the identity route only appended the tag to the host's `targetLanes` setting,
// after the fold. So on a real database the first folded cell was rejected and
// the merge failed at any donor size.
//
// The other merge-sibling suites could not see it. The test database installs a
// trigger that mints a lane for any row written without one (see
// db/shared/test-lane-fill.ts); it does not exist in production. Every test
// here switches it OFF and seeds the lanes a real project has, so a missing
// lane record fails here the way it fails there.

import { describe, it, expect, afterEach } from "vitest"
import { mergeSibling } from "../events/merge-sibling-route"
import { makeTestDb, type TestDb, type TestDbOptions } from "./helpers/pg-test-db"
import { laneDisplayName, laneLanguageCode } from "../../../src/lib/lanes/lane-display"

const HOST = "host-proj"
const DONOR = "donor-proj"
const HOST_FILE = "host-file"
const DONOR_FILE = "donor-file"
const HOST_SOURCE_LANE = "h-source"
const HOST_DEFAULT_LANE = "h-default"
const DONOR_SOURCE_LANE = "d-source"
const DONOR_DEFAULT_LANE = "d-default"

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** A fresh database that rejects a cell without a lane, as production does. */
async function realLaneDb(opts: TestDbOptions = {}): Promise<TestDb> {
  const db = await makeTestDb({}, opts)
  await db.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  return db
}

/**
 * Host and donor as real projects have them: each with its source lane and its
 * default target lane, the host with `cells` source cells and the donor with a
 * default-lane translation of each. `hostSettings` is the host's settings blob.
 */
async function seedPair(db: TestDb, cells: number, hostSettings?: Record<string, unknown>): Promise<void> {
  await db.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Host', 1), ($2, 'Donor', 1)`, [HOST, DONOR])
  await db.pg.query(
    // AQU-1592: seeded in the post-0136 shape — the typed `language`, no stored
    // name and no stored code, both of which are derived on read.
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES
       ($1, $2, 'source', 'English', NULL, NULL, NULL, 0),
       ($3, $2, 'target', 'Spanish', NULL, NULL, '', 1),
       ($4, $5, 'source', 'English', NULL, NULL, NULL, 0),
       ($6, $5, 'target', 'French', NULL, NULL, '', 1)`,
    [HOST_SOURCE_LANE, HOST, HOST_DEFAULT_LANE, DONOR_SOURCE_LANE, DONOR, DONOR_DEFAULT_LANE],
  )
  if (hostSettings) {
    await db.pg.query(
      `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)`,
      [HOST, JSON.stringify(hostSettings)],
    )
  }
  await db.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, 'Matthew', 'e-hf'), ($3, $4, 'Matthew', 'e-df')`,
    [HOST_FILE, HOST, DONOR_FILE, DONOR],
  )
  await db.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at, lane_id)
     SELECT $1, $2, 'c-' || g, 'source', '', 'Verse ' || g, 'hsrc-' || g, 'lead', 1, $3
       FROM generate_series(1, $4::int) g`,
    [HOST, HOST_FILE, HOST_SOURCE_LANE, cells],
  )
  await db.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at, lane_id)
     SELECT $1, $2, 'c-' || g, 'target', '', 'Verset ' || g, 'dtgt-' || g, 'translator', 1, $3
       FROM generate_series(1, $4::int) g`,
    [DONOR, DONOR_FILE, DONOR_DEFAULT_LANE, cells],
  )
}

interface LaneRow {
  id: string
  role: "source" | "target"
  /** AQU-1592: the stored freeform language. */
  language: string | null
  /** AQU-1592: null when the lane carries only a language. */
  name: string | null
  lang_code: string | null
  legacy_tag: string | null
  position: number
  archived_at: string | null
}

/** The identity fields `laneLanguageCode` reads, in its camelCase shape. */
function laneFields(row: LaneRow) {
  return { role: row.role as "source" | "target", language: row.language, name: row.name, langCode: row.lang_code }
}

async function hostLanes(db: TestDb): Promise<LaneRow[]> {
  const r = await db.pg.query<LaneRow>(
    `SELECT id, role, language, name, lang_code, legacy_tag, position, archived_at
       FROM lanes WHERE project_id = $1 ORDER BY position, id`,
    [HOST],
  )
  return r.rows
}

async function hostLaneCells(db: TestDb, tag: string): Promise<Array<{ cell_id: string; value: string; lane_id: string }>> {
  const r = await db.pg.query<{ cell_id: string; value: string; lane_id: string }>(
    `SELECT cell_id, value, lane_id FROM cells
      WHERE project_id = $1 AND side = 'target' AND target_lang = $2
      ORDER BY cell_id`,
    [HOST, tag],
  )
  return r.rows
}

describe("mergeSibling — the fold's lane is a real lane (AQU-1550)", () => {
  it("creates the lane record and files every folded cell under it", async () => {
    t = await realLaneDb()
    await seedPair(t, 3)

    const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })

    expect(result).toMatchObject({ merged: 3, skipped: [], lane: "fr" })
    const lanes = await hostLanes(t)
    // The host's own lanes are as they were; the new one follows them. Compared
    // on the DISPLAY name (AQU-1592), which is what the screen shows: these
    // lanes store only a language, so that is what they display.
    expect(lanes.map((l) => [l.id, laneDisplayName(l), l.position])).toEqual([
      [HOST_SOURCE_LANE, "English", 0],
      [HOST_DEFAULT_LANE, "Spanish", 1],
      [expect.any(String), "fr", 2],
    ])
    const lane = lanes[2]!
    // The tag IS the new lane's language; no derived name or code is stored.
    expect(lane).toMatchObject({
      role: "target",
      language: "fr",
      name: null,
      lang_code: null,
      legacy_tag: "fr",
      archived_at: null,
    })
    expect(laneLanguageCode(laneFields(lane))).toBe("fr")
    expect(await hostLaneCells(t, "fr")).toEqual([
      { cell_id: "c-1", value: "Verset 1", lane_id: lane.id },
      { cell_id: "c-2", value: "Verset 2", lane_id: lane.id },
      { cell_id: "c-3", value: "Verset 3", lane_id: lane.id },
    ])
    // The lane's progress rollup landed too — it is keyed by the same record.
    const progress = await t.pg.query<{ filled_count: number }>(
      `SELECT filled_count FROM file_section_progress
        WHERE project_id = $1 AND file_id = $2 AND scope = 'file' AND lane_id = $3`,
      [HOST, HOST_FILE, lane.id],
    )
    expect(progress.rows).toEqual([{ filled_count: 3 }])
    // The donor's lanes are not touched.
    const donorLanes = await t.pg.query<{ id: string }>(`SELECT id FROM lanes WHERE project_id = $1 ORDER BY position`, [DONOR])
    expect(donorLanes.rows.map((r) => r.id)).toEqual([DONOR_SOURCE_LANE, DONOR_DEFAULT_LANE])
  })

  it("takes its language from its tag, and derives the code when the tag is a language name", async () => {
    t = await realLaneDb()
    await seedPair(t, 1)

    await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "French" })

    const lane = (await hostLanes(t)).find((l) => l.legacy_tag === "French")!
    // AQU-1592: the tag is stored as the lane's LANGUAGE. The display name and
    // the "fr" code are derived from it on read, never written — a code written
    // here would keep claiming "French" after someone edited the label.
    expect(lane).toMatchObject({ language: "French", name: null, lang_code: null, role: "target" })
    expect(laneDisplayName(lane)).toBe("French")
    expect(laneLanguageCode(laneFields(lane))).toBe("fr")
  })

  it("puts the lane after the lanes the host already has", async () => {
    t = await realLaneDb()
    await seedPair(t, 1, { targetLanguage: "Spanish", targetLanes: ["pt"] })
    await t.pg.query(
      // A lane whose maintainer gave it a display name of its own.
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ('h-pt', $1, 'target', 'Portuguese', 'Brazilian Portuguese', NULL, 'pt', 2)`,
      [HOST],
    )

    await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })

    expect((await hostLanes(t)).map((l) => [laneDisplayName(l), l.legacy_tag, l.position])).toEqual([
      ["English", null, 0],
      ["Spanish", "", 1],
      // An existing lane keeps the name its maintainer gave it.
      ["Brazilian Portuguese", "pt", 2],
      ["fr", "fr", 3],
    ])
  })

  it("a second run reuses the lane: one record, no new events", async () => {
    t = await realLaneDb()
    await seedPair(t, 3)

    await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })
    const lanesAfterFirst = await hostLanes(t)
    const eventsAfterFirst = await t.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`, [HOST])

    const rerun = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })

    expect(rerun.merged).toBe(3)
    expect((await hostLanes(t)).map((l) => l.id)).toEqual(lanesAfterFirst.map((l) => l.id))
    const eventsAfterSecond = await t.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`, [HOST])
    expect(eventsAfterSecond.rows[0]?.n).toBe(eventsAfterFirst.rows[0]?.n)
    expect(await hostLaneCells(t, "fr")).toHaveLength(3)
  })

  it("a fold that fails before it writes anything leaves no lane behind", async () => {
    let failEventsInsert = false
    t = await realLaneDb({
      onStatement: (sql) => {
        if (failEventsInsert && /INSERT INTO events\b/.test(sql)) throw new Error("simulated write failure")
      },
    })
    await seedPair(t, 3)

    failEventsInsert = true
    await expect(
      mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" }),
    ).rejects.toThrow("simulated write failure")
    failEventsInsert = false

    // No half-created lane for the maintainer to find in the switcher...
    expect((await hostLanes(t)).map((l) => l.id)).toEqual([HOST_SOURCE_LANE, HOST_DEFAULT_LANE])
    expect(await hostLaneCells(t, "fr")).toEqual([])

    // ...and the retry is an ordinary first run.
    const retry = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })
    expect(retry.merged).toBe(3)
    expect((await hostLanes(t)).filter((l) => l.legacy_tag === "fr")).toHaveLength(1)
    expect(await hostLaneCells(t, "fr")).toHaveLength(3)
  })

  it("a donor with nothing to fold creates no lane", async () => {
    t = await realLaneDb()
    await seedPair(t, 0)
    await t.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at, lane_id)
       VALUES ($1, $2, 'orphan', 'target', '', 'Orphelin', 'dtgt-orphan', 'translator', 1, $3)`,
      [DONOR, DONOR_FILE, DONOR_DEFAULT_LANE],
    )

    const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })

    expect(result.merged).toBe(0)
    expect(result.skipped.map((s) => s.cellId)).toEqual(["orphan"])
    expect((await hostLanes(t)).map((l) => l.id)).toEqual([HOST_SOURCE_LANE, HOST_DEFAULT_LANE])
  })
})
