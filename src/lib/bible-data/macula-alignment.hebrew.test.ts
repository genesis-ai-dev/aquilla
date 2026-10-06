// AQU-1700 — Who's Who word tints on a Hebrew source.
//
// What this protects: a Hebrew source cell gets the pack's facts on exactly
// the right letters, or none at all. Aquilla's Macula import keeps one token
// per morpheme, so each morpheme maps to its own token; a source that writes
// whole words maps every morpheme of a word to that word. Either way RUT
// 1:16's suffix ־ִי "me", which the pack says is Ruth, lands on בִּי. The
// cell text comes from the real importer (parseMaculaTsv) over Macula's own
// rows, so a change in either side of that contract fails here.

import { describe, expect, it } from "vitest"
import { parseMaculaTsv } from "@/lib/parsers/macula"
import {
  BI_1_16,
  IMPLIED_ARTICLE_1_1,
  MACULA_HEBREW_RUT_1_TSV,
  ME_1_16,
  maculaHebrewImportText,
  rutText,
} from "./__fixtures__/ot-pack12"
import { alignToPackWords, packWordsFor, type AlignedWord } from "./macula-alignment"
import type { BkpTextLayer } from "./pack-types"

const text = rutText()

/** The cell a Macula Hebrew import makes for a verse, through the importer itself. */
function importedCell(ref: string): string {
  const parsed = parseMaculaTsv(MACULA_HEBREW_RUT_1_TSV)
  const verse = parsed.strings.find((string) => string.group === ref)
  if (!verse) throw new Error(`the import has no ${ref}`)
  return verse.original
}

/**
 * The verse as a text that writes whole words (UHB or WLC through USFM):
 * each morpheme followed by what Macula keeps after it, so prefixes and
 * suffixes join their host, and the maqaf and sof pasuq stay.
 */
function surfaceText(layer: BkpTextLayer, ref: string): string {
  return layer.verses[ref].map((id) => layer.words[id].text + layer.words[id].after).join("").trim()
}

function spanOf(cell: string, words: readonly AlignedWord[], wordId: string): string | undefined {
  const word = words.find((candidate) => candidate.wordId === wordId)
  return word && cell.slice(word.start, word.end)
}

describe("a Macula Hebrew import: one token per morpheme", () => {
  it("is what the importer stores: the morphemes with letters, spaced", () => {
    // The fixture helper must agree with the importer, or other tests test the wrong cell.
    expect(importedCell("RUT 1:16")).toBe(maculaHebrewImportText(text, "RUT 1:16"))
  })

  it("puts RUT 1:16's 'me' (Ruth) on its own suffix, and the preposition on its own", () => {
    const cell = importedCell("RUT 1:16")
    const result = alignToPackWords(cell, packWordsFor(text, ["RUT 1:16"]))
    if (!result.ok) throw new Error(result.reason)
    expect(result.words).toHaveLength(text.verses["RUT 1:16"].length)
    expect(spanOf(cell, result.words, ME_1_16)).toBe("י")
    expect(spanOf(cell, result.words, BI_1_16)).toBe("בִ֔")
  })

  it("gives an implied article no token, and maps every other morpheme of RUT 1:1", () => {
    const cell = importedCell("RUT 1:1")
    const result = alignToPackWords(cell, packWordsFor(text, ["RUT 1:1"]))
    if (!result.ok) throw new Error(result.reason)
    expect(result.words.map((word) => word.wordId)).not.toContain(IMPLIED_ARTICLE_1_1)
    expect(result.words).toHaveLength(text.verses["RUT 1:1"].length - 1)
  })
})

describe("a Hebrew text written as whole words", () => {
  it("puts RUT 1:16's 'me' (Ruth) on its host word בִּי, which it shares with the preposition", () => {
    const cell = surfaceText(text, "RUT 1:16")
    const word = (id: string) => text.words[id].text
    const result = alignToPackWords(cell, packWordsFor(text, ["RUT 1:16"]))
    if (!result.ok) throw new Error(result.reason)
    const host = word(BI_1_16) + word(ME_1_16)
    expect(cell).toContain(host)
    expect(spanOf(cell, result.words, ME_1_16)).toBe(host)
    expect(spanOf(cell, result.words, BI_1_16)).toBe(host)
    // אַל־תִּפְגְּעִי־בִּי is three words: the maqaf separates them as a space would.
    expect(cell).toContain(`${word("o080010160031")}־${word("o080010160041")}־${host}`)
    expect(spanOf(cell, result.words, "o080010160031")).toBe(word("o080010160031"))
    // Every morpheme of the verse is placed.
    expect(result.words).toHaveLength(text.verses["RUT 1:16"].length)
  })

  it("reads UHB's word joiners (U+2060) inside a word as part of it", () => {
    const joined = text.verses["RUT 1:16"]
      .map((id, i, ids) => {
        const word = text.words[id]
        const sameWord = ids[i + 1]?.slice(0, 12) === id.slice(0, 12)
        return word.text + (sameWord ? "\u2060" : word.after)
      })
      .join("")
    const result = alignToPackWords(joined, packWordsFor(text, ["RUT 1:16"]))
    if (!result.ok) throw new Error(result.reason)
    expect(spanOf(joined, result.words, ME_1_16)).toBe(`${text.words[BI_1_16].text}\u2060${text.words[ME_1_16].text}`)
  })

  it("gives the implied article its host word, as every morpheme of a word", () => {
    const cell = surfaceText(text, "RUT 1:1")
    const result = alignToPackWords(cell, packWordsFor(text, ["RUT 1:1"]))
    if (!result.ok) throw new Error(result.reason)
    // בָּאָרֶץ "in the land": the preposition, the article it swallowed, and the noun.
    const land = text.words["o080010010071"].text + text.words["o080010010072"].text
    expect(spanOf(cell, result.words, IMPLIED_ARTICLE_1_1)).toBe(land)
    expect(spanOf(cell, result.words, "o080010010072")).toBe(land)
  })
})

describe("anything doubtful gets no tints", () => {
  it("refuses a Hebrew cell with one word changed, whole words or morphemes", () => {
    const morphemes = importedCell("RUT 1:16").split(" ")
    morphemes[1] = "וַיֹּאמֶר"
    expect(alignToPackWords(morphemes.join(" "), packWordsFor(text, ["RUT 1:16"]))).toEqual({
      ok: false,
      reason: "form-mismatch",
    })
    // Naomi for Ruth: the same count of words, one form different.
    const words = surfaceText(text, "RUT 1:16").replace(text.words["o080010160021"].text, "נָעֳמִי")
    expect(alignToPackWords(words, packWordsFor(text, ["RUT 1:16"]))).toEqual({ ok: false, reason: "form-mismatch" })
  })

  it("refuses a cell that holds half of the verse", () => {
    const half = importedCell("RUT 1:16").split(" ").slice(0, 10).join(" ")
    expect(alignToPackWords(half, packWordsFor(text, ["RUT 1:16"]))).toEqual({ ok: false, reason: "count-mismatch" })
  })
})
