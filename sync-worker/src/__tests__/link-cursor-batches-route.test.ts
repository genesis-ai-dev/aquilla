// AQU-478: GET /api/v1/projects/:projectId/link/cursor-batches tests.
//
// `link.cursor.advance` is project-level (fileId/cellId both NULL) so
// neither `read-route.ts` (requires fileId) nor `cell-history-read-route.ts`
// (requires fileId+cellId) can retrieve it — this route is the small read
// extension the design spec anticipated (§9.5) for the review panel.

import { describe, it, expect } from "vitest"
import { handleLinkCursorBatchesRequest } from "../events/link-cursor-batches-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"
const PROJECT = "proj-downstream"

async function makeToken(role = 100): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: "any-file", role })
}

async function insertEvent(
  t: TestDb,
  row: {
    id: string
    kind: string
    fileId: string | null
    cellId: string | null
    payload: unknown
    serverSeq: number
    serverTs?: number
  },
): Promise<void> {
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, 'link-sync', $6, $7, $7, NULL, $8)`,
    [
      row.id,
      PROJECT,
      row.fileId,
      row.cellId,
      row.kind,
      JSON.stringify(row.payload),
      row.serverTs ?? row.serverSeq,
      row.serverSeq,
    ],
  )
}

async function request(t: TestDb, token: string, qs = "") {
  const req = new Request(
    `https://sync.test/api/v1/projects/${encodeURIComponent(PROJECT)}/link/cursor-batches${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = await handleLinkCursorBatchesRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return res as Response
}

describe("GET /link/cursor-batches", () => {
  it("returns [] when the project has no mirror-sync history", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'D', 1)`, [PROJECT])
      const res = await request(t, await makeToken())
      const body = (await res.json()) as { batches: unknown[] }
      expect(body.batches).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("groups mirror events by batch, associating each batch's events by the server_seq window between cursor-advance records", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'D', 1)`, [PROJECT])

      // Batch 1: two source.cell.mirror events (seq 1,2), then its
      // link.cursor.advance at seq 3.
      await insertEvent(t, {
        id: "mirror-1", kind: "source.cell.mirror", fileId: "file-a", cellId: "cell-1",
        payload: { value: "v1", upstream: { projectId: "up", cellId: "cell-1", eventId: "up-1", seq: 10, side: "source", contentHash: "h1" } },
        serverSeq: 1,
      })
      await insertEvent(t, {
        id: "mirror-2", kind: "source.cell.mirror", fileId: "file-a", cellId: "cell-2",
        payload: { value: "v2", upstream: { projectId: "up", cellId: "cell-2", eventId: "up-2", seq: 11, side: "source", contentHash: "h2" } },
        serverSeq: 2,
      })
      await insertEvent(t, {
        id: "batch-1", kind: "link.cursor.advance", fileId: null, cellId: null,
        payload: { upstreamProjectId: "up", fromSeq: 0, toSeq: 11, cellCount: 2 },
        serverSeq: 3, serverTs: 1000,
      })

      // Batch 2: one source.cell.mirror event (seq 4), then its
      // link.cursor.advance at seq 5.
      await insertEvent(t, {
        id: "mirror-3", kind: "source.cell.mirror", fileId: "file-a", cellId: "cell-1",
        payload: { value: "v1 (fixed)", upstream: { projectId: "up", cellId: "cell-1", eventId: "up-3", seq: 20, side: "source", contentHash: "h3" } },
        serverSeq: 4,
      })
      await insertEvent(t, {
        id: "batch-2", kind: "link.cursor.advance", fileId: null, cellId: null,
        payload: { upstreamProjectId: "up", fromSeq: 11, toSeq: 20, cellCount: 1 },
        serverSeq: 5, serverTs: 2000,
      })

      const res = await request(t, await makeToken())
      const body = (await res.json()) as { batches: Array<{ batchId: string; fromSeq: number; toSeq: number; cellCount: number; events: Array<{ id: string }> }> }

      expect(body.batches).toHaveLength(2)
      // Newest-first.
      expect(body.batches[0]!.batchId).toBe("batch-2")
      expect(body.batches[0]!.fromSeq).toBe(11)
      expect(body.batches[0]!.toSeq).toBe(20)
      expect(body.batches[0]!.cellCount).toBe(1)
      expect(body.batches[0]!.events.map((e) => e.id)).toEqual(["mirror-3"])

      expect(body.batches[1]!.batchId).toBe("batch-1")
      expect(body.batches[1]!.events.map((e) => e.id)).toEqual(["mirror-1", "mirror-2"])
    } finally {
      await t.close()
    }
  })

  it("requires a project-scoped token (401 without Authorization)", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'D', 1)`, [PROJECT])
      const req = new Request(
        `https://sync.test/api/v1/projects/${encodeURIComponent(PROJECT)}/link/cursor-batches`,
      )
      const res = await handleLinkCursorBatchesRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
      expect(res?.status).toBe(401)
    } finally {
      await t.close()
    }
  })

  it("returns null for a non-matching path (chainable in the fetch dispatcher)", async () => {
    const t = await makeTestDb()
    try {
      const req = new Request("https://sync.test/api/v1/projects/x/other")
      const res = await handleLinkCursorBatchesRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
      expect(res).toBeNull()
    } finally {
      await t.close()
    }
  })
})
