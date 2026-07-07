import { describe, it, expect } from "vitest"
import { v5 as uuidv5 } from "uuid"
import { DCS_NS, dcsCellId, dcsEventId, dcsFileId } from "./cell-id"

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

  it("dcsEventId folds in the sha so re-runs of the SAME delta dedupe", () => {
    const cellId = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    const a = dcsEventId("unfoldingWord/en_ult", "84c73ba0", cellId)
    const b = dcsEventId("unfoldingWord/en_ult", "84c73ba0", cellId)
    expect(a).toBe(b)
    expect(a).toBe(uuidv5(`unfoldingWord/en_ult|84c73ba0|${cellId}`, DCS_NS))
  })

  it("dcsEventId changes when the sha changes (a new delta → a new event id)", () => {
    const cellId = dcsCellId("unfoldingWord/en_ult|TIT 1:1")
    expect(dcsEventId("unfoldingWord/en_ult", "sha_old", cellId)).not.toBe(
      dcsEventId("unfoldingWord/en_ult", "sha_new", cellId),
    )
  })

  it("dcsFileId is deterministic per (repo, key)", () => {
    const a = dcsFileId("unfoldingWord/en_ult", "57-TIT.usfm")
    expect(a).toBe(dcsFileId("unfoldingWord/en_ult", "57-TIT.usfm"))
    expect(a).toBe(uuidv5("unfoldingWord/en_ult|file|57-TIT.usfm", DCS_NS))
    expect(a).not.toBe(dcsFileId("unfoldingWord/en_ult", "58-PHM.usfm"))
  })
})
