// AQU-931: source.cell.reanchor projection tests.
//
// WHY: re-migration retractions hard-delete rows that surviving cells' stored
// `anchor_cell_id` still points at (their deterministic creates are INSERT OR
// IGNOREd and never re-project), scrambling the read order. The repair event
// must be surgical, byte-for-byte:
//   1. Updates ONLY cells.anchor_cell_id on the SOURCE row (lane '').
//   2. Does NOT move cells.event_id — the AD-9 staleness comparison (target
//      pin vs source head) reads the head as "content changed", so a repair
//      that advanced it would false-flag every translated cell as stale.
//   3. Non-chain-mutating: rebuild replays it unconditionally, so the repair
//      survives a projection rebuild (a chain-mutating event with parent
//      NULL would lose first-child arbitration to the genesis create).

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { handleRebuildProjectionRequest } from "../events/rebuild"
import { type EventRow } from "./helpers/in-memory-db"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import type { EventPayloads } from "../events/types"

const PROJECT = "proj-reanchor"
const FILE = "file-a"
let _seq = 0

async function apply(t: TestDb, event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  for (let i = 0; i < stmts.length; i += 100) {
    await t.db.batch(stmts.slice(i, i + 100))
  }
}

function nextId(prefix: string): string {
  _seq += 1
  return `${prefix}-${_seq}`
}

async function fileCreate(t: TestDb): Promise<void> {
  await apply(t, {
    id: nextId("file-create"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: null,
    parentId: null,
    kind: "file.create",
    author: "migrate",
    payload: { name: "Genesis", fileType: "codex" },
    clientTs: 1,
    serverTs: 1,
  })
}

async function sourceCreate(
  t: TestDb,
  cellId: string,
  anchorCellId: string | null,
): Promise<string> {
  const id = nextId("source-create")
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.create",
    author: "migrate",
    payload: { cellId, value: `src ${cellId}`, anchorCellId },
    clientTs: 1,
    serverTs: 1,
  })
  return id
}

async function targetCommit(t: TestDb, cellId: string, sourceEventId: string): Promise<string> {
  const id = nextId("target-commit")
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: sourceEventId,
    kind: "target.cell.commit",
    author: "translator",
    payload: { value: `tgt ${cellId}`, sourceEventId },
    clientTs: 2,
    serverTs: 2,
  })
  return id
}

async function reanchor(t: TestDb, cellId: string, anchorCellId: string | null): Promise<void> {
  const payload: EventPayloads["source.cell.reanchor"] = { anchorCellId }
  await apply(t, {
    id: nextId("reanchor"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.reanchor",
    author: "migrate",
    payload,
    clientTs: 3,
    serverTs: 3,
  })
}

async function row(
  t: TestDb,
  cellId: string,
  side: "source" | "target",
): Promise<Record<string, unknown> | undefined> {
  const rows = await t.rows<Record<string, unknown>>("cells")
  return rows.find((r) => r.cell_id === cellId && r.side === side)
}

describe("source.cell.reanchor projection", () => {
  it("updates ONLY anchor_cell_id on the source row; head and staleness pin survive", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v1", "m1")
      const commitEvt = await targetCommit(t, "v1", createEvt)

      await reanchor(t, "v1", null)

      const source = await row(t, "v1", "source")
      expect(source?.anchor_cell_id).toBeNull()
      // The head did NOT move — pin (target.source_event_id) still equals the
      // source row's event_id, so the cell is NOT stale after the repair.
      expect(source?.event_id).toBe(createEvt)
      const target = await row(t, "v1", "target")
      expect(target?.source_event_id).toBe(createEvt)
      expect(target?.event_id).toBe(commitEvt)
      expect(target?.anchor_cell_id ?? null).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("re-points to a concrete anchor and leaves other cells untouched", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1", null)
      await sourceCreate(t, "v2", "gone-cell")

      await reanchor(t, "v2", "v1")

      expect((await row(t, "v2", "source"))?.anchor_cell_id).toBe("v1")
      expect((await row(t, "v1", "source"))?.anchor_cell_id).toBeNull()
    } finally {
      await t.close()
    }
  })
})

describe("source.cell.reanchor rebuild replay", () => {
  function evt(overrides: Partial<EventRow> & Pick<EventRow, "id" | "kind" | "payload">): EventRow {
    return {
      schema_version: 1,
      project_id: PROJECT,
      file_id: FILE,
      cell_id: "v1",
      parent_id: null,
      author: "migrate",
      client_ts: 0,
      server_ts: 0,
      server_seq: 0,
      ...overrides,
    } as EventRow
  }

  it("survives a projection rebuild (non-chain-mutating: not dropped as a stale sibling)", async () => {
    // The AQU-910 shape: m1 (a heading) was migrated, v1 anchored to it, m1
    // was later retracted, and the repair re-anchored v1 to the head. All
    // four events replay in seq order; the reanchor must win even though it
    // shares (cell, parent NULL) with v1's genesis create.
    const { db } = await makeTestDb({
      events: [
        evt({
          id: "evt-m1-create",
          kind: "source.cell.create",
          cell_id: "m1",
          payload: JSON.stringify({ cellId: "m1", value: "1", anchorCellId: null }),
          server_seq: 1,
        }),
        evt({
          id: "evt-v1-create",
          kind: "source.cell.create",
          payload: JSON.stringify({ cellId: "v1", value: "In the beginning", anchorCellId: "m1" }),
          server_seq: 2,
        }),
        evt({
          id: "evt-m1-delete",
          kind: "source.cell.delete",
          cell_id: "m1",
          payload: JSON.stringify({}),
          server_seq: 3,
        }),
        evt({
          id: "evt-v1-reanchor",
          kind: "source.cell.reanchor",
          payload: JSON.stringify({ anchorCellId: null }),
          server_seq: 4,
        }),
      ],
    })
    const res = (await handleRebuildProjectionRequest(
      new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
        method: "POST",
        headers: { Authorization: "Bearer shared-secret" },
      }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: "shared-secret" },
    )) as Response
    expect(res.status).toBe(200)

    const rows = await db
      .prepare("SELECT cell_id, side, anchor_cell_id, event_id FROM cells WHERE project_id = ?")
      .bind(PROJECT)
      .all<{ cell_id: string; side: string; anchor_cell_id: string | null; event_id: string }>()
    const cells = rows.results ?? []
    // m1 stays retracted; v1's repaired anchor survives the replay with its
    // original head intact.
    expect(cells.some((r) => r.cell_id === "m1")).toBe(false)
    const v1 = cells.find((r) => r.cell_id === "v1" && r.side === "source")
    expect(v1?.anchor_cell_id).toBeNull()
    expect(v1?.event_id).toBe("evt-v1-create")
  })
})
