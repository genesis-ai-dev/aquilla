import { describe, expect, it, vi } from "vitest"
import { canImportAsRevision, postFileRevision, revisionUnitsFromCells, REVISION_IMPORT_FORMATS } from "./revision-import"
import type { BulkImportCell } from "./bulk-import"

vi.mock("./sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "https://sync.example" }))

const cell = (i: number, extra: Partial<BulkImportCell> = {}): BulkImportCell => ({
  id: `evt-${i}`,
  cellId: `cell-${i}`,
  anchorCellId: i === 0 ? null : `cell-${i - 1}`,
  value: `paragraph ${i}`,
  sequenceIndex: i,
  metadata: { aquillaImport: { unitKey: `docx:word/document.xml:p[${i}]`, sourceLocator: { kind: "package-block" } } },
  ...extra,
})

describe("revisionUnitsFromCells", () => {
  it("keys units by the import envelope and marks document blocks positional", () => {
    const units = revisionUnitsFromCells([cell(0), cell(1, { valueHtml: "<p>x</p>", type: "heading" })])
    expect(units[0]).toMatchObject({ unitKey: "docx:word/document.xml:p[0]", positional: true, text: "paragraph 0", sequenceIndex: 0 })
    expect(units[1]).toMatchObject({ html: "<p>x</p>", type: "heading" })
    // The importer's random cell id is NOT carried: identity comes from alignment.
    expect(JSON.stringify(units)).not.toContain("cell-0")
  })

  it("a verse-addressed or translation-unit cell is reference-addressed, not positional", () => {
    const [verse, tu, cue] = revisionUnitsFromCells([
      cell(0, { canonicalRef: "GEN 1:1", metadata: { aquillaImport: { unitKey: "GEN 1:1", sourceLocator: { kind: "usfm" } } } }),
      cell(1, { metadata: { aquillaImport: { unitKey: "tu-7", sourceLocator: { kind: "translation-unit" } } } }),
      cell(2, { metadata: { aquillaImport: { unitKey: "cue:2", sourceLocator: { kind: "cue" } } } }),
    ])
    expect(verse.positional).toBe(false)
    expect(tu.positional).toBe(false)
    expect(cue.positional).toBe(true)
  })

  it("disambiguates a repeated unit key so the server never refuses the parse", () => {
    const units = revisionUnitsFromCells([
      cell(0, { metadata: { aquillaImport: { unitKey: "k" } } }),
      cell(1, { metadata: { aquillaImport: { unitKey: "k" } } }),
      cell(2, { metadata: {} }),
    ])
    expect(units.map((u) => u.unitKey)).toEqual(["k", "k#2", "cell:cell-2"])
  })
})

describe("canImportAsRevision", () => {
  const base = { fileType: "docx", reimport: false as const, hasTargets: false, hasOriginalBytes: true, cells: [cell(0)] }
  it("takes a fresh, source-only, filter-backed import with its bytes", () => {
    expect(REVISION_IMPORT_FORMATS.has("docx")).toBe(true)
    expect(canImportAsRevision(base)).toBe(true)
  })
  // Why: "Update existing" is a plain revision; review apply and "Make updated
  // copy" unvalidate, repin and clone, which only /import/reconcile does yet.
  it("takes the plain update re-import, and leaves review apply and fork on reconcile", () => {
    expect(canImportAsRevision({ ...base, reimport: "update" })).toBe(true)
    expect(canImportAsRevision({ ...base, reimport: "review" })).toBe(false)
    expect(canImportAsRevision({ ...base, reimport: "fork" })).toBe(false)
  })
  it("refuses bilingual rows, formats without a filter, missing bytes and media rows", () => {
    expect(canImportAsRevision({ ...base, hasTargets: true })).toBe(false)
    expect(canImportAsRevision({ ...base, fileType: "usfm" })).toBe(false)
    expect(canImportAsRevision({ ...base, hasOriginalBytes: false })).toBe(false)
    expect(canImportAsRevision({ ...base, cells: [cell(0, { medium: "media" })] })).toBe(false)
    expect(canImportAsRevision({ ...base, cells: [cell(0, { startMs: 0, endMs: 10 })] })).toBe(false)
  })
})

describe("postFileRevision", () => {
  it("posts to the file's revisions route and retries once on 401 with a fresh token", async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      calls.push({ url: String(url), auth: headers.Authorization, body: JSON.parse(String(init?.body)) })
      return calls.length === 1
        ? new Response("expired", { status: 401 })
        : Response.json({ noop: false, revisionN: 1, eventId: "e", counts: { equal: 0, changed: 0, moved: 0, inserted: 1, deleted: 0 } })
    }) as unknown as typeof fetch
    const tokens = ["old", "new"]
    const result = await postFileRevision({
      projectId: "p 1",
      fileId: "f1",
      artifactSha256: "a".repeat(64),
      revision: { stamp: "docx@1", units: revisionUnitsFromCells([cell(0)]) },
      getToken: async () => tokens.shift() ?? null,
      fetchImpl,
    })
    expect(result.revisionN).toBe(1)
    expect(calls.map((c) => c.auth)).toEqual(["Bearer old", "Bearer new"])
    expect(calls[0].url).toBe("https://sync.example/api/v1/projects/p%201/files/f1/revisions")
    expect(calls[1].body).toMatchObject({ artifactSha256: "a".repeat(64), stamp: "docx@1", origin: "import" })
  })

  it("surfaces the server's refusal", async () => {
    const fetchImpl = vi.fn(async () => new Response("stamp must look like <filterId>@<walk>", { status: 400 })) as unknown as typeof fetch
    await expect(
      postFileRevision({ projectId: "p", fileId: "f", artifactSha256: "a".repeat(64), revision: { stamp: "bad", units: [] }, getToken: async () => "t", fetchImpl }),
    ).rejects.toThrow(/HTTP 400.*stamp must look like/)
  })
})
