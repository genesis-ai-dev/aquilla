// Tests for the Macula Hebrew + Greek TSV parser (AQU-178)

import { describe, it, expect } from "vitest"
import { parseMaculaTsv } from "./macula"

// Minimal Hebrew TSV fixture (3 words in GEN 1:1, 2 words in GEN 1:2)
const HEBREW_FIXTURE = `ref\ttext\tlemma\tmorph\tstrongnumber
GEN 1:1!1\tבְּרֵאשִׁ֖ית\tרֵאשִׁית\tHR/Ncfsa\tH7225
GEN 1:1!2\tבָּרָ֣א\tבָּרָא\tHVqp3ms\tH1254
GEN 1:1!3\tאֱלֹהִ֑ים\tאֱלֹהִים\tHNcmpa\tH430
GEN 1:2!1\tוְהָאָ֗רֶץ\tאֶרֶץ\tHHC/Ncfsa\tH776
GEN 1:2!2\tהָיְתָ֥ה\tהָיָה\tHVqp3fs\tH1961`

// Minimal Greek NT fixture (2 words in MAT 1:1, 2 in MAT 1:2)
const GREEK_FIXTURE = `ref\ttext\tlemma\tmorph\tstrongnumber
MAT 1:1!1\tΒίβλος\tβίβλος\tN-NFS\tG976
MAT 1:1!2\tγενέσεως\tγένεσις\tN-GFS\tG1078
MAT 1:2!1\tἈβραὰμ\tἈβραάμ\tN-NMS-P\tG11
MAT 1:2!2\tἐγέννησεν\tγεννάω\tVIAA-3S\tG1080`

// Fixture with BOM prefix
const BOM_FIXTURE = "﻿" + HEBREW_FIXTURE

// Fixture with Windows CRLF line endings
const CRLF_FIXTURE = HEBREW_FIXTURE.replace(/\n/g, "\r\n")

// Fixture with columns in a different order
const REORDERED_FIXTURE = `strongnumber\tmorph\ttext\tlemma\tref
H7225\tHR/Ncfsa\tבְּרֵאשִׁ֖ית\tרֵאשִׁית\tGEN 1:1!1
H1254\tHVqp3ms\tבָּרָ֣א\tבָּרָא\tGEN 1:1!2`

// Fixture with bare Strong's numbers (no H/G prefix)
const BARE_STRONGS_HEBREW = `ref\ttext\tlemma\tmorph\tstrongnumber
GEN 1:1!1\tבְּרֵאשִׁ֖ית\tרֵאשִׁית\tHR/Ncfsa\t7225`

const BARE_STRONGS_GREEK = `ref\ttext\tlemma\tmorph\tstrongnumber
MAT 1:1!1\tΒίβλος\tβίβλος\tN-NFS\t976`

describe("parseMaculaTsv — Hebrew fixture", () => {
  it("parses verse count correctly", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    expect(result.strings).toHaveLength(2) // GEN 1:1 and GEN 1:2
  })

  it("detects Hebrew book code and sourceLanguage", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    expect(result.bookCode).toBe("GEN")
    expect(result.sourceLanguage).toBe("hbo")
  })

  it("reconstructs verse text by joining surface forms", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    // GEN 1:1 has 3 words
    expect(result.strings[0].original).toBe("בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים")
    // GEN 1:2 has 2 words
    expect(result.strings[1].original).toBe("וְהָאָ֗רֶץ הָיְתָ֥ה")
  })

  it("sets globalReferences and group to the verse ref", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    expect(result.strings[0].globalReferences).toEqual(["GEN 1:1"])
    expect(result.strings[0].group).toBe("GEN 1:1")
  })

  it("sets section to book+chapter", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    expect(result.strings[0].section).toBe("GEN 1")
  })

  it("emits morph rows parallel to strings", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    expect(result.morphRows).toHaveLength(2)
    // GEN 1:1 has 3 words
    expect(result.morphRows[0]).toHaveLength(3)
    // GEN 1:2 has 2 words
    expect(result.morphRows[1]).toHaveLength(2)
  })

  it("populates word_seq as 1-based index", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    const verse1 = result.morphRows[0]
    expect(verse1[0].word_seq).toBe(1)
    expect(verse1[1].word_seq).toBe(2)
    expect(verse1[2].word_seq).toBe(3)
  })

  it("carries lemma, morph_code, and strongs_h on Hebrew words", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    const word1 = result.morphRows[0][0]
    expect(word1.surface).toBe("בְּרֵאשִׁ֖ית")
    expect(word1.lemma).toBe("רֵאשִׁית")
    expect(word1.morph_code).toBe("HR/Ncfsa")
    expect(word1.strongs_h).toBe("H7225")
    expect(word1.strongs_g).toBeUndefined()
  })

  it("each string has a unique id (uuidv7)", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    const ids = result.strings.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("parseMaculaTsv — Greek fixture", () => {
  it("detects Greek book code and sourceLanguage", () => {
    const result = parseMaculaTsv(GREEK_FIXTURE)
    expect(result.bookCode).toBe("MAT")
    expect(result.sourceLanguage).toBe("grc")
  })

  it("carries strongs_g on Greek words (not strongs_h)", () => {
    const result = parseMaculaTsv(GREEK_FIXTURE)
    const word1 = result.morphRows[0][0]
    expect(word1.strongs_g).toBe("G976")
    expect(word1.strongs_h).toBeUndefined()
  })
})

describe("parseMaculaTsv — robustness", () => {
  it("handles UTF-8 BOM prefix", () => {
    const result = parseMaculaTsv(BOM_FIXTURE)
    expect(result.strings).toHaveLength(2)
    expect(result.bookCode).toBe("GEN")
  })

  it("handles Windows CRLF line endings", () => {
    const result = parseMaculaTsv(CRLF_FIXTURE)
    expect(result.strings).toHaveLength(2)
  })

  it("handles columns in a different order", () => {
    const result = parseMaculaTsv(REORDERED_FIXTURE)
    expect(result.strings).toHaveLength(1)
    expect(result.strings[0].original).toBe("בְּרֵאשִׁ֖ית בָּרָ֣א")
    expect(result.morphRows[0][0].strongs_h).toBe("H7225")
  })

  it("adds H prefix to bare Hebrew Strong's numbers", () => {
    const result = parseMaculaTsv(BARE_STRONGS_HEBREW)
    expect(result.morphRows[0][0].strongs_h).toBe("H7225")
  })

  it("adds G prefix to bare Greek Strong's numbers", () => {
    const result = parseMaculaTsv(BARE_STRONGS_GREEK)
    expect(result.morphRows[0][0].strongs_g).toBe("G976")
  })

  it("throws on empty input", () => {
    expect(() => parseMaculaTsv("")).toThrow()
  })

  it("throws on header-only TSV with no data rows", () => {
    // Providing only a header (one line) is treated as empty input.
    // With header + one empty-text data row, we get no verse data.
    expect(() => parseMaculaTsv("ref\ttext\tlemma")).toThrow()
    // A header plus a data row with empty text → no verse data
    expect(() => parseMaculaTsv("ref\ttext\tlemma\n\t\t")).toThrow(/no verse data found/)
  })

  it("throws when ref column is missing", () => {
    expect(() => parseMaculaTsv("word\tlemma\tmorph\nfoo\tbar\tbaz")).toThrow(
      /no 'ref' or 'xml_id' column/,
    )
  })

  it("throws when text column is missing", () => {
    expect(() => parseMaculaTsv("ref\tlemma\tmorph\nGEN 1:1!1\tbar\tbaz")).toThrow(
      /no 'text' or 'word' column/,
    )
  })

  it("type is 'verse' for all strings", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    for (const s of result.strings) {
      expect(s.type).toBe("verse")
    }
  })

  it("translated starts empty", () => {
    const result = parseMaculaTsv(HEBREW_FIXTURE)
    for (const s of result.strings) {
      expect(s.translated).toBe("")
    }
  })
})
