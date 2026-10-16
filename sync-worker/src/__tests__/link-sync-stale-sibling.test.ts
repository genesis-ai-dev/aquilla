// AQU-1574: a live link must mirror what its upstream APPLIED, not every edit
// its upstream LOGGED.
//
// Chain-mutating events are a head compare-and-swap (AQU-1154): one projects
// only if its parentId is the cell's current head. The loser of a race (two
// editors, or one offline, committing on the same parent) is still written to
// `events` and answered with a 200 and a `stale[]` entry, but it never reaches
// `cells`. The mirror fold reads `events`, and folded every commit in seq
// order — so a stale sibling logged after the winner replaced the winner's
// text downstream, and the two projects disagreed for good once the cursor
// moved past it.
//
// Every upstream event here goes through the real POST /events route, so which
// events are stale is the route's own verdict, asserted before each sync.

import { describe, it, expect, vi } from "vitest"

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from "../events/route"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"
const UPSTREAM = "proj-up-luke"
const DOWNSTREAM = "proj-down-luke"
const LUK = "file-up-luk"
const MRK = "file-up-mrk"
const CELL = "LUK 1:1"
const CELL_2 = "LUK 1:2"

let clock = 0

interface PostedEvent {
  id: string
  kind: string
  /** Defaults to LUK. */
  fileId?: string
  cellId?: string
  parentId: string | null
  payload: Record<string, unknown>
}

/** POST one batch (all on one file) to the upstream through the live route.
 *  Returns the ids the route reported stale. */
async function post(t: TestDb, ...events: PostedEvent[]): Promise<string[]> {
  const fileId = events[0]?.fileId ?? LUK
  // Maintainer: removing an imported cell needs it, and the race is the point.
  const token = await makeTestToken(SECRET, { projectId: UPSTREAM, fileId, role: 600 })
  const body = events.map((e) => {
    clock += 1
    return {
      id: e.id,
      schemaVersion: 1,
      kind: e.kind,
      projectId: UPSTREAM,
      fileId,
      cellId: e.cellId ?? null,
      parentId: e.parentId,
      author: "alice",
      payload: e.payload,
      clientTs: clock,
    }
  })
  const res = await handleEventsWriteRequest(
    new Request("https://worker/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: body }),
    }),
    { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res?.status).toBe(200)
  const json = (await res!.json()) as { accepted: { id: string }[]; stale: { id: string }[] }
  expect(json.accepted.map((a) => a.id)).toEqual(events.map((e) => e.id))
  return json.stale.map((s) => s.id)
}

const create = (id: string, value: string, cellId = CELL): PostedEvent => ({
  id, kind: "source.cell.create", cellId, parentId: null, payload: { cellId, value },
})
const commit = (id: string, parentId: string | null, value: string, cellId = CELL): PostedEvent => ({
  id, kind: "source.cell.commit", cellId, parentId, payload: { value },
})

async function setUp(consumes: "source" | "target" = "source", gate: "head" | "validated" = "validated"): Promise<TestDb> {
  const t = await makeTestDb()
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode,
                           source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', $3, $4, 0)`,
    [DOWNSTREAM, UPSTREAM, consumes, gate],
  )
  await post(t, { id: "evt-file", kind: "file.create", parentId: null, payload: { name: "LUK.usfm", fileType: "codex" } })
  return t
}

/** The upstream's projected text for a cell — what its own editor shows. */
async function upstreamText(t: TestDb, side: "source" | "target", cellId = CELL): Promise<string | null> {
  const r = await t.pg.query<{ value: string }>(
    `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = $4
       AND lane_id = (
         SELECT id FROM lanes WHERE project_id = $1 AND role = $4
           AND legacy_tag IS NOT DISTINCT FROM CASE WHEN $4 = 'source' THEN NULL ELSE '' END
       )`,
    [UPSTREAM, LUK, cellId, side],
  )
  return r.rows[0]?.value ?? null
}

/** The downstream's mirrored source row for a cell. */
async function downstreamRow(t: TestDb, cellId = CELL): Promise<{ value: string; tombstoned: boolean } | null> {
  const r = await t.pg.query<{ value: string; tombstoned_at: string | null }>(
    `SELECT value, tombstoned_at FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [DOWNSTREAM, deterministicDownstreamFileId(DOWNSTREAM, LUK), cellId],
  )
  const row = r.rows[0]
  return row ? { value: row.value, tombstoned: row.tombstoned_at != null } : null
}

describe("mirrorSync — an upstream edit that lost the head compare-and-swap (AQU-1574)", () => {
  // WHY: the report, verbatim. The commit names no parent, so it lost to the
  // cell's create; the upstream still reads "first draft" and so must the copy.
  it("keeps the create's text when a parent-less commit lost to it in the same window", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      expect(await post(t, commit("evt-stale", null, "Forasmuch as many have taken in hand"))).toEqual(["evt-stale"])
      expect(await upstreamText(t, "source")).toBe("Luke 1:1 first draft")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Luke 1:1 first draft", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: the everyday shape of the race. The cell arrived in an earlier sync,
  // so this window holds only the two siblings, and the fold has to know the
  // cell's head from BEFORE the window to tell which of them won.
  it("mirrors the winner, not a later stale sibling, for a cell an earlier sync brought in", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await mirrorSync(t.db, DOWNSTREAM)

      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(await post(t, commit("evt-b1", "evt-create", "Since many have undertaken"))).toEqual(["evt-b1"])
      expect(await upstreamText(t, "source")).toBe("Forasmuch as many have taken in hand")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: the losing editor's client keeps chaining on its own stale head. B2
  // holds the free (cell, B1) claim slot, so only the head check rejects it —
  // a fold that checked "first child of its parent" would still take it.
  it("skips a branch chained on a stale sibling", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await mirrorSync(t.db, DOWNSTREAM)

      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(await post(t, commit("evt-b1", "evt-create", "Since many have undertaken"))).toEqual(["evt-b1"])
      expect(await post(t, commit("evt-b2", "evt-b1", "Since many have undertaken to compile"))).toEqual(["evt-b2"])
      expect(await upstreamText(t, "source")).toBe("Forasmuch as many have taken in hand")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: a delete is chain-arbitrated too. One editor removed the line while
  // another had already edited it; the upstream kept the cell, so the copy must
  // not become a tombstone (which drops it from counts, progress and exports).
  it("leaves the cell live when a delete lost to an edit", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await mirrorSync(t.db, DOWNSTREAM)

      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(
        await post(t, { id: "evt-del", kind: "source.cell.delete", cellId: CELL, parentId: "evt-create", payload: {} }),
      ).toEqual(["evt-del"])
      expect(await upstreamText(t, "source")).toBe("Forasmuch as many have taken in hand")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: AQU-1567 looks ahead to the run's head before bringing a cell in for
  // the first time, so a cell created and deleted across two windows ends with
  // no row. A delete the upstream rejected must not count there either, or the
  // cell is held back by the look-ahead and then never arrives at all.
  it("brings a cell in across windows when a later delete of it lost", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(
        await post(t, { id: "evt-del", kind: "source.cell.delete", cellId: CELL, parentId: "evt-create", payload: {} }),
      ).toEqual(["evt-del"])

      await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1 })

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: a reorder moves the cell's head but is not one of the kinds the fold
  // mirrors. The next edit chains on the reorder, and it is the winner — a fold
  // that only tracked the kinds it reads would call it stale and drop it.
  it("still mirrors an edit chained on a reorder", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"), create("evt-create-2", "Luke 1:2", CELL_2))
      await mirrorSync(t.db, DOWNSTREAM)

      await post(t, { id: "evt-reorder", kind: "source.cell.reorder", cellId: CELL, parentId: "evt-create", payload: { anchorCellId: CELL_2 } })
      await post(t, commit("evt-a1", "evt-reorder", "Forasmuch as many have taken in hand"))
      expect(await upstreamText(t, "source")).toBe("Forasmuch as many have taken in hand")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  // WHY: a new link's first sync replays the upstream's whole history in
  // windows (AQU-1563). Where a window boundary falls must not change which
  // sibling won.
  it("folds the same race the same way one event per window", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(await post(t, commit("evt-b1", "evt-create", "Since many have undertaken"))).toEqual(["evt-b1"])
      expect(await post(t, commit("evt-b2", "evt-b1", "Since many have undertaken to compile"))).toEqual(["evt-b2"])

      await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1 })

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — a file added to the link later (AQU-1560 backfill, AQU-1574)", () => {
  // WHY: a file added to an existing link arrives by replaying its history
  // from the start (runBackfill), through the same fold — so a race settled
  // long before the file was added must come out the way the upstream settled it.
  it("replays the winner of a race that settled before the file was added", async () => {
    const t = await setUp()
    try {
      await post(t, create("evt-create", "Luke 1:1 first draft"))
      await post(t, commit("evt-a1", "evt-create", "Forasmuch as many have taken in hand"))
      expect(await post(t, commit("evt-b1", "evt-create", "Since many have undertaken"))).toEqual(["evt-b1"])
      await post(t, { id: "evt-file-mrk", kind: "file.create", fileId: MRK, parentId: null, payload: { name: "MRK.usfm", fileType: "codex" } })
      await post(t, { ...create("evt-create-mrk", "The beginning of the gospel", "MRK 1:1"), fileId: MRK })
      // The link follows Mark only, and is caught up.
      await t.pg.query(`UPDATE projects SET source_link_file_ids = $2 WHERE id = $1`, [DOWNSTREAM, JSON.stringify([MRK])])
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamRow(t)).toBeNull()

      // What POST /link-source/files records, before it syncs.
      await t.pg.query(`UPDATE projects SET source_link_backfill = $2 WHERE id = $1`, [
        DOWNSTREAM,
        JSON.stringify({ fileIds: [LUK], doneSeq: 0 }),
      ])
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Forasmuch as many have taken in hand", tombstoned: false })
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync consumes=target, gate head — a translation that lost the race (AQU-1574)", () => {
  const translate = (id: string, parentId: string, value: string): PostedEvent => ({
    id, kind: "target.cell.commit", cellId: CELL, parentId, payload: { value, sourceEventId: "evt-create" },
  })

  // WHY: the same defect one lane over. A chain link whose gate is `head`
  // mirrors the upstream's current translation as it lands; a losing
  // translator's text is not the upstream's current translation.
  it("mirrors the winning translation, not a later stale sibling", async () => {
    const t = await setUp("target", "head")
    try {
      await post(t, create("evt-create", "Luke 1:1"))
      await post(t, translate("evt-t1", "evt-create", "Comme plusieurs ont entrepris"))
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamRow(t)).toEqual({ value: "Comme plusieurs ont entrepris", tombstoned: false })

      await post(t, translate("evt-t2", "evt-t1", "Plusieurs ayant entrepris"))
      expect(await post(t, translate("evt-t2-stale", "evt-t1", "Puisque beaucoup ont entrepris"))).toEqual(["evt-t2-stale"])
      expect(await upstreamText(t, "target")).toBe("Plusieurs ayant entrepris")

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamRow(t)).toEqual({ value: "Plusieurs ayant entrepris", tombstoned: false })
    } finally {
      await t.close()
    }
  })
})
