// AQU-527 — the reading half of a translation note's untranslated columns.
//
// Fixtures are the real shapes the two importers write: the DCS resource route
// canonicalizes `OrigQuote` → `quote` (src/lib/dcs/routes/tsv-common.ts), the
// direct TSV import writes the same key (src/lib/parsers/translation-notes.ts),
// and an older cell can still carry the raw header name. The Hebrew and Greek
// phrases below are the actual unfoldingWord quotes for GEN 1:1 and MAT 2:1,
// cantillation and accents included — stripping those is what makes a
// first-character script test pass in a test and fail on real data.

import { describe, it, expect } from "vitest"
import {
  detectQuoteScript,
  readNoteReferenceMetadata,
  supportReferenceLabel,
} from "./note-metadata"

const HEBREW_QUOTE = "בְּ⁠רֵאשִׁ֖ית"
const GREEK_QUOTE = "Βηθλέεμ τῆς Ἰουδαίας"

describe("detectQuoteScript", () => {
  it("reads a pointed Hebrew quote as Hebrew", () => {
    expect(detectQuoteScript(HEBREW_QUOTE)).toBe("he")
  })

  it("reads a polytonic Greek quote as ancient Greek", () => {
    expect(detectQuoteScript(GREEK_QUOTE)).toBe("grc")
  })

  it("returns null for a phrase in neither script", () => {
    expect(detectQuoteScript("the heavens")).toBeNull()
    expect(detectQuoteScript("")).toBeNull()
  })

  it("is not thrown off by Latin punctuation around the phrase", () => {
    expect(detectQuoteScript(`"${GREEK_QUOTE}" (v. 1)`)).toBe("grc")
  })

  it("picks the dominant script when a quote mixes both", () => {
    expect(detectQuoteScript(`${HEBREW_QUOTE} ${HEBREW_QUOTE} δὲ`)).toBe("he")
  })
})

describe("readNoteReferenceMetadata", () => {
  it("reads the canonical `quote` key the importers write", () => {
    const read = readNoteReferenceMetadata({ quote: GREEK_QUOTE, occurrence: "1" })
    expect(read.quote).toBe(GREEK_QUOTE)
    expect(read.quoteScript).toBe("grc")
  })

  it("falls back to a legacy `origQuote` key", () => {
    expect(readNoteReferenceMetadata({ origQuote: HEBREW_QUOTE }).quote).toBe(HEBREW_QUOTE)
    expect(readNoteReferenceMetadata({ origquote: HEBREW_QUOTE }).quote).toBe(HEBREW_QUOTE)
  })

  it("trims a padded quote and drops an empty one", () => {
    expect(readNoteReferenceMetadata({ quote: `  ${GREEK_QUOTE}  ` }).quote).toBe(GREEK_QUOTE)
    expect(readNoteReferenceMetadata({ quote: "   " }).quote).toBeNull()
  })

  it("reads no quote — and so no script — from a prose-only note", () => {
    const read = readNoteReferenceMetadata({ supportReference: "rc://*/ta/man/translate/figs-idiom" })
    expect(read.quote).toBeNull()
    expect(read.quoteScript).toBeNull()
  })

  it("treats a missing or non-object bucket as all-null instead of throwing", () => {
    for (const bucket of [null, undefined]) {
      expect(readNoteReferenceMetadata(bucket)).toEqual({
        quote: null,
        quoteScript: null,
        occurrence: null,
        supportReference: null,
      })
    }
  })

  it("surfaces an occurrence only when it singles one out", () => {
    // 1 is the ordinary case and -1 is unfoldingWord's "every occurrence":
    // neither disambiguates anything, so neither earns a marker.
    expect(readNoteReferenceMetadata({ occurrence: "2" }).occurrence).toBe(2)
    expect(readNoteReferenceMetadata({ occurrence: 3 }).occurrence).toBe(3)
    expect(readNoteReferenceMetadata({ occurrence: "1" }).occurrence).toBeNull()
    expect(readNoteReferenceMetadata({ occurrence: "-1" }).occurrence).toBeNull()
    expect(readNoteReferenceMetadata({ occurrence: "0" }).occurrence).toBeNull()
    expect(readNoteReferenceMetadata({ occurrence: "many" }).occurrence).toBeNull()
    expect(readNoteReferenceMetadata({ occurrence: "2.5" }).occurrence).toBeNull()
    expect(readNoteReferenceMetadata({}).occurrence).toBeNull()
  })

  it("reads the support reference, preferring the canonical key over `tags`", () => {
    expect(
      readNoteReferenceMetadata({ supportReference: "rc://*/ta/man/translate/figs-merism", tags: "keyterm" })
        .supportReference,
    ).toBe("rc://*/ta/man/translate/figs-merism")
    expect(readNoteReferenceMetadata({ tags: "keyterm" }).supportReference).toBe("keyterm")
  })
})

describe("supportReferenceLabel", () => {
  it("reduces a resource-container URI to its article name", () => {
    expect(supportReferenceLabel("rc://*/ta/man/translate/figs-merism")).toBe("figs merism")
  })

  it("ignores a trailing slash", () => {
    expect(supportReferenceLabel("rc://*/tw/dict/bible/other/creation/")).toBe("creation")
  })

  it("passes a bare tag through", () => {
    expect(supportReferenceLabel("keyterm")).toBe("keyterm")
  })

  it("falls back to the raw value rather than rendering an empty line", () => {
    expect(supportReferenceLabel("///")).toBe("///")
  })
})
