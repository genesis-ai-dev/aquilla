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
    expect(args.fileId).toBe(dcsFileId("proj-1", ENTRY.fullName, "57-TIT.usfm"))
    expect(args.file.id).toBe(dcsFileId("proj-1", ENTRY.fullName, "57-TIT.usfm"))
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
    expect(client.fetchRaw).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "LICENSE.md", expect.anything(),
    )
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

  it("returns an explicit partial report when a later routed file fails", async () => {
    const second = `\\id PHM
\\c 1
\\v 1 Paul, a prisoner of Christ Jesus.`
    const client = fakeClient({
      getTree: vi.fn(async () => ["57-TIT.usfm", "58-PHM.usfm", "manifest.yaml"]),
      fetchRaw: vi.fn(async (_o: string, _r: string, _ref: string, path: string) => {
        if (path === "manifest.yaml") return MANIFEST_YAML
        if (path === "57-TIT.usfm") return TIT_USFM
        if (path === "58-PHM.usfm") return second
        return ""
      }),
    })
    const emit = vi.fn(async (args: BulkUploadArgs) => {
      if (args.file.name.startsWith("PHM")) throw new Error("source storage unavailable")
    })

    const summary = await importDcsResource({
      entry: ENTRY,
      projectId: "p",
      client: client as any,
      emit,
      getToken: async () => "t",
    })

    expect(summary.files).toBe(1)
    expect(summary.refs).toHaveLength(1)
    expect(summary.skipped).toEqual([
      expect.objectContaining({ book: expect.stringMatching(/^PHM/), reason: "source storage unavailable" }),
    ])
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

describe("importDcsResource — AQU-1891: the same resource into two projects", () => {
  it("gives each project its OWN file id, so the second import cannot land on the first's file rows", async () => {
    // Repro: project A imports a Door43 resource, project B imports the same
    // resource at the same release. Before the fix both derived the identical
    // file id, so B's file.create upserted ON CONFLICT(id) onto A's rows — B
    // got cells but no file rows (empty file list, 404 on the source-original
    // upload), and A's file metadata could be overwritten.
    const emitA = vi.fn(async (_args: BulkUploadArgs) => {})
    const emitB = vi.fn(async (_args: BulkUploadArgs) => {})

    await importDcsResource({
      entry: ENTRY,
      projectId: "proj-A",
       
      client: fakeClient() as any,
      emit: emitA,
      getToken: async () => "tok",
    })
    await importDcsResource({
      entry: ENTRY,
      projectId: "proj-B",
       
      client: fakeClient() as any,
      emit: emitB,
      getToken: async () => "tok",
    })

    const a = emitA.mock.calls[0][0]
    const b = emitB.mock.calls[0][0]

    // Distinct file ids — and each is the id its own project derives.
    expect(a.fileId).not.toBe(b.fileId)
    expect(a.fileId).toBe(dcsFileId("proj-A", ENTRY.fullName, "57-TIT.usfm"))
    expect(b.fileId).toBe(dcsFileId("proj-B", ENTRY.fullName, "57-TIT.usfm"))
    // The file.create meta id must agree with the upload's fileId, or the
    // source-original upload 404s on a row the project does not own.
    expect(a.file.id).toBe(a.fileId)
    expect(b.file.id).toBe(b.fileId)

    // Cell ids stay content-addressed (cross-import lineage) — the cells PK is
    // already project-scoped, so only file/event ids need the scope.
    expect(b.cells.map((c) => c.cellId)).toEqual(a.cells.map((c) => c.cellId))
    // …while the EVENT ids differ per project (the pre-existing scope).
    expect(b.cells[0].id).not.toBe(a.cells[0].id)
  })
})

// keep DcsManifest import used (type-only surface check)
const _typecheck: DcsManifest | null = null
void _typecheck
