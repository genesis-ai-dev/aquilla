// FRO-476: source.cell.mirror / file.mirror projection tests.
//
// WHY: mirror events are the propagation primitive for live source links.
// The rules that must hold, byte-for-byte, per the design spec §4/§5:
//   1. UPSERT (not UPDATE-only) — a mirror routinely hits a cell with no
//      local row yet (new upstream cell post-seed).
//   2. Monotonic apply-guard: applied only when payload.upstream.seq >
//      cells.upstream_seq — a stale/out-of-order mirror is a silent no-op,
//      never a stomp.
//   3. Tombstone: `deleted: true` sets tombstoned_at, never deletes the row.
//   4. Not chain-mutating: mirror events don't need/use chain_claims.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, contentHash, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import type { EventPayloads } from "../events/types"

const PROJECT = "proj-mirror"
const FILE = "file-a"
let _seq = 0

function mirrorEvent(
  cellId: string,
  payload: Partial<EventPayloads["source.cell.mirror"]> & { upstream: EventPayloads["source.cell.mirror"]["upstream"] },
): PersistedEvent<"source.cell.mirror"> {
  _seq += 1
  return {
    id: `mirror-evt-${_seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.mirror",
    author: "link-sync",
    payload: { value: "", ...payload },
    clientTs: 1000 + _seq,
    serverTs: 1000 + _seq,
    serverSeq: _seq,
  }
}

async function apply(t: TestDb, event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  for (let i = 0; i < stmts.length; i += 100) {
    await t.db.batch(stmts.slice(i, i + 100))
  }
}

async function fileCreate(t: TestDb): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(
    t.db,
    {
      id: "file-create-1",
      schemaVersion: 1,
      projectId: PROJECT,
      fileId: FILE,
      cellId: null,
      parentId: null,
      kind: "file.create",
      author: "link-sync",
      payload: { name: "Genesis", fileType: "codex" },
      clientTs: 1,
      serverTs: 1,
      serverSeq: 1,
    },
    stmts,
  )
  await t.db.batch(stmts)
}

describe("source.cell.mirror projection", () => {
  it("UPSERTs a brand-new cell with no local row yet", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "In the beginning",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-1", seq: 10, side: "source", contentHash: contentHash("In the beginning") },
        }),
      )
      const rows = await t.rows<Record<string, unknown>>("cells")
      const row = rows.find((r) => r.cell_id === "cell-1" && r.side === "source")
      expect(row?.value).toBe("In the beginning")
      expect(row?.upstream_event_id).toBe("up-evt-1")
      expect(Number(row?.upstream_seq)).toBe(10)
      expect(row?.tombstoned_at).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("UPSERTs (updates) an existing mirrored cell when upstream.seq advances", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "v1",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-1", seq: 10, side: "source", contentHash: contentHash("v1") },
        }),
      )
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "v2 (fixed)",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-2", seq: 20, side: "source", contentHash: contentHash("v2 (fixed)") },
        }),
      )
      const rows = await t.rows<Record<string, unknown>>("cells")
      const row = rows.find((r) => r.cell_id === "cell-1" && r.side === "source")
      expect(row?.value).toBe("v2 (fixed)")
      expect(row?.upstream_event_id).toBe("up-evt-2")
      expect(Number(row?.upstream_seq)).toBe(20)
    } finally {
      await t.close()
    }
  })

  it("monotonic guard: an older/stale mirror (lower upstream.seq) is a silent no-op", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "current head",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-20", seq: 20, side: "source", contentHash: contentHash("current head") },
        }),
      )
      // Simulate a stale/out-of-order replay landing after a newer one.
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "stale older content",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-10", seq: 10, side: "source", contentHash: contentHash("stale older content") },
        }),
      )
      const rows = await t.rows<Record<string, unknown>>("cells")
      const row = rows.find((r) => r.cell_id === "cell-1" && r.side === "source")
      // The row must still reflect the NEWER (seq 20) mirror — the older
      // one's INSERT...ON CONFLICT...WHERE guard suppressed the update.
      expect(row?.value).toBe("current head")
      expect(row?.upstream_event_id).toBe("up-evt-20")
      expect(Number(row?.upstream_seq)).toBe(20)
    } finally {
      await t.close()
    }
  })

  it("tombstone: deleted:true stamps tombstoned_at and does NOT delete the row", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "will be deleted upstream",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-1", seq: 10, side: "source", contentHash: contentHash("will be deleted upstream") },
        }),
      )
      await apply(
        t,
        mirrorEvent("cell-1", {
          deleted: true,
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-2", seq: 20, side: "source", contentHash: contentHash("") },
        }),
      )
      const rows = await t.rows<Record<string, unknown>>("cells")
      const row = rows.find((r) => r.cell_id === "cell-1" && r.side === "source")
      expect(row).toBeTruthy()
      expect(row?.tombstoned_at).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it("is exempt from chain_claims — no claim row is required or created", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await apply(
        t,
        mirrorEvent("cell-1", {
          value: "x",
          upstream: { projectId: "upstream-proj", cellId: "cell-1", eventId: "up-evt-1", seq: 1, side: "source", contentHash: contentHash("x") },
        }),
      )
      const claims = await t.rows<Record<string, unknown>>("chain_claims")
      expect(claims.filter((c) => c.cell_id === "cell-1")).toHaveLength(0)
      const rows = await t.rows<Record<string, unknown>>("cells")
      const row = rows.find((r) => r.cell_id === "cell-1" && r.side === "source")
      expect(row?.value).toBe("x")
    } finally {
      await t.close()
    }
  })
})

describe("file.mirror projection", () => {
  it("upserts a files row for an upstream file created post-seed", async () => {
    const t = await makeTestDb()
    try {
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(
        t.db,
        {
          id: "file-mirror-1",
          schemaVersion: 1,
          projectId: PROJECT,
          fileId: "new-file-b",
          cellId: null,
          parentId: null,
          kind: "file.mirror",
          author: "link-sync",
          payload: { fileId: "new-file-b", name: "Exodus", upstream: { projectId: "upstream-proj", eventId: "new-file-b", seq: 5 } },
          clientTs: 1,
          serverTs: 1,
          serverSeq: 1,
        },
        stmts,
      )
      await t.db.batch(stmts)
      const files = await t.rows<Record<string, unknown>>("files")
      const row = files.find((f) => f.id === "new-file-b")
      expect(row?.name).toBe("Exodus")
    } finally {
      await t.close()
    }
  })
})
