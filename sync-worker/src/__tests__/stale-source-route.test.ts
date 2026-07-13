// AQU-476: stale-source route extension tests.
//
// Covers the acceptance criteria:
//   - tombstoned cells surface in tombstonedCellIds, target rows stay visible
//   - clone-mode links show ZERO stale flags no matter how much upstream drifts
//   - behindSeq is non-null exactly when there are unmirrored lane-relevant
//     upstream changes (not for comments/audio alone)

import { describe, it, expect } from "vitest"
import { handleStaleSourceRequest } from "../events/stale-source-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"
const PROJECT = "proj-b"
const FILE = "file-x"

async function makeToken(role = 100): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role })
}

async function apply(t: TestDb, event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-${_seq}`
}

async function request(t: TestDb, projectId: string, fileId: string, token: string) {
  const req = new Request(
    `https://sync.test/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/stale-source`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = await handleStaleSourceRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return res as Response
}

describe("stale-source route — tombstoned cells", () => {
  it("surfaces upstream-deleted cells in tombstonedCellIds; the target row stays visible", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'B', 1)`, [PROJECT])
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "source.cell.create", author: "importer", payload: { cellId: "cell-1", value: "v1" }, clientTs: 1, serverTs: 1, serverSeq: 2,
      })
      const targetEvt = { id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "target.cell.commit" as const, author: "translator", payload: { value: "t1" }, clientTs: 1, serverTs: 1, serverSeq: 3 }
      await apply(t, targetEvt)
      // Mirror tombstone the source row.
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "source.cell.mirror", author: "link-sync",
        payload: { value: "", deleted: true, upstream: { projectId: "up", cellId: "cell-1", eventId: "up-1", seq: 1, side: "source", contentHash: "x" } },
        clientTs: 1, serverTs: 1, serverSeq: 4,
      })

      const token = await makeToken()
      const res = await request(t, PROJECT, FILE, token)
      const body = await res.json() as { tombstonedCellIds: string[] }
      expect(body.tombstonedCellIds).toContain("cell-1")

      const targetRow = await t.pg.query(
        `SELECT * FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
        [PROJECT, FILE, "cell-1"],
      )
      expect(targetRow.rows).toHaveLength(1) // still visible
    } finally {
      await t.close()
    }
  })
})

describe("stale-source route — clone mode short-circuit", () => {
  it("shows ZERO stale flags for a clone-mode link, regardless of upstream drift", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, ["proj-up"])
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode) VALUES ($1, 'B', 1, $2, 'clone')`,
        [PROJECT, "proj-up"],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "source.cell.create", author: "importer", payload: { cellId: "cell-1", value: "v1" }, clientTs: 1, serverTs: 1, serverSeq: 2,
      })
      // Target pinned to an event that no longer matches — would normally be stale.
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: "cell-1", parentId: null,
        kind: "target.cell.commit", author: "translator", payload: { value: "t1", sourceEventId: "some-old-event" },
        clientTs: 1, serverTs: 1, serverSeq: 3,
      })

      const token = await makeToken()
      const res = await request(t, PROJECT, FILE, token)
      const body = await res.json() as { staleCellIds: string[]; tombstonedCellIds: string[]; behindSeq: unknown }
      expect(body.staleCellIds).toEqual([])
      expect(body.tombstonedCellIds).toEqual([])
      expect(body.behindSeq).toBeNull()
    } finally {
      await t.close()
    }
  })
})

describe("stale-source route — behindSeq lane-relevance", () => {
  it("is null when the live link is caught up", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, ["proj-up"])
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_cursor) VALUES ($1, 'B', 1, $2, 'live', 999999)`,
        [PROJECT, "proj-up"],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      const token = await makeToken()
      const res = await request(t, PROJECT, FILE, token)
      const body = await res.json() as { behindSeq: unknown }
      expect(body.behindSeq).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("is non-null when the upstream has unmirrored lane-relevant changes", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, ["proj-up"])
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_cursor) VALUES ($1, 'B', 1, $2, 'live', 0)`,
        [PROJECT, "proj-up"],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      // Lane-relevant upstream change (source.cell.create), unmirrored (cursor stays 0).
      await t.pg.query(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
         VALUES ($1, 1, $2, $3, 'cell-1', NULL, 'source.cell.create', 'importer', '{"cellId":"cell-1","value":"v1"}', 1, 1, 1)`,
        [nextId(), "proj-up", FILE],
      )
      const token = await makeToken()
      const res = await request(t, PROJECT, FILE, token)
      const body = await res.json() as { behindSeq: { upstream: number; cursor: number } | null }
      expect(body.behindSeq).not.toBeNull()
      expect(body.behindSeq!.upstream).toBeGreaterThan(body.behindSeq!.cursor)
    } finally {
      await t.close()
    }
  })

  it("is null when upstream's only new activity is comments (non-lane-relevant)", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, ["proj-up"])
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_cursor) VALUES ($1, 'B', 1, $2, 'live', 0)`,
        [PROJECT, "proj-up"],
      )
      await apply(t, {
        id: nextId(), schemaVersion: 1, projectId: PROJECT, fileId: FILE, cellId: null, parentId: null,
        kind: "file.create", author: "importer", payload: { name: "F", fileType: "codex" }, clientTs: 1, serverTs: 1, serverSeq: 1,
      })
      // Non-lane-relevant upstream activity: a comment.
      await t.pg.query(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
         VALUES ($1, 1, $2, $3, NULL, NULL, 'comment.create', 'alice', '{}', 1, 1, 1)`,
        [nextId(), "proj-up", FILE],
      )
      const token = await makeToken()
      const res = await request(t, PROJECT, FILE, token)
      const body = await res.json() as { behindSeq: unknown }
      expect(body.behindSeq).toBeNull()
    } finally {
      await t.close()
    }
  })
})
