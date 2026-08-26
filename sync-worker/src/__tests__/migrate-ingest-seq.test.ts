// AQU-1005: migrate-ingest pre-allocates the whole batch's server_seqs in ONE
// counter bump instead of running the bump CTE inside every event INSERT —
// the old shape held the per-project seq-counter row lock for the entire
// pipelined transaction, queueing live editors behind bulk ingest for minutes.
// These tests pin the contracts the swap must preserve: per-project seqs stay
// unique and strictly above every pre-existing event, id-replays are dropped
// without duplicating rows, and the projection still lands.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { handleMigrateIngestRequest } from "../events/migrate-ingest-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const PROJECT = "proj-mig"
const FILE = "file-mig"

let t: TestDb
beforeAll(async () => {
  t = await makeTestDb()
}, 120_000)
afterAll(async () => {
  await t.close()
})
beforeEach(async () => {
  await t.reset()
})

function env() {
  return { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }
}

interface IngestEventIn {
  id: string
  kind: string
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: unknown
}

function ingestRequest(events: IngestEventIn[], opts: { eventsOnly?: boolean } = {}): Request {
  return new Request("https://sync.test/migrate/ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, events, ...opts }),
  })
}

function cellCreate(id: string, cellId: string, value: string): IngestEventIn {
  return {
    id,
    kind: "source.cell.create",
    fileId: FILE,
    cellId,
    parentId: null,
    author: "legacy-user",
    clientTs: 1600000000000,
    payload: { cellId, value },
  }
}

async function eventSeqs(): Promise<Array<{ id: string; server_seq: number }>> {
  const r = await t.pg.query<{ id: string; server_seq: number }>(
    "SELECT id, server_seq FROM events WHERE project_id=$1 ORDER BY server_seq",
    [PROJECT],
  )
  return r.rows
}

describe("migrate-ingest seq pre-allocation (AQU-1005)", () => {
  it("assigns unique ascending seqs from one allocated block (eventsOnly firehose)", async () => {
    const events = ["e1", "e2", "e3", "e4", "e5"].map((id, i) => cellCreate(id, `c${i}`, `v${i}`))
    const res = await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({ accepted: 5 })

    const rows = await eventSeqs()
    expect(rows.map((r) => r.id)).toEqual(["e1", "e2", "e3", "e4", "e5"])
    const seqs = rows.map((r) => Number(r.server_seq))
    expect(new Set(seqs).size).toBe(5)
    // Contiguous block in request order — the allocator hands out base..base+4.
    expect(seqs).toEqual([seqs[0], seqs[0] + 1, seqs[0] + 2, seqs[0] + 3, seqs[0] + 4])
  })

  it("replaying a batch drops duplicate ids without disturbing existing rows", async () => {
    const events = ["r1", "r2", "r3"].map((id, i) => cellCreate(id, `c${i}`, `v${i}`))
    await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    const before = await eventSeqs()

    const replay = await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    expect(replay?.status).toBe(200)

    const after = await eventSeqs()
    // Same 3 rows, same seqs — the replay consumed a fresh block (harmless
    // gap; seq is an ordering key, not a count) and inserted nothing.
    expect(after).toEqual(before)
  })

  it("allocates strictly above pre-existing events when the counter is unseeded", async () => {
    // Simulate rows written before the counter existed (e.g. a pre-allocator
    // deploy): event at seq 100 with NO project_seq_counters row.
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
                           author, payload, client_ts, server_ts, server_seq)
       VALUES ('old-1', 1, $1, $2, 'c-old', NULL, 'source.cell.create',
               'legacy-user', '{}', 1, 1, 100)`,
      [PROJECT, FILE],
    )

    await handleMigrateIngestRequest(
      ingestRequest([cellCreate("n1", "c-new", "new")], { eventsOnly: true }),
      env(),
    )
    const rows = await eventSeqs()
    const n1 = rows.find((r) => r.id === "n1")!
    expect(Number(n1.server_seq)).toBeGreaterThan(100)
  })

  it("non-eventsOnly still projects cells alongside the event rows", async () => {
    const events: IngestEventIn[] = [
      {
        id: "f1",
        kind: "file.create",
        fileId: FILE,
        cellId: null,
        parentId: null,
        author: "legacy-user",
        clientTs: 1600000000000,
        payload: { name: "GEN", fileType: "codex" },
      },
      cellCreate("s1", "cell-1", "In the beginning"),
    ]
    const res = await handleMigrateIngestRequest(ingestRequest(events), env())
    expect(res?.status).toBe(200)

    const cell = await t.pg.query(
      "SELECT value FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id='cell-1' AND side='source'",
      [PROJECT, FILE],
    )
    expect(cell.rows).toHaveLength(1)
    expect((cell.rows[0] as { value: string }).value).toBe("In the beginning")
    expect((await eventSeqs()).map((r) => r.id)).toEqual(["f1", "s1"])
  })
})
