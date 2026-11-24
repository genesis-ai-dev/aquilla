import { describe, it, expect } from "vitest"
import { normalizeForNgrams, normalizeWithOffsets, ngramSet, ngramText } from "./char-ngrams"

const texts = (s: string) => [...ngramSet(s)].map(ngramText).sort()

describe("char n-grams", () => {
  it("lowercases, drops punctuation and pads with a space", () => {
    expect(normalizeForNgrams("In the, BEGINNING!")).toBe(" in the beginning ")
    expect(normalizeForNgrams(" ;; ")).toBe("")
    expect(texts("Ab")).toEqual([" ab", "ab "])
  })

  it("reads Han, Kana and Hangul as bigrams and everything else as trigrams", () => {
    expect(texts("銅器")).toEqual([" 銅", "器 ", "銅器"].sort())
    expect(texts("하나님")).toEqual([" 하", "나님", "님 ", "하나"].sort())
    // Mixed text: a window touching a Han character is two long.
    expect(texts("ab 器")).toEqual([" ab", " 器", "ab ", "b 器", "器 "].sort())
    // Thai letters are letters, not syllables: trigrams.
    expect(texts("พระ")).toEqual([" พร", "พระ", "ระ "].sort())
  })

  it("keeps combining marks with their letters", () => {
    expect(normalizeForNgrams("अब्राहामले।")).toBe(" अब्राहामले ")
  })

  it("normalizes composed and decomposed text the same way", () => {
    expect(ngramSet("éte")).toEqual(ngramSet("éte"))
  })

  it("folds word-final sigma so a whole-string and a per-letter lowercase agree", () => {
    expect(normalizeForNgrams("ΛΟΓΟΣ")).toBe(normalizeForNgrams("λογος"))
    expect(normalizeWithOffsets("ΛΟΓΟΣ").text).toBe(normalizeForNgrams("ΛΟΓΟΣ"))
  })

  it("normalizeWithOffsets matches normalizeForNgrams and maps back to the input", () => {
    for (const s of ["In the, BEGINNING!", "並所用的一切銅器皿，", "  İstanbul  ", "태초에 하나님이", "a😀b"]) {
      const n = normalizeWithOffsets(s)
      expect(n.text).toBe(normalizeForNgrams(s))
      expect(n.start).toHaveLength(n.text.length)
    }
    const n = normalizeWithOffsets("Hi, there")
    const i = n.text.indexOf("there")
    expect(n.source.slice(n.start[i], n.end[i + 4])).toBe("there")
  })
})
