import { describe, it, expect, vi } from "vitest"
import { importDcsResource } from "./import-dcs"
import { dcsCellId, dcsEventId, dcsFileId } from "./cell-id"
import type { DcsCatalogEntry, DcsManifest } from "./types"
import type { BulkUploadArgs } from "@/lib/sync/bulk-import"

const ENTRY: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v89",
  refType: "tag",
  commitSha: "84c73ba0",
  released: "2026-06-23T22:01:02Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

const MANIFEST_YAML = `dublin_core:
  type: 'bundle'
  format: 'text/usfm'
  identifier: 'ult'
  subject: 'Aligned Bible'
  language:
    identifier: 'en'
    title: 'English'
    direction: 'ltr'
projects:
  - identifier: 'tit'
    path: './57-TIT.usfm'
`

const TIT_USFM = `\\id TIT
\\c 1
\\p
\\v 1 Paul, a servant of God.
\\v 2 In the hope of eternal life.`

/** A fake DcsClient with just the methods importDcsResource uses. */
function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getCatalogEntry: vi.fn(),
    searchCatalog: vi.fn(),
    compareRefs: vi.fn(),
    getTree: vi.fn(async () => ["57-TIT.usfm", "manifest.yaml", "LICENSE.md"]),
    fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, path: string) => {
      if (path === "manifest.yaml") return MANIFEST_YAML
      if (path === "57-TIT.usfm") return TIT_USFM
      return ""
    }),
    ...overrides,
  }
}

describe("importDcsResource — genesis transform (spec §3, §5)", () => {
  it("emits one bulk upload per routed file with deterministic event + cell ids", async () => {
    const client = fakeClient()
    const emit = vi.fn(async (_args: BulkUploadArgs) => {})
    const getToken = vi.fn(async () => "tok")

    const summary = await importDcsResource({
      entry: ENTRY,
      projectId: "proj-1",
       
      client: client as any,
      emit,
      getToken,
    })

    expect(emit).toHaveBeenCalledTimes(1)
    const args = emit.mock.calls[0][0]

    // File-level ids/meta are deterministic + correct.
    expect(args.projectId).toBe("proj-1")
    expect(args.fileId).toBe(dcsFileId(ENTRY.fullName, "57-TIT.usfm"))
    expect(args.file.id).toBe(dcsFileId(ENTRY.fullName, "57-TIT.usfm"))
    expect(args.file.fileType).toBe("usfm")
    expect(args.file.bookCode).toBe("TIT")

    // Two verse cells, chained via anchorCellId, with deterministic ids.
    expect(args.cells).toHaveLength(2)
    const c0 = args.cells[0]
    const c1 = args.cells[1]

    const cell0Id = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    const cell1Id = dcsCellId("unfoldingWord/en_ult|TIT 1:2")
    expect(c0.cellId).toBe(cell0Id)
    expect(c1.cellId).toBe(cell1Id)

    // The BulkImportCell.id is the DETERMINISTIC, PROJECT-SCOPED EVENT id
    // (projectId|repo|sha|cellId) — project scope stops the same resource
    // imported into two projects from colliding on the events-table PK.
    expect(c0.id).toBe(dcsEventId("proj-1", ENTRY.fullName, ENTRY.commitSha, cell0Id))
    expect(c1.id).toBe(dcsEventId("proj-1", ENTRY.fullName, ENTRY.commitSha, cell1Id))

    // Anchor chain: first cell anchors to null, each subsequent to the prior cellId.
    expect(c0.anchorCellId).toBeNull()
    expect(c1.anchorCellId).toBe(cell0Id)

    expect(c0.canonicalRef).toBe("TIT 1:1")
    expect(c0.type).toBe("verse")
    expect(c0.value).toContain("Paul, a servant of God")

    // Summary reflects what landed + a cursor for the pinned release.
    expect(summary.files).toBe(1)
    expect(summary.cells).toBe(2)
    expect(summary.cursor.ref).toBe("v89")
    expect(summary.cursor.commitSha).toBe("84c73ba0")
  })

  it("re-running the same import derives identical event ids (idempotent)", async () => {
    const emitA = vi.fn(async (_args: BulkUploadArgs) => {})
    const emitB = vi.fn(async (_args: BulkUploadArgs) => {})
    const base = {
      entry: ENTRY,
      projectId: "proj-1",
      getToken: async () => "tok",
    }
     
    await importDcsResource({ ...base, client: fakeClient() as any, emit: emitA })
     
    await importDcsResource({ ...base, client: fakeClient() as any, emit: emitB })

    const idsA = emitA.mock.calls[0][0].cells.map((c) => c.id)
    const idsB = emitB.mock.calls[0][0].cells.map((c) => c.id)
    expect(idsA).toEqual(idsB)
  })

  it("importing the SAME resource into a DIFFERENT project derives DIFFERENT event ids (project scope)", async () => {
    // FINDING 4 fix: event ids fold in projectId. Same resource@ref imported
    // into two projects must NOT collide on the events-table PK (which would
    // make the server's INSERT OR IGNORE silently drop the second import).
    const emitP1 = vi.fn(async (_args: BulkUploadArgs) => {})
    const emitP2 = vi.fn(async (_args: BulkUploadArgs) => {})
    const base = { entry: ENTRY, getToken: async () => "tok" }

    await importDcsResource({ ...base, projectId: "proj-1", client: fakeClient() as any, emit: emitP1 })
    await importDcsResource({ ...base, projectId: "proj-2", client: fakeClient() as any, emit: emitP2 })

    const idsP1 = emitP1.mock.calls[0][0].cells.map((c) => c.id)
    const idsP2 = emitP2.mock.calls[0][0].cells.map((c) => c.id)
    // Cell ids (content-addressed) stay identical across projects…
    const cellIdsP1 = emitP1.mock.calls[0][0].cells.map((c) => c.cellId)
    const cellIdsP2 = emitP2.mock.calls[0][0].cells.map((c) => c.cellId)
    expect(cellIdsP1).toEqual(cellIdsP2)
    // …but the EVENT ids differ, so both projects land their own import events.
    expect(idsP1).toHaveLength(idsP2.length)
    for (const id of idsP1) expect(idsP2).not.toContain(id)
  })

  it("passes the raw USFM through as rawSource for round-trip export", async () => {
    const client = fakeClient()
    const emit = vi.fn(async (_args: BulkUploadArgs) => {})
     
    await importDcsResource({ entry: ENTRY, projectId: "p", client: client as any, emit, getToken: async () => "t" })
    const args = emit.mock.calls[0][0]
    expect(args.rawSource).toBe(TIT_USFM)
    expect(args.rawSourceFormat).toBe("usfm")
  })

  it("throws a clear error when no route matches the resource", async () => {
    // Slice E routed TSV notes/questions + OBS, so the "no route" case is now a
    // still-unrouted markdown resource — Translation Words (the deferred tw/ta
    // tail, spec §12). Keep this pointed at a genuinely unrouted resource.
    const noRouteManifest = `dublin_core:
  type: 'dict'
  format: 'text/markdown'
  identifier: 'tw'
  subject: 'Translation Words'
  language: { identifier: 'en', title: 'English', direction: 'ltr' }
`
    const client = fakeClient({
      fetchRaw: vi.fn(async () => noRouteManifest),
      getTree: vi.fn(async () => ["bible/kt/god.md"]),
    })
    const emit = vi.fn(async (_args: BulkUploadArgs) => {})
    await expect(

      importDcsResource({ entry: { ...ENTRY, contentFormat: "markdown", subject: "Translation Words" }, projectId: "p", client: client as any, emit, getToken: async () => "t" }),
    ).rejects.toThrow(/no.*route/i)
  })
})

// keep DcsManifest import used (type-only surface check)
const _typecheck: DcsManifest | null = null
void _typecheck
