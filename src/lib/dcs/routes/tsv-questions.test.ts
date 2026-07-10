import { describe, it, expect } from "vitest"
import { tsvQuestionsRoute } from "./tsv-questions"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"
import type { DcsCatalogEntry, DcsManifest } from "../types"

const TQ_ENTRY: DcsCatalogEntry = {
  name: "en_tq",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_tq",
  subject: "TSV Translation Questions",
  contentFormat: "tsv",
  ref: "v40",
  refType: "tag",
  commitSha: "b0bab0ba",
  released: "2026-03-01T00:00:00Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

const TQ_MANIFEST: DcsManifest = {
  rcType: "help",
  subject: "TSV Translation Questions",
  format: "text/tsv",
  identifier: "tq",
  language: { identifier: "en", title: "English", direction: "ltr" },
  projects: [{ identifier: "tit", path: "./tq_TIT.tsv" }],
}

// A 2-row TQ TSV: one row with a Response, one without.
// Columns: Reference ID Tags Quote Occurrence Question Response
const TQ_TSV = [
  "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse",
  "1:1\tq001\t\t\t0\tWhose servant does Paul call himself?\tPaul calls himself a servant of God.",
  "1:2\tq002\t\t\t0\tWhat did God promise before time began?\t",
].join("\n")

describe("tsvQuestionsRoute matches (spec §4)", () => {
  it("matches by subject 'TSV Translation Questions'", () => {
    expect(tsvQuestionsRoute.matches(TQ_ENTRY, TQ_MANIFEST)).toBe(true)
  })
  it("matches 'Translation Questions' and 'Study Questions' subjects", () => {
    expect(tsvQuestionsRoute.matches({ ...TQ_ENTRY, subject: "Translation Questions" }, TQ_MANIFEST)).toBe(true)
    expect(tsvQuestionsRoute.matches({ ...TQ_ENTRY, subject: "Study Questions" }, TQ_MANIFEST)).toBe(true)
  })
  it("matches by manifest identifier 'tq' when subject is blank", () => {
    expect(tsvQuestionsRoute.matches({ ...TQ_ENTRY, subject: "" }, TQ_MANIFEST)).toBe(true)
  })
  it("does not match a notes resource", () => {
    const entry = { ...TQ_ENTRY, subject: "TSV Translation Notes" }
    const manifest = { ...TQ_MANIFEST, identifier: "tn" }
    expect(tsvQuestionsRoute.matches(entry, manifest)).toBe(false)
  })
})

describe("tsvQuestionsRoute parse()", () => {
  const parse = () =>
    tsvQuestionsRoute.parse({
      entry: TQ_ENTRY,
      manifest: TQ_MANIFEST,
      files: new Map([["tq_TIT.tsv", TQ_TSV]]),
    })

  it("uses the TSV `ID` column for a stable cell id seeded `repo|book|rowID`", () => {
    const out = parse()
    expect(out).toHaveLength(1)
    expect(out[0].fileId).toBe(dcsFileId("unfoldingWord/en_tq", "tq_TIT.tsv"))
    expect(out[0].bookCode).toBe("TIT")
    expect(out[0].cells[0].cellId).toBe(dcsCellId("unfoldingWord/en_tq|TIT|q001"))
    expect(out[0].cells[1].cellId).toBe(dcsCellId("unfoldingWord/en_tq|TIT|q002"))
  })

  it("combines Question + Response into the value when a Response is present", () => {
    const cells = parse()[0].cells
    expect(cells[0].value).toBe(
      "Question: Whose servant does Paul call himself?\nResponse: Paul calls himself a servant of God.",
    )
    expect(cells[0].contentHash).toBe(contentHash(cells[0].value))
  })

  it("uses just the Question when Response is empty", () => {
    const cells = parse()[0].cells
    expect(cells[1].value).toBe("What did God promise before time began?")
  })

  it("carries the non-prose columns into cell.metadata", () => {
    const cells = parse()[0].cells
    // Only present (non-empty) untranslated columns ride along; Occurrence "0" is present.
    expect(cells[0].metadata).toEqual({ occurrence: "0" })
  })

  it("produces STABLE ids across two independent parses (cross-import lineage)", () => {
    const a = parse()
    const b = parse()
    expect(a[0].cells.map((c) => c.cellId)).toEqual(b[0].cells.map((c) => c.cellId))
  })
})
