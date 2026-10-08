// AQU-1602: the sibling merge folds the donor lane the caller picks, by id.
//
// The fold used to read the donor's `target_lang = ''` rows and only those —
// the former default lane, by its legacy tag. A legacy pair project set up
// through the languages screen gives its one lane the lane id as the tag
// (AQU-1418), not '', so for those donors the query matched nothing: the merge
// reported `merged: 0`, the identity route then archived the donor, and every
// translation in it became unreachable.
//
// So these tests seed donors whose lane is NOT the former default lane, and
// pin the two acceptance criteria — such a donor merges correctly, and a
// re-run stays idempotent — plus the refusal that replaces guessing when a
// donor has more than one lane.
//
// Like merge-sibling-lane-record.test.ts, every test here switches the test
// harness's lane-filling trigger OFF and seeds the lanes a real project has,
// so lane resolution fails the way it fails in production rather than being
// papered over (see db/shared/test-lane-fill.ts).

import { describe, it, expect, afterEach } from "vitest"
import { mergeSibling, MergeSiblingRefusal, handleMergeSiblingRequest } from "../events/merge-sibling-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const HOST = "host-proj"
const DONOR = "donor-proj"
const HOST_FILE = "host-file"
const DONOR_FILE = "donor-file"
const HOST_SOURCE_LANE = "h-source"
const HOST_DEFAULT_LANE = "h-default"
const DONOR_SOURCE_LANE = "d-source"

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** A fresh database that rejects a cell without a lane, as production does. */
async function realLaneDb(): Promise<TestDb> {
  const db = await makeTestDb({})
  await db.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  return db
}

interface DonorLaneSeed {
  id: string
  name: string
  /** The lane's `legacy_tag` — deliberately NOT '' in most of these tests. */
  tag: string
  archived?: boolean
}

/**
 * Host with its source + default lanes and `cells` source cells; donor with its
 * source lane and the target lanes described by `donorLanes`, each holding a
 * translation of every host cell.
 */
async function seedPair(
  db: TestDb,
  cells: number,
  donorLanes: readonly DonorLaneSeed[],
): Promise<void> {
  await db.pg.query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1, 'Host', 1), ($2, 'Donor', 1)`,
    [HOST, DONOR],
  )
  await db.pg.query(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
       ($1, $2, 'source', 'English', 'en', NULL, 0),
       ($3, $2, 'target', 'Spanish', 'es', '', 1),
       ($4, $5, 'source', 'English', 'en', NULL, 0)`,
    [HOST_SOURCE_LANE, HOST, HOST_DEFAULT_LANE, DONOR_SOURCE_LANE, DONOR],
  )
  let position = 1
  for (const lane of donorLanes) {
    await db.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position, archived_at)
       VALUES ($1, $2, 'target', $3, NULL, $4, $5, $6)`,
      [
        lane.id,
        DONOR,
        lane.name,
        lane.tag,
        position++,
        lane.archived ? new Date().toISOString() : null,
      ],
    )
  }
  await db.pg.query(
    `INSERT INTO files (id, project_id, name, event_id)
     VALUES ($1, $2, 'Matthew', 'e-hf'), ($3, $4, 'Matthew', 'e-df')`,
    [HOST_FILE, HOST, DONOR_FILE, DONOR],
  )
  await db.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, lane_id) SELECT $1, $2, 'c-' || g, 'source', 'Verse ' || g, 'hsrc-' || g, 'lead', 1, $3 FROM generate_series(1, $4::int) g`,
    [HOST, HOST_FILE, HOST_SOURCE_LANE, cells],
  )
  for (const lane of donorLanes) {
    await db.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, lane_id) SELECT $1, $2, 'c-' || g, 'target', $3 || ' ' || g, 'dtgt-' || $4 || '-' || g, 'translator', 1, $4 FROM generate_series(1, $5::int) g`,
      [DONOR, DONOR_FILE, lane.name, lane.id, cells],
    )
  }
}

async function hostLaneCells(
  db: TestDb,
  tag: string,
): Promise<Array<{ cell_id: string; value: string; lane_id: string }>> {
  const r = await db.pg.query<{ cell_id: string; value: string; lane_id: string }>(
    `SELECT c.cell_id, c.value, c.lane_id
       FROM cells c
       JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
      WHERE c.project_id = $1 AND c.side = 'target' AND l.legacy_tag = $2
      ORDER BY c.cell_id`,
    [HOST, tag],
  )
  return r.rows
}

async function hostEventCount(db: TestDb): Promise<number> {
  const r = await db.pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`,
    [HOST],
  )
  return r.rows[0]?.n ?? 0
}

describe("mergeSibling — the donor lane is chosen by id (AQU-1602)", () => {
  it("folds a donor whose only lane is NOT the former default lane", async () => {
    t = await realLaneDb()
    // The regression shape: one lane, tagged with its own lane id.
    await seedPair(t, 3, [{ id: "d-quechua", name: "Quechua", tag: "d-quechua" }])

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "Quechua",
    })

    expect(result).toMatchObject({ merged: 3, skipped: [], lane: "Quechua", donorLaneId: "d-quechua" })
    expect(result.hostLaneId).toEqual(expect.any(String))
    expect(await hostLaneCells(t, "Quechua")).toEqual([
      { cell_id: "c-1", value: "Quechua 1", lane_id: result.hostLaneId },
      { cell_id: "c-2", value: "Quechua 2", lane_id: result.hostLaneId },
      { cell_id: "c-3", value: "Quechua 3", lane_id: result.hostLaneId },
    ])
  })

  it("re-running that merge stays idempotent", async () => {
    t = await realLaneDb()
    await seedPair(t, 3, [{ id: "d-quechua", name: "Quechua", tag: "d-quechua" }])
    const args = { hostProjectId: HOST, donorProjectId: DONOR, lane: "Quechua" }

    const first = await mergeSibling(t.db, args)
    const eventsAfterFirst = await hostEventCount(t)

    const second = await mergeSibling(t.db, args)

    expect(second.merged).toBe(3)
    expect(second.hostLaneId).toBe(first.hostLaneId)
    expect(await hostEventCount(t)).toBe(eventsAfterFirst)
    expect(await hostLaneCells(t, "Quechua")).toHaveLength(3)
    // One lane record, not one per run.
    const lanes = await t.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lanes WHERE project_id = $1 AND legacy_tag = 'Quechua'`,
      [HOST],
    )
    expect(lanes.rows[0]?.n).toBe(1)
  })

  it("folds the lane the caller names, and leaves the donor's other lane alone", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [
      { id: "d-fr", name: "French", tag: "fr" },
      { id: "d-pt", name: "Portuguese", tag: "pt" },
    ])

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "pt",
      donorLaneId: "d-pt",
    })

    expect(result).toMatchObject({ merged: 2, donorLaneId: "d-pt" })
    expect((await hostLaneCells(t, "pt")).map((r) => r.value)).toEqual([
      "Portuguese 1",
      "Portuguese 2",
    ])
    // The French lane was not folded, and neither was it invented on the host.
    expect(await hostLaneCells(t, "fr")).toEqual([])
  })

  it("refuses a donor with several active lanes rather than guessing, and writes nothing", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [
      { id: "d-fr", name: "French", tag: "fr" },
      { id: "d-pt", name: "Portuguese", tag: "pt" },
    ])

    await expect(
      mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" }),
    ).rejects.toBeInstanceOf(MergeSiblingRefusal)

    expect(await hostEventCount(t)).toBe(0)
    expect(await hostLaneCells(t, "fr")).toEqual([])
    const lanes = await t.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lanes WHERE project_id = $1`,
      [HOST],
    )
    // Only the host's own two lanes; no half-created fold lane.
    expect(lanes.rows[0]?.n).toBe(2)
  })

  it("auto-selects the one ACTIVE lane when the donor's others are archived", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [
      { id: "d-old", name: "Old draft", tag: "old", archived: true },
      { id: "d-fr", name: "French", tag: "fr" },
    ])

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "fr",
    })

    expect(result).toMatchObject({ merged: 2, donorLaneId: "d-fr" })
    expect((await hostLaneCells(t, "fr")).map((r) => r.value)).toEqual(["French 1", "French 2"])
  })

  it("refuses a donorLaneId that is not one of the donor's lanes", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [{ id: "d-fr", name: "French", tag: "fr" }])

    await expect(
      mergeSibling(t.db, {
        hostProjectId: HOST,
        donorProjectId: DONOR,
        lane: "fr",
        donorLaneId: "not-a-lane",
      }),
    ).rejects.toMatchObject({ reason: "not_found" })
    expect(await hostEventCount(t)).toBe(0)
  })

  it("reports the donor lane even when nothing matched", async () => {
    t = await realLaneDb()
    // No host source cells, so every donor cell is skipped.
    await seedPair(t, 0, [{ id: "d-fr", name: "French", tag: "fr" }])
    await t.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, lane_id) VALUES ($1, $2, 'orphan', 'target', 'Orphelin', 'dtgt-orphan', 'translator', 1, 'd-fr')`,
      [DONOR, DONOR_FILE],
    )

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "fr",
    })

    expect(result).toMatchObject({ merged: 0, donorLaneId: "d-fr", hostLaneId: null })
    expect(result.skipped.map((s) => s.cellId)).toEqual(["orphan"])
  })
})

describe("handleMergeSiblingRequest — the donor-lane refusal is a 400 (AQU-1602)", () => {
  const SECRET = "test-secret"

  async function post(body: Record<string, unknown>): Promise<Response | null> {
    const token = await makeTestToken(SECRET, {
      userId: 7,
      projectId: HOST,
      fileId: "__project__",
      role: 500,
      src: "platform",
    })
    const req = new Request(`https://x.test/api/v1/projects/${HOST}/merge-sibling`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return handleMergeSiblingRequest(req, { AQUILLA_PG: t!.db, SYNC_SECRET_KEY: SECRET })
  }

  it("400s an ambiguous donor and lists its lanes for the operator to choose", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [
      { id: "d-fr", name: "French", tag: "fr" },
      { id: "d-pt", name: "Portuguese", tag: "pt" },
    ])

    const res = await post({ donorProjectId: DONOR, lane: "fr" })

    expect(res?.status).toBe(400)
    const body = (await res!.json()) as {
      reason: string
      donorLanes: Array<{ id: string; name: string }>
    }
    expect(body.reason).toBe("ambiguous")
    expect(body.donorLanes).toEqual([
      { id: "d-fr", name: "French" },
      { id: "d-pt", name: "Portuguese" },
    ])
  })

  it("200s once the operator names a lane, and returns both lane ids", async () => {
    t = await realLaneDb()
    await seedPair(t, 2, [
      { id: "d-fr", name: "French", tag: "fr" },
      { id: "d-pt", name: "Portuguese", tag: "pt" },
    ])

    const res = await post({ donorProjectId: DONOR, lane: "fr", donorLaneId: "d-fr" })

    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { merged: number; donorLaneId: string; hostLaneId: string }
    expect(body.merged).toBe(2)
    expect(body.donorLaneId).toBe("d-fr")
    expect(body.hostLaneId).toEqual(expect.any(String))
  })
})
