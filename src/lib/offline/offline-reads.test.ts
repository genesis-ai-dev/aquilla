import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { events, schema } from "./schema"
import { isProjectOfflineReady, readOfflineFileCells, subscribeToOfflineFileCells } from "./offline-reads"

let store: Store<typeof schema>

let seq = 0

beforeEach(async () => {
  store = await createStorePromise({ schema, storeId: `test-${++seq}`, adapter: makeInMemoryAdapter() })
})

describe("isProjectOfflineReady", () => {
  it("is false when the project has no offline row", () => {
    expect(isProjectOfflineReady(store, "proj1")).toBe(false)
  })

  it("is true only when status is 'ready'", () => {
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "downloading", syncedAt: null, queueDepth: 0 }),
    )
    expect(isProjectOfflineReady(store, "proj1")).toBe(false)

    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    expect(isProjectOfflineReady(store, "proj1")).toBe(true)
  })
})

function seedCell(args: {
  fileId: string
  cellId: string
  side: "source" | "target"
  value: string
  sequenceIndex: number
  projectId?: string
  eventId?: string | null
  sourceEventId?: string | null
  validated?: boolean
  aiDrafted?: boolean
  canonicalRef?: string | null
  valueHtml?: string | null
}) {
  store.commit(
    events.cellSynced({
      projectId: args.projectId ?? "proj1",
      fileId: args.fileId,
      cellId: args.cellId,
      side: args.side,
      value: args.value,
      valueHtml: args.valueHtml ?? null,
      eventId: "eventId" in args ? args.eventId ?? null : `${args.cellId}-${args.side}-ev`,
      sourceEventId: args.sourceEventId ?? null,
      validated: args.validated ?? false,
      aiDrafted: args.aiDrafted ?? false,
      sequenceIndex: args.sequenceIndex,
      canonicalRef: args.canonicalRef ?? null,
    }),
  )
}

describe("readOfflineFileCells", () => {
  it("returns an empty array when the file has no rows", () => {
    expect(readOfflineFileCells(store, "proj1", "file1")).toEqual([])
  })

  it("orders combined reads as every source row (by sequenceIndex) then every target row (by sequenceIndex)", () => {
    seedCell({ fileId: "file1", cellId: "c2", side: "source", value: "src2", sequenceIndex: 1 })
    seedCell({ fileId: "file1", cellId: "c1", side: "source", value: "src1", sequenceIndex: 0 })
    seedCell({ fileId: "file1", cellId: "c1", side: "target", value: "tgt1", sequenceIndex: 0 })
    seedCell({ fileId: "file1", cellId: "c2", side: "target", value: "tgt2", sequenceIndex: 1 })

    const rows = readOfflineFileCells(store, "proj1", "file1")
    expect(rows.map((r) => `${r.side}:${r.cellId}`)).toEqual(["source:c1", "source:c2", "target:c1", "target:c2"])
  })

  it("filters by side when opts.side is given, sorted by sequenceIndex", () => {
    seedCell({ fileId: "file1", cellId: "c2", side: "target", value: "tgt2", sequenceIndex: 1 })
    seedCell({ fileId: "file1", cellId: "c1", side: "target", value: "tgt1", sequenceIndex: 0 })
    seedCell({ fileId: "file1", cellId: "c1", side: "source", value: "src1", sequenceIndex: 0 })

    const targets = readOfflineFileCells(store, "proj1", "file1", { side: "target" })
    expect(targets.map((r) => r.cellId)).toEqual(["c1", "c2"])
    expect(targets.every((r) => r.side === "target")).toBe(true)
  })

  it("scopes to the given projectId and fileId only", () => {
    seedCell({ fileId: "file1", cellId: "c1", side: "source", value: "in-file", sequenceIndex: 0 })
    seedCell({ fileId: "file2", cellId: "c9", side: "source", value: "other-file", sequenceIndex: 0 })
    seedCell({ projectId: "proj2", fileId: "file1", cellId: "c1", side: "source", value: "other-project", sequenceIndex: 0 })

    const rows = readOfflineFileCells(store, "proj1", "file1")
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe("in-file")
  })

  it("maps LiveStore-backed fields and leaves unsupported CellRow fields as safe defaults", () => {
    seedCell({
      fileId: "file1",
      cellId: "c1",
      side: "target",
      value: "hello",
      valueHtml: "<p>hello</p>",
      sequenceIndex: 0,
      eventId: "ev-1",
      sourceEventId: "src-ev-1",
      validated: true,
      aiDrafted: true,
      canonicalRef: "GEN 1:1",
    })

    const [row] = readOfflineFileCells(store, "proj1", "file1")
    expect(row).toMatchObject({
      cellId: "c1",
      side: "target",
      value: "hello",
      valueHtml: "<p>hello</p>",
      eventId: "ev-1",
      sourceEventId: "src-ev-1",
      validated: true,
      aiDrafted: true,
      sequenceIndex: 0,
      canonicalRef: "GEN 1:1",
      type: null,
      anchorCellId: null,
      lastEditor: null,
      lastEditAt: 0,
      wordCount: 0,
    })
    expect(row.aiDraft).toBeUndefined()
    expect(row.endorsementCount).toBeUndefined()
    expect(row.metadata).toBeUndefined()
  })

  it("falls back to '' / null for a row synced before it had a value or event", () => {
    seedCell({ fileId: "file1", cellId: "c1", side: "source", value: "", sequenceIndex: 0, eventId: null })
    const [row] = readOfflineFileCells(store, "proj1", "file1")
    expect(row.value).toBe("")
    expect(row.eventId).toBe("")
  })
})

describe("subscribeToOfflineFileCells", () => {
  it("fires when a matching row is inserted, and stops firing after unsubscribe", async () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeToOfflineFileCells(store, "proj1", "file1", onChange)
    onChange.mockClear() // LiveStore subscriptions fire once immediately with the initial value

    seedCell({ fileId: "file1", cellId: "c1", side: "source", value: "hi", sequenceIndex: 0 })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())

    unsubscribe()
    onChange.mockClear()
    seedCell({ fileId: "file1", cellId: "c2", side: "source", value: "bye", sequenceIndex: 1 })
    // No reliable synchronous point to assert "never" — give any queued
    // notification a moment to land, then confirm nothing arrived.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("still reflects the correctly-scoped (empty) result when a row lands in a different file", async () => {
    // LiveStore's reactive invalidation isn't scoped tighter than the table,
    // so writing an unrelated file's row may still wake this subscription —
    // but the recomputed query result must stay correctly filtered.
    const onChange = vi.fn()
    subscribeToOfflineFileCells(store, "proj1", "file1", onChange)
    onChange.mockClear()

    seedCell({ fileId: "file2", cellId: "c1", side: "source", value: "elsewhere", sequenceIndex: 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readOfflineFileCells(store, "proj1", "file1")).toEqual([])
  })
})
