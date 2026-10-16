import { describe, expect, it } from "vitest"
import type { DcsCatalogEntry } from "../types"
import { OFFICIAL_GROUP, OTHER_GROUP, resourceChoices, resourceLabel, wantBookPath } from "./door43-choices"

const entry = (owner: string, name: string, subject: string, abbreviation: string, title: string): DcsCatalogEntry => ({
  name, owner, fullName: `${owner}/${name}`, subject, abbreviation, title,
  contentFormat: "", ref: "v1", commitSha: "s", released: "", zipballUrl: "", metadataUrl: "", language: "en",
})

// The real catalog's order for lang=en puts forks first (ru_gt/en_ult before unfoldingWord/en_ult).
const CATALOG = [
  entry("ru_gt", "en_ult", "Aligned Bible", "ult", "unfoldingWord® Literal Text"),
  entry("ru_gt", "en_ust", "Aligned Bible", "ust", "unfoldingWord® Simplified Text"),
  entry("unfoldingWord", "en_tn", "TSV Translation Notes", "tn", "unfoldingWord® Translation Notes"),
  entry("unfoldingWord", "en_ust", "Aligned Bible", "ust", "unfoldingWord® Simplified Text"),
  entry("unfoldingWord", "en_ult", "Aligned Bible", "ult", "unfoldingWord® Literal Text"),
  entry("unfoldingWord", "en_ugg", "Greek Grammar", "ugg", "unfoldingWord Greek Grammar"),
  entry("Worldview", "en_bsb", "Aligned Bible", "bsb", "Berean Standard Bible - Aligned"),
  entry("unfoldingWord", "en_ult", "Aligned Bible", "ult", "unfoldingWord® Literal Text"), // duplicate row
]

describe("Door43 Resource choices", () => {
  it("lists official unfoldingWord resources first (Bibles, then helps, then grammars), forks after under their own heading", () => {
    const out = resourceChoices(CATALOG)
    expect(out.map((c) => [c.group, c.value])).toEqual([
      [OFFICIAL_GROUP, "unfoldingWord/en_ult"],
      [OFFICIAL_GROUP, "unfoldingWord/en_ust"],
      [OFFICIAL_GROUP, "unfoldingWord/en_tn"],
      [OFFICIAL_GROUP, "unfoldingWord/en_ugg"],
      [OTHER_GROUP, "Worldview/en_bsb"],
      [OTHER_GROUP, "ru_gt/en_ult"],
      [OTHER_GROUP, "ru_gt/en_ust"],
    ])
  })

  it("labels by abbreviation, title and owner, so a fork never reads like the original", () => {
    expect(resourceLabel(CATALOG[4])).toBe("ULT — unfoldingWord® Literal Text (unfoldingWord)")
    expect(resourceLabel(CATALOG[0])).toBe("ULT — unfoldingWord® Literal Text (ru_gt)")
  })
})

describe("book selection", () => {
  it("reads only the chosen books' files: no front matter or book-less files (live en_ult TIT pulled A0-FRT.usfm)", () => {
    const tit = new Set(["TIT"])
    expect(wantBookPath("57-TIT.usfm", tit)).toBe(true)
    expect(wantBookPath("tn_TIT.tsv", tit)).toBe(true)
    expect(wantBookPath("A0-FRT.usfm", tit)).toBe(false)
    expect(wantBookPath("41-MAT.usfm", tit)).toBe(false)
    // No book chosen: everything the route owns.
    expect(wantBookPath("A0-FRT.usfm", new Set())).toBe(true)
  })
})
