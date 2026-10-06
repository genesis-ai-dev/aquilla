// AQU-1689 — Who's Who, which source cells can carry word tints.
//
// What this protects: a tint on the wrong word is worse than no tint. A cell
// gets word tints only when its words are the pack's words for its verses,
// one for one. A Macula import is the case this exists for; an English (BSB)
// source never qualifies, and anything doubtful falls back to no tints.

import { describe, expect, it } from "vitest"
import { AUTON_4_10, jhn4Text, maculaImportText } from "./__fixtures__/jhn4"
import {
  alignToPackWords,
  isOriginalLanguageTag,
  normalizeOriginalForm,
  packWordsFor,
} from "./macula-alignment"

const text = jhn4Text()

describe("alignToPackWords", () => {
  it("maps every word of a Macula-imported verse to its Macula word id", () => {
    const cell = maculaImportText(text, "JHN 4:10")
    const result = alignToPackWords(cell, packWordsFor(text, ["JHN 4:10"]))
    if (!result.ok) throw new Error(result.reason)
    expect(result.words).toHaveLength(30)
    const auton = result.words.find((word) => word.wordId === AUTON_4_10)
    expect(auton && cell.slice(auton.start, auton.end)).toBe("αὐτὸν")
  })

  it("accepts the same words with another edition's punctuation, accents and capitals", () => {
    const cell = "ἦν δὲ ἐκεῖ πηγὴ τοῦ Ἰακώβ. ὁ οὖν Ἰησοῦς κεκοπιακώς ἐκ τῆς ὁδοιπορίας ἐκαθέζετο οὕτως ἐπὶ τῇ πηγῇ· ὥρα ἦν ὡς ἕκτη."
    const result = alignToPackWords(cell, packWordsFor(text, ["JHN 4:6"]))
    expect(result.ok).toBe(true)
  })

  it("maps a bridge cell across its verses, in order", () => {
    const cell = `${maculaImportText(text, "JHN 4:7")} ${maculaImportText(text, "JHN 4:8")}`
    const result = alignToPackWords(cell, packWordsFor(text, ["JHN 4:7", "JHN 4:8"]))
    if (!result.ok) throw new Error(result.reason)
    expect(result.words[0].wordId).toBe("n43004007001")
    expect(result.words[result.words.length - 1].wordId).toBe("n43004008011")
  })

  it("gives an English source no tints", () => {
    // The BSB verse happens to have 30 words, as the Greek does: the forms
    // still tell them apart.
    const bsb = "Jesus answered, “If you knew the gift of God and who is asking you for a drink, you would have asked Him, and He would have given you living water.”"
    const result = alignToPackWords(bsb, packWordsFor(text, ["JHN 4:10"]))
    expect(result.ok).toBe(false)
    expect(alignToPackWords("Jesus answered", packWordsFor(text, ["JHN 4:10"]))).toEqual({
      ok: false,
      reason: "count-mismatch",
    })
  })

  it("gives a cell that holds only part of its verse no tints", () => {
    const half = maculaImportText(text, "JHN 4:10").split(" ").slice(0, 15).join(" ")
    expect(alignToPackWords(half, packWordsFor(text, ["JHN 4:10"]))).toEqual({ ok: false, reason: "count-mismatch" })
  })

  it("gives no tints when one word differs, even with the count right", () => {
    const words = maculaImportText(text, "JHN 4:10").split(" ")
    words[23] = "αὐτῷ"
    expect(alignToPackWords(words.join(" "), packWordsFor(text, ["JHN 4:10"]))).toEqual({
      ok: false,
      reason: "form-mismatch",
    })
  })

  it("leaves USFM-marked text alone, and a verse the pack lacks", () => {
    expect(alignToPackWords("\\w Ἰησοῦς\\w*", packWordsFor(text, ["JHN 4:10"]))).toEqual({ ok: false, reason: "markup" })
    expect(packWordsFor(text, ["JHN 4:11"])).toBeNull()
    expect(alignToPackWords("ἀπεκρίθη", null)).toEqual({ ok: false, reason: "no-words" })
  })
})

describe("normalizeOriginalForm", () => {
  it("folds accents, breathings, case, final sigma and punctuation", () => {
    expect(normalizeOriginalForm("Αὐτὸν,")).toBe(normalizeOriginalForm("αὐτόν"))
    expect(normalizeOriginalForm("Ἰωάννου.")).toBe("ιωαννου")
    expect(normalizeOriginalForm("ς")).toBe("σ")
    expect(normalizeOriginalForm("·")).toBe("")
  })
})

describe("isOriginalLanguageTag", () => {
  it("knows the Greek and Hebrew codes, and nothing else", () => {
    expect(["grc", "ell", "hbo", "heb"].every(isOriginalLanguageTag)).toBe(true)
    expect(["eng", "ind", "", "el"].some(isOriginalLanguageTag)).toBe(false)
  })
})
