import { describe, it, expect } from "vitest"
import {
  findLowercaseStarts,
  findMixedCaseWords,
  hasCasedLetters,
  isMixedCase,
  learnCaseExceptions,
  mixedCasePrefix,
} from "./capitalization"

const codes = (text: string): string[] => findLowercaseStarts(text).map((s) => s.code)
const words = (text: string): string[] => findLowercaseStarts(text).map((s) => s.matchedText)

describe("hasCasedLetters", () => {
  it("is true for Latin and Cyrillic, false for caseless scripts", () => {
    expect(hasCasedLetters("He went.")).toBe(true)
    expect(hasCasedLetters("Он пошёл.")).toBe(true)
    expect(hasCasedLetters("وَقَالَ لَهُ.")).toBe(false) // Arabic
    expect(hasCasedLetters("וַיֹּאמֶר לוֹ")).toBe(false) // Hebrew
    expect(hasCasedLetters("ဘုရားသခင်")).toBe(false) // Burmese
    expect(hasCasedLetters("他说。")).toBe(false) // Han
    expect(hasCasedLetters("1234 — ...")).toBe(false)
  })

  it("is true for a cased word inside otherwise caseless text", () => {
    expect(hasCasedLetters("ويقول Jesus لهم")).toBe(true)
  })
})

describe("findLowercaseStarts — lowercase after sentence-final punctuation", () => {
  it("flags the acceptance-criterion sentence", () => {
    const spans = findLowercaseStarts("He went. then he left.")
    expect(spans).toHaveLength(1)
    expect(spans[0].code).toBe("lowercase-after-terminator")
    expect(spans[0].matchedText).toBe("then")
    expect("He went. then he left.".slice(spans[0].start, spans[0].end)).toBe("then")
  })

  it("accepts a correctly capitalized sentence", () => {
    expect(findLowercaseStarts("He went. Then he left.")).toEqual([])
  })

  it("flags after ! and ? and non-Latin terminators", () => {
    expect(codes("Stop! wait here.")).toEqual(["lowercase-after-terminator"])
    expect(codes("Who said that? he asked.")).toEqual(["lowercase-after-terminator"])
    expect(codes("सो गया। वह चला गया।")).toEqual([]) // Devanagari is caseless
  })

  it("looks past closing quotes and brackets", () => {
    expect(words('"Come here." she said.')).toEqual(["she"])
    expect(words("(He left.) then silence.")).toEqual(["then"])
  })

  it("leaves a colon or semicolon alone — lowercase after them is prose", () => {
    expect(findLowercaseStarts("He said: come here.")).toEqual([])
    expect(findLowercaseStarts("He left; she stayed.")).toEqual([])
  })

  it("leaves an ellipsis alone — it trails off, it does not end a sentence", () => {
    expect(findLowercaseStarts("He waited... then he left.")).toEqual([])
    expect(findLowercaseStarts("He waited… then he left.")).toEqual([])
  })

  it("leaves abbreviations, initials and numbered lists alone", () => {
    expect(findLowercaseStarts("Bring food, e.g. bread and fish.")).toEqual([])
    expect(findLowercaseStarts("See cf. the earlier verse.")).toEqual([])
    expect(findLowercaseStarts("J. smith wrote it.")).toEqual([])
    expect(findLowercaseStarts("1. then he left")).toEqual([])
  })

  it("does not flag a decimal number or a mid-word period", () => {
    expect(findLowercaseStarts("It cost 1.5 denarii.")).toEqual([])
    expect(findLowercaseStarts("see www.example.com for more")).toEqual([])
  })

  it("reports every offender in one text, in order", () => {
    const spans = findLowercaseStarts("He went. then he left. and stayed away.")
    expect(spans.map((s) => s.matchedText)).toEqual(["then", "and"])
    expect(spans[0].start).toBeLessThan(spans[1].start)
  })
})

describe("findLowercaseStarts — lowercase after a paragraph or heading marker", () => {
  it("flags a lowercase word opening a paragraph, poetry line or heading", () => {
    expect(codes("\\p then he left")).toEqual(["lowercase-after-marker"])
    expect(codes("\\q1 and he sang")).toEqual(["lowercase-after-marker"])
    expect(codes("\\s1 the call of Simon")).toEqual(["lowercase-after-marker"])
  })

  it("accepts a capitalized word after the same markers", () => {
    expect(findLowercaseStarts("\\p Then he left")).toEqual([])
    expect(findLowercaseStarts("\\s1 The call of Simon")).toEqual([])
  })

  it("ignores markers that do not open a paragraph or heading", () => {
    expect(findLowercaseStarts("\\v 3 and he left")).toEqual([])
    expect(findLowercaseStarts("\\add then\\add*")).toEqual([])
  })
})

describe("caseless scripts produce no findings", () => {
  it("returns nothing for Arabic, Hebrew, Burmese and Han text", () => {
    for (const text of [
      "وَقَالَ لَهُ. وَذَهَبَ.",
      "וַיֹּאמֶר לוֹ. וַיֵּלֶךְ.",
      "ဘုရားသခင်။ ထိုအခါ။",
      "他说。然后他走了。",
    ]) {
      expect(findLowercaseStarts(text)).toEqual([])
      expect(findMixedCaseWords(text)).toEqual([])
    }
  })
})

describe("isMixedCase / mixedCasePrefix", () => {
  it("recognizes a capital after a lowercase letter", () => {
    expect(isMixedCase("tHe")).toBe(true)
    expect(isMixedCase("kiSwahili")).toBe(true)
    expect(isMixedCase("McDonald")).toBe(true)
    expect(isMixedCase("iPhone")).toBe(true)
  })

  it("is not fooled by ordinary words, ALL CAPS, or compounds", () => {
    expect(isMixedCase("The")).toBe(false)
    expect(isMixedCase("LORD")).toBe(false)
    expect(isMixedCase("Anglo-Saxon")).toBe(false)
    expect(isMixedCase("O’Brien")).toBe(false)
    expect(isMixedCase("O'Brien")).toBe(false)
  })

  it("reads the lowercase prefix a form opens with", () => {
    expect(mixedCasePrefix("kiSwahili")).toBe("ki")
    expect(mixedCasePrefix("tHe")).toBe("t")
    expect(mixedCasePrefix("McDonald")).toBeNull()
  })
})

describe("findMixedCaseWords", () => {
  it("finds the offending word with its offsets", () => {
    const text = "He said tHe word"
    const spans = findMixedCaseWords(text)
    expect(spans).toHaveLength(1)
    expect(spans[0].code).toBe("mixed-case")
    expect(text.slice(spans[0].start, spans[0].end)).toBe("tHe")
  })

  it("skips an excepted form and an excepted prefix family", () => {
    expect(findMixedCaseWords("the kiSwahili word", new Set(["kiSwahili"]))).toEqual([])
    expect(findMixedCaseWords("the kiNgozi word", new Set(["ki-"]))).toEqual([])
    expect(findMixedCaseWords("the tHe word", new Set(["ki-"])).map((s) => s.matchedText)).toEqual(["tHe"])
  })

  it("treats a USFM marker as markup, not a word", () => {
    expect(findMixedCaseWords("\\zaln-s |x-strong=\"H1234\"\\*")).toEqual([])
  })
})

describe("learnCaseExceptions", () => {
  it("excepts a form that recurs often enough, and proposes it", () => {
    const targets = ["kiSwahili ni lugha", "wanasema kiSwahili", "kiSwahili tena", "hii ni tHe typo"]
    const { exceptions, proposals } = learnCaseExceptions(targets)
    expect(exceptions.has("kiSwahili")).toBe(true)
    expect(proposals.some((p) => p.form === "kiSwahili" && p.occurrences === 3)).toBe(true)
    // The one-off typo is neither excepted nor proposed.
    expect(exceptions.has("tHe")).toBe(false)
    expect(findMixedCaseWords(targets[3], exceptions).map((s) => s.matchedText)).toEqual(["tHe"])
  })

  it("excepts a whole lowercase-prefix family, including a member seen once", () => {
    const targets = ["kiSwahili", "kiNgozi", "kiSwahili tena", "na kiZulu"]
    const { exceptions, proposals } = learnCaseExceptions(targets)
    expect(exceptions.has("ki-")).toBe(true)
    const family = proposals.find((p) => p.form === "ki-")!
    expect(family.occurrences).toBe(4)
    expect(family.examples).toEqual(["kiNgozi", "kiSwahili", "kiZulu"])
    // The rare member rides the family exception rather than being flagged.
    expect(findMixedCaseWords("na kiZulu", exceptions)).toEqual([])
    // Proposed once, not per form.
    expect(proposals.filter((p) => p.form.startsWith("ki")).map((p) => p.form)).toEqual(["ki-"])
  })

  it("excepts a form the source already writes that way, without proposing it", () => {
    const { exceptions, proposals } = learnCaseExceptions(["Buy an iPhone"], ["Buy an iPhone"])
    expect(exceptions.has("iPhone")).toBe(true)
    expect(proposals).toEqual([])
  })

  it("learns nothing from a caseless-script project", () => {
    const { exceptions, proposals } = learnCaseExceptions([
      "وَقَالَ لَهُ",
      "וַיֹּאמֶר לוֹ",
      "他说。",
    ])
    expect(exceptions.size).toBe(0)
    expect(proposals).toEqual([])
  })

  it("honours a caller-supplied threshold", () => {
    const { exceptions } = learnCaseExceptions(["tHe", "tHe"], [], { minOccurrences: 2, minFamilyForms: 99 })
    expect(exceptions.has("tHe")).toBe(true)
  })
})
