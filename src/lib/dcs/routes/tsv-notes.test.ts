import { describe, it, expect } from "vitest"
import { tsvNotesRoute } from "./tsv-notes"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"
import type { DcsCatalogEntry, DcsManifest } from "../types"

const TN_ENTRY: DcsCatalogEntry = {
  name: "en_tn",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_tn",
  subject: "TSV Translation Notes",
  contentFormat: "tsv",
  ref: "v86",
  refType: "tag",
  commitSha: "cafef00d",
  released: "2026-02-01T00:00:00Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

const TN_MANIFEST: DcsManifest = {
  rcType: "help",
  subject: "TSV Translation Notes",
  format: "text/tsv",
  identifier: "tn",
  language: { identifier: "en", title: "English", direction: "ltr" },
  projects: [{ identifier: "tit", path: "./tn_TIT.tsv" }],
}

// A tiny 2-row TN TSV. Columns: Reference ID Tags SupportReference Quote Occurrence Note
const TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tabc1\tgrammar\trc://en/ta/man/figs-abstractnouns\tδοῦλος\t1\tPaul calls himself a servant here.",
  "1:2\txyz9\t\trc://en/ta/man/figs-explicit\tζωῆς\t1\tThe **hope** of eternal life.",
].join("\n")

describe("tsvNotesRoute matches (spec §4)", () => {
  it("matches by subject 'TSV Translation Notes'", () => {
    expect(tsvNotesRoute.matches(TN_ENTRY, TN_MANIFEST)).toBe(true)
  })
  it("matches 'Translation Notes' and 'Study Notes' subjects", () => {
    expect(tsvNotesRoute.matches({ ...TN_ENTRY, subject: "Translation Notes" }, TN_MANIFEST)).toBe(true)
    expect(tsvNotesRoute.matches({ ...TN_ENTRY, subject: "Study Notes" }, TN_MANIFEST)).toBe(true)
  })
  it("matches by manifest identifier 'tn' when subject is blank", () => {
    expect(tsvNotesRoute.matches({ ...TN_ENTRY, subject: "" }, TN_MANIFEST)).toBe(true)
  })
  it("does not match a questions resource", () => {
    const entry = { ...TN_ENTRY, subject: "TSV Translation Questions" }
    const manifest = { ...TN_MANIFEST, identifier: "tq" }
    expect(tsvNotesRoute.matches(entry, manifest)).toBe(false)
  })
})

describe("tsvNotesRoute parse()", () => {
  const parse = () =>
    tsvNotesRoute.parse({
      entry: TN_ENTRY,
      manifest: TN_MANIFEST,
      files: new Map([["tn_TIT.tsv", TN_TSV]]),
    })

  it("uses the TSV `ID` column for a stable cell id seeded `repo|book|rowID`", () => {
    const out = parse()
    expect(out).toHaveLength(1)
    const file = out[0]
    expect(file.fileId).toBe(dcsFileId("unfoldingWord/en_tn", "tn_TIT.tsv"))
    expect(file.bookCode).toBe("TIT")
    expect(file.cells).toHaveLength(2)

    expect(file.cells[0].cellId).toBe(dcsCellId("unfoldingWord/en_tn|TIT|abc1"))
    expect(file.cells[1].cellId).toBe(dcsCellId("unfoldingWord/en_tn|TIT|xyz9"))
  })

  it("makes the `Note` column the translatable value and hashes it", () => {
    const cells = parse()[0].cells
    expect(cells[0].value).toBe("Paul calls himself a servant here.")
    expect(cells[1].value).toBe("The **hope** of eternal life.")
    expect(cells[0].contentHash).toBe(contentHash(cells[0].value))
  })

  it("carries SupportReference/Quote/Occurrence/Tags into cell.metadata (not the value)", () => {
    const cells = parse()[0].cells
    expect(cells[0].metadata).toEqual({
      tags: "grammar",
      supportReference: "rc://en/ta/man/figs-abstractnouns",
      quote: "δοῦλος",
      occurrence: "1",
    })
    // Empty Tags cell is dropped from metadata (only present keys ride along).
    expect(cells[1].metadata).toEqual({
      supportReference: "rc://en/ta/man/figs-explicit",
      quote: "ζωῆς",
      occurrence: "1",
    })
  })

  it("builds canonicalRef `BOOK CH:V` from the Reference column", () => {
    const cells = parse()[0].cells
    expect(cells[0].canonicalRef).toBe("TIT 1:1")
    expect(cells[1].canonicalRef).toBe("TIT 1:2")
  })

  it("unescapes literal \\n in the Note into real newlines (value + hash)", () => {
    // Real en_tn intro-note shape: the TSV cell holds LITERAL backslash-n pairs.
    const tsv = [
      "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
      "front:intro\tint1\t\t\t\t0\t# Introduction to Titus\\n\\n## Part 1: General Introduction",
    ].join("\n")
    const cells = tsvNotesRoute.parse({
      entry: TN_ENTRY,
      manifest: TN_MANIFEST,
      files: new Map([["tn_TIT.tsv", tsv]]),
    })[0].cells
    expect(cells[0].value).toBe("# Introduction to Titus\n\n## Part 1: General Introduction")
    expect(cells[0].value).not.toContain("\\n")
    expect(cells[0].contentHash).toBe(contentHash(cells[0].value))
    // And the markdown renders to headings, not raw `#` syntax.
    expect(cells[0].valueHtml).toBe(
      "<h1>Introduction to Titus</h1><h2>Part 1: General Introduction</h2>",
    )
  })

  it("renders Note markdown to valueHtml, with dead rc://+relative links as text", () => {
    const tsv = [
      "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
      "1:1\tlnk1\t\t\t\t0\tSee [[rc://*/ta/man/translate/figs-metaphor]] and [1:2](../01/02.md) plus **bold**.",
    ].join("\n")
    const cells = tsvNotesRoute.parse({
      entry: TN_ENTRY,
      manifest: TN_MANIFEST,
      files: new Map([["tn_TIT.tsv", tsv]]),
    })[0].cells
    // The plain value keeps the raw markdown (unescaped only) …
    expect(cells[0].value).toContain("[[rc://*/ta/man/translate/figs-metaphor]]")
    // … while the HTML the user sees has readable text, no broken anchors.
    expect(cells[0].valueHtml).toBe("<p>See figs-metaphor and 1:2 plus <b>bold</b>.</p>")
    expect(cells[0].valueHtml).not.toContain("<a")
  })

  it("omits valueHtml when the Note is empty", () => {
    const tsv = [
      "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
      "1:1\temp1\t\t\t\t0\t",
    ].join("\n")
    const cells = tsvNotesRoute.parse({
      entry: TN_ENTRY,
      manifest: TN_MANIFEST,
      files: new Map([["tn_TIT.tsv", tsv]]),
    })[0].cells
    expect(cells[0].value).toBe("")
    expect(cells[0].valueHtml).toBeUndefined()
  })

  it("produces STABLE ids across two independent parses (cross-import lineage)", () => {
    const a = parse()
    const b = parse()
    expect(a[0].cells.map((c) => c.cellId)).toEqual(b[0].cells.map((c) => c.cellId))
    // Note text changing must NOT change the id — the ID column is the seed.
    const changed = tsvNotesRoute.parse({
      entry: TN_ENTRY,
      manifest: TN_MANIFEST,
      files: new Map([
        ["tn_TIT.tsv", TN_TSV.replace("Paul calls himself a servant here.", "REWRITTEN note.")],
      ]),
    })
    expect(changed[0].cells[0].cellId).toBe(a[0].cells[0].cellId)
    expect(changed[0].cells[0].contentHash).not.toBe(a[0].cells[0].contentHash)
  })
})
