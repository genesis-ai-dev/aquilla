/**
 * AQU-1937: what the Door43 importer extension adds BEYOND the built-in import —
 * Translation Words Links, Translation Words and word alignment kept as data.
 */

import { describe, expect, it } from "vitest"
import { alignmentsFromWords, specForTwCategory, specForTwl } from "./door43-plan"
import { dcsCellId, dcsFileId } from "../cell-id"
import type { DcsCatalogEntry } from "../types"

const entry = (name: string, subject: string): DcsCatalogEntry => ({
  name, owner: "unfoldingWord", fullName: `unfoldingWord/${name}`, subject, contentFormat: "tsv",
  ref: "v9", refType: "tag", commitSha: "s9", released: "2026-01-01T00:00:00Z", zipballUrl: "z", metadataUrl: "m", language: "en",
})

describe("Translation Words Links (beyond the built-in)", () => {
  it("becomes a reference file of stable rows linking verses to articles", () => {
    const tsv = "Reference\tID\tTags\tOrigWords\tOccurrence\tTWLink\n1:1\tab12\tname\tΠαῦλος\t1\trc://*/tw/dict/bible/names/paul\n1:1\tcd34\tkeyterm\tθεοῦ\t1\trc://*/tw/dict/bible/kt/god\n"
    const spec = specForTwl(entry("en_twl", "TSV Translation Words Links"), "p1", "twl_TIT.tsv", tsv, "TIT")!
    expect(spec.kind).toBe("reference")
    expect(spec.fileId).toBe(dcsFileId("p1", "unfoldingWord/en_twl", "twl_TIT.tsv"))
    expect(spec.cells.map((c) => [c.cellId, c.value, c.ref, (c.metadata as { article: string }).article])).toEqual([
      [dcsCellId("unfoldingWord/en_twl|TIT|ab12"), "Παῦλος", "TIT 1:1", "names/paul"],
      [dcsCellId("unfoldingWord/en_twl|TIT|cd34"), "θεοῦ", "TIT 1:1", "kt/god"],
    ])
    expect(spec.tags).toContain("book:TIT")
  })
})

describe("Translation Words (beyond the built-in)", () => {
  it("becomes one file per category with section-anchored, stable cell ids and tw: refs", () => {
    const blocks = [
      { kind: "heading", level: 1, text: "God", section: "god" },
      { kind: "heading", level: 2, text: "Definition:", section: "definition" },
      { kind: "p", level: 0, text: "The one true God.", section: "definition" },
      { kind: "heading", level: 2, text: "Word Data:", section: "word-data" },
      { kind: "list", level: 0, text: "* Strong's: H430", section: "word-data" },
    ]
    const spec = specForTwCategory(entry("en_tw", "Translation Words"), "p1", "kt", [{ word: "god", blocks }])!
    expect(spec.cells.map((c) => [c.ref, c.type])).toEqual([
      ["tw:kt/god", "heading"], ["tw:kt/god", "heading"], ["tw:kt/god", "text"], ["tw:kt/god", "heading"], ["tw:kt/god", "paratext"],
    ])
    // Editing one section never moves another section's ids.
    const edited = specForTwCategory(entry("en_tw", "Translation Words"), "p1", "kt", [{ word: "god", blocks: [blocks[0], blocks[1], { ...blocks[2], text: "Changed." }, { ...blocks[2], text: "New paragraph." }, blocks[3], blocks[4]] }])!
    const ids = (s: typeof spec) => new Set(s.cells.map((c) => c.cellId))
    for (const id of ids(spec)) expect(ids(edited).has(id)).toBe(true)
  })
})

describe("alignment as data (beyond the built-in)", () => {
  it("groups each verse's target words by the original-word milestones around them", () => {
    const paul = { "x-content": "Παῦλος", "x-strong": "G39720", "x-occurrence": "1", "x-occurrences": "1" }
    const doulos = { "x-content": "δοῦλος", "x-strong": "G14010", "x-occurrence": "1", "x-occurrences": "1" }
    const groups = alignmentsFromWords([
      { ref: "TIT 1:1", words: [
        { text: "Paul", occurrence: 1, milestones: [paul] },
        { text: "a", occurrence: 1, milestones: [doulos] },
        { text: "servant", occurrence: 1, milestones: [doulos] },
        { text: "of", occurrence: 1, milestones: [] },
      ] },
    ])
    expect(groups.get("TIT 1:1")).toEqual([
      { src: [paul], tgt: [{ w: "Paul", occ: 1 }] },
      { src: [doulos], tgt: [{ w: "a", occ: 1 }, { w: "servant", occ: 1 }] },
    ])
  })
})
