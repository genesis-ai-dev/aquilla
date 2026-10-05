import { describe, expect, it } from "vitest"
import { foldWord, quoteTokens } from "./normalize"

describe("foldWord (AQU-1573)", () => {
  it("ignores Arabic vowel marks, shadda, sukun and superscript alef", () => {
    expect(foldWord("ٱلْقُدُّوسُ")).toBe(foldWord("القدوس"))
    expect(foldWord("هَٰذَا")).toBe(foldWord("هذا"))
    expect(foldWord("تُشَبِّهُونَنِي")).toBe("تشبهونني")
  })

  it("folds hamza and alef spellings, alef maksura and ta marbuta", () => {
    expect(foldWord("أحب")).toBe(foldWord("احب"))
    expect(foldWord("إلى")).toBe(foldWord("الي"))
    expect(foldWord("آمين")).toBe(foldWord("امين"))
    expect(foldWord("ٱلله")).toBe(foldWord("الله"))
    expect(foldWord("المحبة")).toBe(foldWord("المحبه"))
    expect(foldWord("مؤمن")).toBe(foldWord("مومن"))
    expect(foldWord("ﷲ")).toBe(foldWord("الله"))
  })

  it("removes tatweel, folds Persian letters and digits, and lower-cases", () => {
    expect(foldWord("الـــرب")).toBe(foldWord("الرب"))
    expect(foldWord("کی")).toBe(foldWord("كي"))
    expect(foldWord("٣١")).toBe("31")
    expect(foldWord("LORD")).toBe(foldWord("Lord"))
  })
})

describe("quoteTokens (AQU-1573)", () => {
  it("splits on punctuation and keeps the original offsets", () => {
    const text = "«فَبِمَنْ تُشَبِّهُونَنِي؟» يَقُولُ"
    const tokens = quoteTokens(text)
    expect(tokens.map((t) => t.norm)).toEqual(["فبمن", "تشبهونني", "يقول"])
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe("تُشَبِّهُونَنِي")
  })

  it("treats an apostrophe as a word break on both sides alike", () => {
    expect(quoteTokens("the LORD's house").map((t) => t.norm)).toEqual(["the", "lord", "s", "house"])
  })
})
