/**
 * apiRev 7: files.upsert (create + delta refresh), extension metadata, data
 * files with drift, cells.byRef — the host side, over mocked sync reads and
 * the real change detection. Producer → consumer: what the extension passes
 * through the bridge handlers is exactly what reaches bulkUploadSource and the
 * typed emitters (with tool_origin + session).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CellRow, FileSummary } from "@/lib/sync/cells-read-types"

const state = vi.hoisted(() => ({
  files: [] as FileSummary[],
  rows: new Map<string, CellRow[]>(),
  byRef: [] as Array<CellRow & { fileId: string }>,
  bulk: [] as unknown[],
  emitted: [] as Array<{ kind: string; input: Record<string, unknown> }>,
  seq: 0,
}))

vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: vi.fn(async () => state.files),
  fetchAllFileCells: vi.fn(async (_p: string, fileId: string) => state.rows.get(fileId) ?? []),
  fetchCellsByIds: vi.fn(async (_p: string, fileId: string, ids: string[]) => (state.rows.get(fileId) ?? []).filter((r) => ids.includes(r.cellId))),
  fetchCellsByRef: vi.fn(async () => ({ cells: state.byRef, truncated: false })),
}))
vi.mock("@/lib/sync/bulk-import", () => ({
  bulkUploadSource: vi.fn(async (args: { fileId: string; file: { name: string; role?: string; extension?: unknown } }) => {
    state.bulk.push(args)
    state.files.push({ fileId: args.fileId, name: args.file.name, role: args.file.role ?? null, cellCount: 0, extension: args.file.extension } as unknown as FileSummary)
  }),
}))
vi.mock("@/lib/sync/events-emit", () => {
  const rec = (kind: string) => vi.fn(async (input: Record<string, unknown>) => {
    state.emitted.push({ kind, input })
    return `ev-${++state.seq}`
  })
  return {
    emitSourceCellCreate: rec("source.cell.create"),
    emitSourceCellCommit: rec("source.cell.commit"),
    emitSourceCellDelete: rec("source.cell.delete"),
    emitFileExtensionSet: rec("file.extension.set"),
    emitFileRename: rec("file.rename"),
  }
})
vi.mock("@/lib/sync/source-export", () => ({ fetchRawOriginalSource: vi.fn(async () => ({ bytes: new TextEncoder().encode("\\id TIT").buffer, rawOriginal: true })) }))
vi.mock("@/lib/sync/source-upload", () => ({ uploadSourceOriginal: vi.fn(async () => ({})) }))

import { LiveFilesData, extensionCellId, extensionDataFileId, extensionFileId, upsertHash } from "../live-data-files"
import { createFilesHandlers } from "../host-handlers-files"
import { BridgeError } from "../host-bridge"

const ORIGIN = { origin: "tool" as const, toolId: "importer", version: 3, codeHash: "a".repeat(64), session: "sess" }

function row(cellId: string, value: string, extra: Partial<CellRow> = {}): CellRow {
  return { cellId, side: "source", value, valueHtml: null, type: null, canonicalRef: null, anchorCellId: null, eventId: `head-${cellId}`, sourceEventId: null, lastEditor: "alice", lastEditAt: 1, validated: false, wordCount: 1, ...extra }
}

function make() {
  const flush = vi.fn()
  const data = new LiveFilesData({
    projectId: "p1",
    author: "alice",
    toolOrigin: () => ORIGIN,
    tokenFor: async () => "tok",
    flush,
    resolveLaneTag: async (lane) => lane,
  })
  return { data, flush, handlers: createFilesHandlers(data) }
}

beforeEach(() => {
  state.files = []
  state.rows = new Map()
  state.byRef = []
  state.bulk = []
  state.emitted = []
  state.seq = 0
})

describe("files.upsert", () => {
  const spec = {
    key: "uw:tn:TIT",
    name: "TIT notes",
    kind: "normal",
    tags: ["uw", "uw:tn"],
    group: "uw:TIT",
    meta: { sha: "s1" },
    format: "tsv",
    cells: [
      { key: "abc1", value: "Note one", ref: "TIT 1:1", metadata: { Quote: "Παῦλος" } },
      { key: "abc2", value: "Note two", ref: "TIT 1:2" },
    ],
  }

  it("creates the file through the bulk import with stable ids, extension metadata and the verified tool origin", async () => {
    const { handlers } = make()
    const out = (await handlers["files.upsert"](spec)) as { fileId: string; created: boolean; cellIds: Record<string, string> }
    const fileId = extensionFileId("p1", "uw:tn:TIT")
    expect(out).toMatchObject({ fileId, created: true, creates: 2 })
    expect(out.cellIds.abc1).toBe(extensionCellId(fileId, "abc1"))
    const bulk = state.bulk[0] as { fileId: string; file: { extension: Record<string, unknown>; fileType: string }; cells: Array<Record<string, unknown>>; toolOrigin: unknown }
    expect(bulk.fileId).toBe(fileId)
    expect(bulk.file.fileType).toBe("tsv")
    expect(bulk.file.extension).toEqual({ kind: "normal", tags: ["uw", "uw:tn"], owner: "importer", group: "uw:TIT", meta: { sha: "s1" } })
    expect(bulk.toolOrigin).toEqual(ORIGIN)
    expect(bulk.cells[1]).toMatchObject({ cellId: out.cellIds.abc2, anchorCellId: out.cellIds.abc1, canonicalRef: "TIT 1:2" })
    expect(bulk.cells[0].metadata).toEqual({ Quote: "Παῦλος" })
  })

  it("refreshes as a delta: unchanged cells untouched, changed committed on their head, new created after their predecessor, missing deleted", async () => {
    const fileId = extensionFileId("p1", "uw:tn:TIT")
    state.files = [{ fileId, name: "TIT notes", role: null, cellCount: 3, extension: { kind: "normal", tags: ["uw", "uw:tn"], owner: "importer", group: "uw:TIT", meta: { sha: "s1" } } } as unknown as FileSummary]
    state.rows.set(fileId, [
      row(extensionCellId(fileId, "abc1"), "Note one"),
      row(extensionCellId(fileId, "abc2"), "Old note two"),
      row(extensionCellId(fileId, "gone"), "Removed upstream"),
    ])
    const { handlers, flush } = make()
    const out = (await handlers["files.upsert"]({ ...spec, meta: { sha: "s2" }, cells: [...spec.cells, { key: "abc3", value: "Note three", ref: "TIT 1:3" }] })) as Record<string, number | boolean>
    expect(out).toMatchObject({ created: false, creates: 1, commits: 1, deletes: 1, unchanged: 1 })
    const kinds = state.emitted.map((e) => e.kind)
    expect(kinds).toEqual(["source.cell.create", "source.cell.commit", "source.cell.delete", "file.extension.set"])
    const [create, commitEv, del, ext] = state.emitted
    expect(create.input).toMatchObject({ cellId: extensionCellId(fileId, "abc3"), anchorCellId: extensionCellId(fileId, "abc2"), toolOrigin: ORIGIN })
    expect(commitEv.input).toMatchObject({ parentId: `head-${extensionCellId(fileId, "abc2")}`, value: "Note two", toolOrigin: ORIGIN })
    expect(del.input).toMatchObject({ cellId: extensionCellId(fileId, "gone"), parentId: `head-${extensionCellId(fileId, "gone")}` })
    expect((ext.input.extension as { meta: unknown }).meta).toEqual({ sha: "s2" })
    expect(flush).toHaveBeenCalled()
  })

  it("is a no-op when nothing changed", async () => {
    const fileId = extensionFileId("p1", "k")
    state.files = [{ fileId, name: "K", role: null, cellCount: 1, extension: { kind: "reference", tags: [], owner: "importer" } } as unknown as FileSummary]
    state.rows.set(fileId, [row(extensionCellId(fileId, "a"), "A")])
    const { handlers } = make()
    const out = await handlers["files.upsert"]({ key: "k", name: "K", kind: "reference", cells: [{ key: "a", value: "A" }] })
    expect(out).toMatchObject({ creates: 0, commits: 0, deletes: 0, unchanged: 1 })
    expect(state.emitted).toEqual([])
  })

  it("validates what an extension sends", async () => {
    const { handlers } = make()
    await expect(handlers["files.upsert"]({ ...spec, cells: [{ key: "x", value: "1" }, { key: "x", value: "2" }] })).rejects.toBeInstanceOf(BridgeError)
    await expect(handlers["files.upsert"]({ ...spec, kind: "data" })).rejects.toThrow(/aquilla\.data/)
    await expect(handlers["files.upsert"]({ ...spec, format: "exe" })).rejects.toThrow(/format/)
    await expect(handlers["files.upsert"]({ ...spec, tags: ["x".repeat(81)] })).rejects.toThrow(/tag/)
  })

  it("hashes value and rich text together", () => {
    expect(upsertHash("a", null)).toBe(upsertHash("a", ""))
    expect(upsertHash("a", "<b>a</b>")).not.toBe(upsertHash("a", null))
  })
})

describe("data files", () => {
  const ultFile = "ult-tit"

  it("creates the hidden data file on first put, anchors the record to the cell head, and reports drift", async () => {
    state.files = [{ fileId: ultFile, name: "ULT TIT", role: null, cellCount: 1 } as unknown as FileSummary]
    state.rows.set(ultFile, [row("v1", "Paul, a servant", { canonicalRef: "TIT 1:1" }), { ...row("v1", "Pablo, siervo"), side: "target", targetLang: "", eventId: "t-head-1" }])
    const { handlers } = make()
    const put = (await handlers["data.put"]({ ns: "uw.alignment-gl", id: "TIT 1:1", doc: { groups: [1] }, coll: "tit", anchor: { fileId: ultFile, cellId: "v1" } })) as { version: string }
    const dataFile = extensionDataFileId("p1", "uw.alignment-gl", "tit")
    const bulk = state.bulk[0] as { fileId: string; file: { role: string; extension: Record<string, unknown> } }
    expect(bulk.fileId).toBe(dataFile)
    expect(bulk.file.role).toBe("extension-data")
    expect(bulk.file.extension).toMatchObject({ kind: "data", owner: "importer", meta: { ns: "uw.alignment-gl", coll: "tit" } })
    const create = state.emitted.find((e) => e.kind === "source.cell.create")!
    expect(create.input).toMatchObject({ fileId: dataFile, cellId: extensionCellId(dataFile, "TIT 1:1"), canonicalRef: "TIT 1:1", toolOrigin: ORIGIN })
    const envelope = JSON.parse(create.input.value as string)
    expect(envelope).toEqual({ v: 1, id: "TIT 1:1", doc: { groups: [1] }, anchor: { fileId: ultFile, cellId: "v1", side: "target", lane: "", eventId: "t-head-1" } })
    expect(put.version).toMatch(/^ev-/)

    const doc = (await handlers["data.get"]({ ns: "uw.alignment-gl", id: "TIT 1:1", coll: "tit" })) as { drift: string; doc: unknown }
    expect(doc).toMatchObject({ drift: "current", doc: { groups: [1] } })

    // The translation is edited: the record now reads "changed".
    state.rows.set(ultFile, [row("v1", "Paul, a servant", { canonicalRef: "TIT 1:1" }), { ...row("v1", "Pablo, un siervo"), side: "target", targetLang: "", eventId: "t-head-2" }])
    expect(((await handlers["data.query"]({ ns: "uw.alignment-gl", coll: "tit", anchorFileId: ultFile })) as Array<{ drift: string }>)[0].drift).toBe("changed")

    // The cell is removed: "orphaned".
    state.rows.set(ultFile, [])
    expect(((await handlers["data.get"]({ ns: "uw.alignment-gl", id: "TIT 1:1", coll: "tit" })) as { drift: string }).drift).toBe("orphaned")
  })

  it("a second put commits on the previous version, and delete chains on the head", async () => {
    state.files = [{ fileId: ultFile, name: "ULT TIT", role: null, cellCount: 1 } as unknown as FileSummary]
    const { handlers } = make()
    await handlers["data.put"]({ ns: "notes", id: "a", doc: 1 })
    const first = state.emitted.at(-1)!
    await handlers["data.put"]({ ns: "notes", id: "a", doc: 2 })
    const second = state.emitted.at(-1)!
    expect(second.kind).toBe("source.cell.commit")
    expect(second.input.parentId).toBe("ev-1")
    expect(first.kind).toBe("source.cell.create")
    expect(await handlers["data.delete"]({ ns: "notes", id: "a" })).toBe(true)
    expect(state.emitted.at(-1)).toMatchObject({ kind: "source.cell.delete", input: { parentId: "ev-2" } })
  })

  it("rejects bad namespaces and oversized docs", async () => {
    const { handlers } = make()
    await expect(handlers["data.put"]({ ns: "Bad NS", id: "a", doc: 1 })).rejects.toBeInstanceOf(BridgeError)
    await expect(handlers["data.put"]({ ns: "ok", id: "a", doc: "x".repeat(200_001) })).rejects.toThrow(/exceeds/)
  })
})

describe("cells.byRef and files", () => {
  it("pairs source and target rows per ref across files, finding files by tag", async () => {
    state.files = [
      { fileId: "ult", name: "ULT", role: null, cellCount: 1, extension: { kind: "normal", tags: ["uw", "book:TIT"] } },
      { fileId: "tn", name: "TN", role: null, cellCount: 1, extension: { kind: "normal", tags: ["uw", "book:TIT"] } },
      { fileId: "other", name: "Other", role: null, cellCount: 1 },
    ] as unknown as FileSummary[]
    state.byRef = [
      { ...row("u1", "Paul", { canonicalRef: "TIT 1:1" }), fileId: "ult" },
      { ...row("u1", "Pablo", { canonicalRef: "TIT 1:1", validated: true }), side: "target", fileId: "ult" },
      { ...row("n1", "a note", { canonicalRef: "TIT 1:1", metadata: { Quote: "Παῦλος" } }), fileId: "tn" },
    ]
    const { handlers } = make()
    const out = (await handlers["cells.byRef"]({ refs: ["TIT 1:1"], tags: ["uw", "book:TIT"] })) as Record<string, Array<Record<string, unknown>>>
    expect(out["TIT 1:1"]).toEqual([
      expect.objectContaining({ fileId: "ult", cellId: "u1", source: "Paul", target: "Pablo", validated: true }),
      expect.objectContaining({ fileId: "tn", cellId: "n1", source: "a note", metadata: { Quote: "Παῦλος" } }),
    ])
    const { fetchCellsByRef } = await import("@/lib/sync/cells-read")
    expect(vi.mocked(fetchCellsByRef).mock.calls[0][2]).toMatchObject({ fileIds: ["ult", "tn"], refs: ["TIT 1:1"] })
    await expect(handlers["cells.byRef"]({ refs: ["TIT 1:1"] })).rejects.toThrow(/fileIds or tags/)
  })

  it("lists by tags/kind and resolves a file's group", async () => {
    state.files = [
      { fileId: "a", name: "A", role: null, cellCount: 1, extension: { kind: "reference", tags: ["uw"], group: "uw:TIT" } },
      { fileId: "b", name: "B", role: null, cellCount: 1, extension: { kind: "normal", tags: ["uw"], group: "uw:TIT" } },
      { fileId: "d", name: "D", role: "extension-data", cellCount: 1, extension: { kind: "data", tags: ["data:x"] } },
    ] as unknown as FileSummary[]
    const { data, handlers } = make()
    expect((await data.listFilesFiltered({ kind: "reference" })).map((f) => f.fileId)).toEqual(["a"])
    expect((await data.listFilesFiltered({ kind: "data" })).map((f) => f.fileId)).toEqual(["d"])
    const group = (await handlers["files.group"]({ fileId: "a" })) as { key: string; files: Array<{ fileId: string }> }
    expect(group.key).toBe("uw:TIT")
    expect(group.files.map((f) => f.fileId)).toEqual(["a", "b"])
  })

  it("setMeta keeps the owner and merges the patch", async () => {
    state.files = [{ fileId: "a", name: "A", role: null, cellCount: 1, extension: { kind: "normal", tags: ["x"], owner: "first" } }] as unknown as FileSummary[]
    const { handlers } = make()
    const view = await handlers["files.setMeta"]({ fileId: "a", tags: ["y"], kind: "reference", meta: { sha: "1" } })
    expect(view).toMatchObject({ kind: "reference", tags: ["y"], owner: "first", meta: { sha: "1" } })
    expect(state.emitted[0]).toMatchObject({ kind: "file.extension.set", input: { extension: { kind: "reference", tags: ["y"], owner: "first", meta: { sha: "1" } }, toolOrigin: ORIGIN } })
  })
})

describe("headless reports", () => {
  it("reach the host callbacks and validate delivered files", async () => {
    const progress = vi.fn()
    const done = vi.fn()
    const deliver = vi.fn()
    const data = new LiveFilesData({
      projectId: "p1", author: "alice", toolOrigin: () => ORIGIN, tokenFor: async () => "tok", flush: () => {}, resolveLaneTag: async (l) => l,
      headless: () => ({ progress, done, deliver }),
    })
    const h = createFilesHandlers(data)
    await h["action.progress"]({ message: "Fetching TIT", fraction: 2 })
    expect(progress).toHaveBeenCalledWith("Fetching TIT", 1)
    await h["action.done"]({ message: "3 files updated" })
    expect(done).toHaveBeenCalledWith("3 files updated", true)
    await h["export.deliver"]({ files: [{ name: "57-TIT.usfm", text: "\\id TIT" }, { name: "tn/tn_TIT.tsv", text: "x", mime: "text/tab-separated-values" }] })
    expect(deliver.mock.calls[0][0]).toHaveLength(2)
    await expect(h["export.deliver"]({ files: [{ name: "../evil", text: "x" }] })).rejects.toThrow(/plain file name/)
    await expect(h["export.deliver"]({ files: [{ name: "a.txt" }] })).rejects.toThrow(/text|bytes/)
  })
})
