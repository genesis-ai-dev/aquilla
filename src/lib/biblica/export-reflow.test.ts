import { describe, expect, it } from "vitest"
import {
  expandForceClearWithUntranslatedFollowers,
  findAbandonedSegmentIndexes,
  findUntranslatedInteriorIndexes,
  moveBoldPunctuationSpilloverToBody,
  moveReferenceRunSpilloverToBody,
  reflowBiblicaTargetSlots,
} from "./export-reflow"

describe("moveBoldPunctuationSpilloverToBody", () => {
  const keyTermThenPlain = ["CharacterStyle/k_xt", "CharacterStyle/$ID/[No character style]"]
  const twoBoldHeading = ["CharacterStyle/bold%3astyle", "CharacterStyle/bold%3astyle"]

  it("hands the leftover period back to the plain run after a key term", () => {
    expect(
      moveBoldPunctuationSpilloverToBody(
        ["Davi.", " O rei"],
        ["David", " The king"],
        undefined,
        keyTermThenPlain,
      ),
    ).toEqual(["Davi", ". O rei"])
  })

  it("hands the leftover comma back to the plain run after a key term", () => {
    expect(
      moveBoldPunctuationSpilloverToBody(
        ["Jeoacaz,", " rei de Judá"],
        ["Jehoahaz", " king of Judah"],
        undefined,
        keyTermThenPlain,
      ),
    ).toEqual(["Jeoacaz", ", rei de Judá"])
  })

  it("strips leftover marks when the next run already opens with them", () => {
    expect(
      moveBoldPunctuationSpilloverToBody(
        ["Davi.", ". O rei"],
        ["David", ". The king"],
        undefined,
        keyTermThenPlain,
      ),
    ).toEqual(["Davi", ". O rei"])
  })

  it("does not move punctuation onto a second bold heading slot", () => {
    expect(
      moveBoldPunctuationSpilloverToBody(
        ["Isaías.", "Profeta"],
        ["Isaiah", "Prophet"],
        undefined,
        twoBoldHeading,
      ),
    ).toEqual(["Isaías.", "Profeta"])
  })

  it("leaves leftover punctuation on a plain run", () => {
    expect(
      moveBoldPunctuationSpilloverToBody(
        ["Adão.", " O próximo"],
        ["Adam", " The next"],
        undefined,
        [
          "CharacterStyle/$ID/[No character style]",
          "CharacterStyle/$ID/[No character style]",
        ],
      ),
    ).toEqual(["Adão.", " O próximo"])
  })
})

describe("moveReferenceRunSpilloverToBody", () => {
  it("hands the note body back the word that landed in the reference run", () => {
    expect(
      moveReferenceRunSpilloverToBody(
        ["4:1 – 5:32 A ", "linhagem ", "de Adão."],
        ["4:1 – 5:32", " The ", "lineage of Adam."],
      ),
    ).toEqual(["4:1 – 5:32", " A linhagem ", "de Adão."])
  })

  it("leaves a reference run the translation kept clean", () => {
    const segments = ["4:1 – 5:32", " A linhagem ", "de Adão."]
    expect(
      moveReferenceRunSpilloverToBody(segments, ["4:1 – 5:32", " The ", "lineage of Adam."]),
    ).toEqual(segments)
  })
})

describe("findAbandonedSegmentIndexes", () => {
  it("reports only the gaps enclosed by translated slots", () => {
    expect(
      findAbandonedSegmentIndexes(
        ["Ahijah", " the ", "prophet", " to be king."],
        ["Aías", "", "", "para ser rei."],
      ),
    ).toEqual([1, 2])
  })

  it("keeps the source for slots the cell never rendered a span for", () => {
    expect(
      findAbandonedSegmentIndexes(
        ["Ahijah", " the ", "prophet"],
        ["Aías"],
      ),
    ).toEqual([])
  })

  it("never clears preserved slots such as verse delimiters", () => {
    expect(
      findAbandonedSegmentIndexes(
        ["Some prose", "28", "more prose"],
        ["Algum texto", "", "mais texto"],
        [1],
      ),
    ).toEqual([])
  })
})

describe("expandForceClearWithUntranslatedFollowers", () => {
  it("adds the untranslated slot after each apostrophe", () => {
    expect(
      expandForceClearWithUntranslatedFollowers(
        [1],
        ["Aaron", "ʼ", "s walking stick"],
        ["O cajado de Arão:", "ʼ", "s walking stick"],
      ),
    ).toEqual([1, 2])
  })

  it("leaves an independently translated tail alone", () => {
    expect(
      expandForceClearWithUntranslatedFollowers(
        [1],
        ["Israel", "ʼ", "s covenant history"],
        ["Zmluvné", "", "dejiny Izraela"],
      ),
    ).toEqual([1])
  })
})

describe("findUntranslatedInteriorIndexes", () => {
  it("clears English copied into interior slots when a later run is translated", () => {
    expect(
      findUntranslatedInteriorIndexes(
        ["Ahijah", " the ", "prophet", " to be king."],
        ["Aías", " the ", "prophet", "para ser rei."],
      ),
    ).toEqual([1, 2])
  })

  it("keeps trailing English when nothing after the gap was translated", () => {
    expect(
      findUntranslatedInteriorIndexes(
        ["Ahijah", " the ", "prophet"],
        ["Aías", " the ", "prophet"],
      ),
    ).toEqual([])
  })
})

describe("reflowBiblicaTargetSlots", () => {
  it("clears an untranslated apostrophe tail", () => {
    expect(
      reflowBiblicaTargetSlots({
        originalSlots: ["Aaron", "ʼ", "s walking stick"],
        translatedSlots: ["O cajado de Arão:", "ʼ", "s walking stick"],
        characterStyles: [
          "CharacterStyle/k_xt",
          "CharacterStyle/source serif",
          "CharacterStyle/k_xt",
        ],
        apostropheIndexes: [1],
      }),
    ).toEqual(["O cajado de Arão:", "", ""])
  })

  it("trims leftover bold punctuation onto the following plain run", () => {
    expect(
      reflowBiblicaTargetSlots({
        originalSlots: ["David", ". The king of Israel."],
        translatedSlots: ["Davi.", " O rei de Israel."],
        characterStyles: [
          "CharacterStyle/k_xt",
          "CharacterStyle/$ID/[No character style]",
        ],
        apostropheIndexes: [],
      }),
    ).toEqual(["Davi", ". O rei de Israel."])
  })

  it("drops English key-term runs folded into the first translated slot", () => {
    expect(
      reflowBiblicaTargetSlots({
        originalSlots: ["Ahijah", " the ", "prophet", " to be king over ten of the tribes."],
        translatedSlots: ["Aías", " the ", "prophet", "para ser rei sobre dez das tribos."],
        characterStyles: [
          "CharacterStyle/k_xt",
          "CharacterStyle/$ID/[No character style]",
          "CharacterStyle/k_xt",
          "CharacterStyle/$ID/[No character style]",
        ],
        apostropheIndexes: [],
      }),
    ).toEqual(["Aías", "", "", "para ser rei sobre dez das tribos."])
  })
})
