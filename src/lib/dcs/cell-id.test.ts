import { describe, it, expect } from "vitest"
import { v5 as uuidv5 } from "uuid"
import { DCS_NS, dcsCellId, dcsEventId, dcsFileId, dcsLegacyFileId } from "./cell-id"

describe("dcs cell-id (deterministic uuidv5, spec §5)", () => {
  it("DCS_NS is a fixed, valid UUID (the never-change namespace)", () => {
    expect(DCS_NS).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("dcsCellId is stable: same seed → same id across calls", () => {
    const seed = "unfoldingWord/en_ult|TIT 1:1"
    expect(dcsCellId(seed)).toBe(dcsCellId(seed))
  })

  it("dcsCellId matches uuidv5(seed, DCS_NS) — the documented formula", () => {
    const seed = "unfoldingWord/en_ult|TIT 1:1"
    expect(dcsCellId(seed)).toBe(uuidv5(seed, DCS_NS))
  })

  it("different seeds → different cell ids", () => {
    expect(dcsCellId("unfoldingWord/en_ult|TIT 1:1")).not.toBe(
      dcsCellId("unfoldingWord/en_ult|TIT 1:2"),
    )
  })

  it("cell id is release-independent (no sha in the seed → stable across v87/v89)", () => {
    // The seed the adapter uses for a verse contains only repo + ref, never a
    // commit sha. Two 'imports' of the same verse produce the same cell id, so a
    // delta is a commit on an existing cell, not a create.
    const v87 = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    const v89 = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    expect(v87).toBe(v89)
  })

  it("dcsEventId folds in projectId + sha so re-runs of the SAME delta in the SAME project dedupe", () => {
    const cellId = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    const a = dcsEventId("proj-1", "unfoldingWord/en_ult", "84c73ba0", cellId)
    const b = dcsEventId("proj-1", "unfoldingWord/en_ult", "84c73ba0", cellId)
    expect(a).toBe(b)
    expect(a).toBe(uuidv5(`proj-1|unfoldingWord/en_ult|84c73ba0|${cellId}`, DCS_NS))
  })

  it("dcsEventId changes when the sha changes (a new delta → a new event id)", () => {
    const cellId = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    expect(dcsEventId("proj-1", "unfoldingWord/en_ult", "sha_old", cellId)).not.toBe(
      dcsEventId("proj-1", "unfoldingWord/en_ult", "sha_new", cellId),
    )
  })

  it("dcsEventId is PROJECT-SCOPED: same (repo,sha,cell) in two projects → DIFFERENT event ids", () => {
    // The events-table PK is the event id. Without project scope, importing the
    // same DCS resource into a second project produces identical event ids and
    // the server's INSERT OR IGNORE silently drops the second import. Same
    // project must still be deterministic (idempotent re-run); different project
    // must differ.
    const cellId = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    const inProjA = dcsEventId("proj-A", "unfoldingWord/en_ult", "84c73ba0", cellId)
    const inProjB = dcsEventId("proj-B", "unfoldingWord/en_ult", "84c73ba0", cellId)
    expect(inProjA).not.toBe(inProjB)
    // …but the SAME project is still deterministic across calls (idempotency).
    expect(inProjA).toBe(dcsEventId("proj-A", "unfoldingWord/en_ult", "84c73ba0", cellId))
  })

  it("dcsFileId is deterministic per (project, repo, key)", () => {
    const a = dcsFileId("proj-A", "unfoldingWord/en_ult", "57-TIT.usfm")
    expect(a).toBe(dcsFileId("proj-A", "unfoldingWord/en_ult", "57-TIT.usfm"))
    expect(a).toBe(uuidv5("proj-A|unfoldingWord/en_ult|file|57-TIT.usfm", DCS_NS))
    expect(a).not.toBe(dcsFileId("proj-A", "unfoldingWord/en_ult", "58-PHM.usfm"))
  })

  it("dcsFileId is PROJECT-SCOPED: same (repo,path) in two projects → DIFFERENT file ids", () => {
    // AQU-1891: the `files` table's PK is the file id ALONE, and file.create
    // upserts ON CONFLICT(id). Without the project in the seed, the second
    // project to import a resource lands its file.create on the FIRST
    // project's rows: it gets cells but no files, its file list is empty and
    // the source-original upload 404s.
    const inProjA = dcsFileId("proj-A", "unfoldingWord/en_ult", "57-TIT.usfm")
    const inProjB = dcsFileId("proj-B", "unfoldingWord/en_ult", "57-TIT.usfm")
    expect(inProjA).not.toBe(inProjB)
    // …and the SAME project stays deterministic across calls (idempotent re-import).
    expect(inProjA).toBe(dcsFileId("proj-A", "unfoldingWord/en_ult", "57-TIT.usfm"))
  })

  it("dcsLegacyFileId still reproduces the pre-AQU-1891 project-agnostic id", () => {
    // The read-side compatibility shim: projects imported before the scope
    // landed hold file rows under this id, and the delta/repair paths must
    // keep recognising it.
    const legacy = dcsLegacyFileId("unfoldingWord/en_ult", "57-TIT.usfm")
    expect(legacy).toBe(uuidv5("unfoldingWord/en_ult|file|57-TIT.usfm", DCS_NS))
    expect(legacy).not.toBe(dcsFileId("proj-A", "unfoldingWord/en_ult", "57-TIT.usfm"))
  })
})
