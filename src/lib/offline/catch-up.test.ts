import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import type { CellRow, FileSummary } from "@/lib/sync/cells-read-types"
import type { CellsDeltaResult } from "@/lib/sync/cells-read"
import { catchUpProject, type CatchUpDeps } from "./catch-up"
import { cellRowId, events, schema, syncCursorId, tables } from "./schema"

const P = "proj1"
const F = "file1"

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `catch-up-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
  store.commit(events.fileSynced({ id: F, projectId: P, name: "Matthew", type: "usfm", sequenceIndex: 0 }))
  store.commit(events.offlineProjectStatusSet({ projectId: P, status: "ready", syncedAt: new Date(0), queueDepth: 0 }))
})

function row(cellId: string, side: "source" | "target", value: string, eventId = `ev-${cellId}-${side}-${value}`): CellRow {
  return {
    cellId,
    side,
    targetLang: "",
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    aiDrafted: false,
    wordCount: 0,
    sequenceIndex: 0,
  } as CellRow
}

function seedLocal(r: CellRow): void {
  store.commit(
    events.cellSynced({
      projectId: P,
      fileId: F,
      cellId: r.cellId,
      side: r.side,
      value: r.value,
      valueHtml: r.valueHtml,
      eventId: r.eventId,
      sourceEventId: r.sourceEventId,
      validated: r.validated,
      aiDrafted: false,
      sequenceIndex: 0,
      canonicalRef: null,
    }),
  )
}

const file: FileSummary = { fileId: F, projectId: P, name: "Matthew", fileType: "usfm" } as FileSummary

type Page = { rows: CellRow[]; maxServerSeq?: number; projectEpoch?: number }

function makeDeps(opts: { files?: FileSummary[]; pages?: Page[]; delta?: CellsDeltaResult } = {}) {
  const streamFileCells = vi.fn<CatchUpDeps["streamFileCells"]>(async (_p, _f, _t, onPage, _side, onMeta) => {
    const pages = opts.pages ?? []
    for (const [i, page] of pages.entries()) {
      onMeta?.({ maxServerSeq: page.maxServerSeq, projectEpoch: page.projectEpoch })
      await onPage(page.rows, i === pages.length - 1)
    }
  })
  const fetchCellsDelta = vi.fn<CatchUpDeps["fetchCellsDelta"]>(async () => opts.delta ?? { kind: "resync" })
  const fetchProjectFiles = vi.fn<CatchUpDeps["fetchProjectFiles"]>(async () => opts.files ?? [file])
  return { streamFileCells, fetchCellsDelta, fetchProjectFiles }
}

const cell = (cellId: string, side: "source" | "target") =>
  store.query(tables.cells.select().where({ id: cellRowId(P, F, cellId, side) }).first())
const cursor = () => store.query(tables.syncCursors.select().where({ id: syncCursorId(P, F) }).first())

describe("catchUpProject — full sync (no cursor)", () => {
  it("replaces stale rows, removes cells the server no longer has, and mints a cursor", async () => {
    seedLocal(row("v1", "target", "old"))
    seedLocal(row("gone", "target", "deleted upstream"))
    const deps = makeDeps({
      pages: [
        { rows: [row("v1", "source", "src"), row("v1", "target", "new")], maxServerSeq: 50, projectEpoch: 2 },
        { rows: [row("v2", "target", "added")], maxServerSeq: 50, projectEpoch: 2 },
      ],
    })

    await catchUpProject(store, P, "tok", deps)

    expect(cell("v1", "target")?.value).toBe("new")
    expect(cell("v1", "source")?.value).toBe("src")
    expect(cell("v2", "target")?.value).toBe("added")
    expect(cell("gone", "target")).toBeUndefined()
    expect(cursor()).toMatchObject({ serverSeq: 50, projectEpoch: 2 })
    expect(deps.fetchCellsDelta).not.toHaveBeenCalled()
  })

  it("on a torn stream upserts what arrived, removes nothing, and mints no cursor", async () => {
    seedLocal(row("maybe-skipped", "target", "still here"))
    const deps = makeDeps({
      pages: [
        { rows: [row("v1", "target", "new")], maxServerSeq: 50, projectEpoch: 2 },
        { rows: [row("v2", "target", "new")], maxServerSeq: 51, projectEpoch: 2 },
      ],
    })

    await catchUpProject(store, P, "tok", deps)

    expect(cell("v1", "target")?.value).toBe("new")
    expect(cell("maybe-skipped", "target")?.value).toBe("still here")
    expect(cursor()).toMatchObject({ serverSeq: null, projectEpoch: null })
  })

  it("does not trust a cursor without a project epoch", async () => {
    const deps = makeDeps({ pages: [{ rows: [row("v1", "target", "new")], maxServerSeq: 50 }] })
    await catchUpProject(store, P, "tok", deps)
    expect(cursor()).toMatchObject({ serverSeq: null, projectEpoch: null })
  })

  it("commits nothing when the local copy already matches", async () => {
    const pages = [{ rows: [row("v1", "target", "same")], maxServerSeq: 50, projectEpoch: 2 }]
    await catchUpProject(store, P, "tok", makeDeps({ pages }))
    store.commit(events.syncCursorSet({ projectId: P, fileId: F, serverSeq: null, projectEpoch: null }))

    const result = await catchUpProject(store, P, "tok", makeDeps({ pages }))
    expect(result.rowsChanged).toBe(0)
  })
})

describe("catchUpProject — delta (trusted cursor)", () => {
  beforeEach(() => {
    store.commit(events.syncCursorSet({ projectId: P, fileId: F, serverSeq: 50, projectEpoch: 2 }))
  })

  it("applies changed cells, removes deleted ones, and advances the cursor", async () => {
    seedLocal(row("v1", "target", "old"))
    seedLocal(row("v9", "target", "to delete"))
    seedLocal(row("untouched", "target", "keep"))
    const deps = makeDeps({
      delta: {
        kind: "delta",
        changedCellIds: ["v1", "v9"],
        cells: [row("v1", "target", "web edit")],
        maxServerSeq: 60,
        projectEpoch: 2,
      },
    })

    await catchUpProject(store, P, "tok", deps)

    expect(deps.fetchCellsDelta).toHaveBeenCalledWith(P, F, 50, "tok", undefined, 2)
    expect(cell("v1", "target")?.value).toBe("web edit")
    expect(cell("v9", "target")).toBeUndefined()
    expect(cell("untouched", "target")?.value).toBe("keep")
    expect(cursor()).toMatchObject({ serverSeq: 60, projectEpoch: 2 })
    expect(deps.streamFileCells).not.toHaveBeenCalled()
  })

  it("skips a cell with a queued local edit and holds the cursor", async () => {
    seedLocal(row("v1", "target", "my unsent edit"))
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: P,
        fileId: F,
        cellId: "v1",
        kind: "target.cell.commit",
        payload: { value: "my unsent edit" },
        parentId: null,
        author: "me",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )
    const deps = makeDeps({
      delta: {
        kind: "delta",
        changedCellIds: ["v1", "v2"],
        cells: [row("v1", "target", "peer edit"), row("v2", "target", "other")],
        maxServerSeq: 60,
        projectEpoch: 2,
      },
    })

    await catchUpProject(store, P, "tok", deps)

    expect(cell("v1", "target")?.value).toBe("my unsent edit")
    expect(cell("v2", "target")?.value).toBe("other")
    expect(cursor()).toMatchObject({ serverSeq: 50, projectEpoch: 2 })
  })

  it("ignores non-default target lanes", async () => {
    seedLocal(row("v1", "target", "default lane"))
    const other = { ...row("v1", "target", "segunda lengua"), targetLang: "es" }
    const deps = makeDeps({
      delta: { kind: "delta", changedCellIds: ["v1"], cells: [row("v1", "target", "default v2"), other], maxServerSeq: 60, projectEpoch: 2 },
    })
    await catchUpProject(store, P, "tok", deps)
    expect(cell("v1", "target")?.value).toBe("default v2")
  })

  it("falls back to a full stream when the server asks for a resync", async () => {
    const deps = makeDeps({
      delta: { kind: "resync" },
      pages: [{ rows: [row("v1", "target", "from stream")], maxServerSeq: 90, projectEpoch: 3 }],
    })
    await catchUpProject(store, P, "tok", deps)
    expect(cell("v1", "target")?.value).toBe("from stream")
    expect(cursor()).toMatchObject({ serverSeq: 90, projectEpoch: 3 })
  })
})

describe("catchUpProject — project level", () => {
  it("adds files created since download and bumps syncedAt", async () => {
    const newFile = { ...file, fileId: "file2", name: "Mark" }
    const deps = makeDeps({ files: [file, newFile], pages: [{ rows: [], maxServerSeq: 1, projectEpoch: 1 }] })

    await catchUpProject(store, P, "tok", deps)

    expect(store.query(tables.files.select().where({ id: "file2" }).first())).toMatchObject({ name: "Mark" })
    expect(deps.streamFileCells).toHaveBeenCalledTimes(2)
    const project = store.query(tables.offlineProjects.select().where({ projectId: P }).first())
    expect(project?.syncedAt?.getTime()).toBeGreaterThan(0)
  })
})

describe("catchUpProject — batching", () => {
  it("lands a bulk sync as a few batched events, not one event per row", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => [row(`c${i}`, "source", `src ${i}`), row(`c${i}`, "target", `tgt ${i}`)]).flat()
    const commit = vi.spyOn(store, "commit")

    const result = await catchUpProject(store, P, "tok", makeDeps({ pages: [{ rows, maxServerSeq: 5, projectEpoch: 1 }] }))

    expect(result.rowsChanged).toBe(1200)
    expect(store.query(tables.cells.select().where({ projectId: P }))).toHaveLength(1200)
    const names = commit.mock.calls.flatMap((args) => args.map((e) => (e as { name: string }).name))
    expect(names.filter((n) => n === "v1.CellsSynced")).toHaveLength(3)
    expect(names).not.toContain("v1.CellSynced")
  })
})
