// AQU-2587: a lane-id clash on the fold's first batch must retry with a NEW id.
//
// The fold creates the host's lane in its first batch, and the lane statement
// mints the lane's 8-hex id when it is built. `retryingLaneIdCollision` re-runs
// the batch after a clash on `uq_lanes_id`, but the statements used to be built
// once, outside the retry, so every attempt carried the same clashing id and
// the merge failed. Here the first id minted is one another project already
// uses; the merge must still succeed, on a different id.

import { afterEach, describe, expect, it, vi } from "vitest"

const ids = vi.hoisted(() => ({ queue: [] as string[], minted: [] as string[] }))
vi.mock("../../../src/lib/lanes/lane-id", async (orig) => {
  const real = (await orig()) as typeof import("../../../src/lib/lanes/lane-id")
  const mint = () => {
    const id = ids.queue.length > 0 ? ids.queue.shift()! : real.newLaneId()
    ids.minted.push(id)
    return id
  }
  return { ...real, newLaneId: mint }
})

import { mergeSibling } from "../events/merge-sibling-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const HOST = "host-proj"
const DONOR = "donor-proj"
const TAKEN = "deadbeef"

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
  ids.queue.length = 0
  ids.minted.length = 0
})

async function seed(db: TestDb): Promise<void> {
  await db.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  await db.pg.query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1, 'Host', 1), ($2, 'Donor', 1), ('other-proj', 'Other', 1)`,
    [HOST, DONOR],
  )
  await db.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES
       ('h-source', $1, 'source', 'English', NULL, 0),
       ('h-default', $1, 'target', 'Spanish', '', 1),
       ('d-source', $2, 'source', 'English', NULL, 0),
       ('d-default', $2, 'target', 'French', '', 1),
       ($3, 'other-proj', 'target', 'German', 'de', 0)`,
    [HOST, DONOR, TAKEN],
  )
  await db.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('host-file', $1, 'Matthew', 'e-hf'), ('donor-file', $2, 'Matthew', 'e-df')`,
    [HOST, DONOR],
  )
  await db.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, lane_id)
     VALUES ($1, 'host-file', 'c-1', 'source', 'Verse 1', 'hsrc-1', 'lead', 1, 'h-source'),
            ($2, 'donor-file', 'c-1', 'target', 'Verset 1', 'dtgt-1', 'translator', 1, 'd-default')`,
    [HOST, DONOR],
  )
}

describe("mergeSibling — a lane-id clash retries with a new id (AQU-2587)", () => {
  it("merges onto a fresh lane id when the first one minted is already taken", async () => {
    t = await makeTestDb()
    await seed(t)
    // Every id minted from here on: the first is taken, later ones are random.
    ids.queue.push(TAKEN)

    const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })

    // The taken id was minted first and a later one won: the clash happened
    // and the retry carried a new id.
    expect(ids.minted[0]).toBe(TAKEN)
    expect(result).toMatchObject({ merged: 1, lane: "fr" })
    const lanes = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 AND role = 'target' AND legacy_tag = 'fr'`,
      [HOST],
    )
    expect(lanes.rows).toHaveLength(1)
    expect(lanes.rows[0]!.id).not.toBe(TAKEN)
    expect(result.hostLaneId).toBe(lanes.rows[0]!.id)
    expect(ids.minted.slice(1)).toContain(lanes.rows[0]!.id)
  })
})
