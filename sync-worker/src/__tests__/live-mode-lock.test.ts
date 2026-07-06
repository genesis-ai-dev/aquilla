// FRO-476: live-mode lock tests — reject local `source.cell.commit` on cells
// mirrored from a live-linked upstream (upstream_event_id set); downstream-
// added cells (no upstream_event_id) stay editable.

import { describe, it, expect } from "vitest"
import { vi } from "vitest"

vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from "../events/route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret"
const PROJECT = "proj-downstream"
const FILE = "file-x"

interface EventsResponse {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
}

async function postEvents(db: AquillaDb, events: RawEvent[], role = 500): Promise<EventsResponse> {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role })
  const req = new Request("https://worker/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  const res = await handleEventsWriteRequest(req, { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return (await res!.json()) as EventsResponse
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-${_seq}`
}

async function apply(t: TestDb, event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

describe("live-mode lock", () => {
  it("rejects a local source.cell.commit on a cell mirrored from a live upstream", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode) VALUES ($1, 'B', 1, 'proj-up', 'live')`,
        [PROJECT],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      // Mirrored source cell — has upstream_event_id set.
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "source.cell.mirror", author: "link-sync",
        payload: { value: "mirrored text", upstream: { projectId: "proj-up", cellId: "cell-1", eventId: "up-1", seq: 1, side: "source", contentHash: "x" } },
        clientTs: 1, serverTs: 1, serverSeq: 2,
      })

      const result = await postEvents(t.db, [
        {
          id: nextId(), schemaVersion: 1, kind: "source.cell.commit", projectId: PROJECT, fileId: FILE, cellId: "cell-1",
          parentId: null, author: "alice", payload: { value: "local edit attempt" }, clientTs: 1000,
        },
      ])

      expect(result.accepted).toHaveLength(0)
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.status).toBe(409)

      // The cell's content is unchanged — the local edit never landed.
      const row = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [PROJECT, FILE, "cell-1"],
      )
      expect(row.rows[0]?.value).toBe("mirrored text")
    } finally {
      await t.close()
    }
  })

  it("allows a local source.cell.commit on a downstream-added cell (no upstream_event_id)", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode) VALUES ($1, 'B', 1, 'proj-up', 'live')`,
        [PROJECT],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      // Downstream-added cell — genesis via source.cell.create (a project
      // lead editing locally), never mirrored.
      const genesisId = nextId()
      await apply(t, {
        id: genesisId, schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-2", parentId: null,
        kind: "source.cell.create", author: "alice", payload: { cellId: "cell-2", value: "own content" }, clientTs: 1, serverTs: 1, serverSeq: 2,
      })

      const result = await postEvents(t.db, [
        {
          id: nextId(), schemaVersion: 1, kind: "source.cell.commit", projectId: PROJECT, fileId: FILE, cellId: "cell-2",
          parentId: genesisId, author: "alice", payload: { value: "edited locally" }, clientTs: 1000,
        },
      ])

      expect(result.rejected).toHaveLength(0)
      expect(result.accepted).toHaveLength(1)

      const row = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [PROJECT, FILE, "cell-2"],
      )
      expect(row.rows[0]?.value).toBe("edited locally")
    } finally {
      await t.close()
    }
  })

  it("does NOT reject source.cell.commit for a clone-mode link", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode) VALUES ($1, 'B', 1, 'proj-up', 'clone')`,
        [PROJECT],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      // A row that (hypothetically) still carries upstream_event_id from a
      // prior live link, now detached to clone — must NOT be locked.
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "source.cell.mirror", author: "link-sync",
        payload: { value: "mirrored text", upstream: { projectId: "proj-up", cellId: "cell-1", eventId: "up-1", seq: 1, side: "source", contentHash: "x" } },
        clientTs: 1, serverTs: 1, serverSeq: 2,
      })

      const result = await postEvents(t.db, [
        {
          id: nextId(), schemaVersion: 1, kind: "source.cell.commit", projectId: PROJECT, fileId: FILE, cellId: "cell-1",
          parentId: null, author: "alice", payload: { value: "edited after clone" }, clientTs: 1000,
        },
      ])
      expect(result.rejected).toHaveLength(0)
      expect(result.accepted).toHaveLength(1)
    } finally {
      await t.close()
    }
  })
})
