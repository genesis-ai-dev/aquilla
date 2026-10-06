import { describe, expect, it } from "vitest"
import { SOLID_MIN_PAIRS } from "./bridge-compose"
import { directTokenLinks, EXACT_PAIRS, spansFromLinks, targetSpans, wordsFromSpans } from "./bridge-mentions"

// JHN 4:7, BSB: "… Jesus said to her, “Give Me a drink.”" (tokens 8–15).
const TEXT = "When a Samaritan woman came to draw water, Jesus said to her, “Give Me a drink.”"
const AUTH = "n43004007009" // αὐτῇ
const JESUS = "n43004007011" // Ἰησοῦς
const MOI = "n43004007013" // μοι
const everyone = () => true

describe("from token links to the words Who's Who draws", () => {
  it("draws one Greek word on adjacent tokens as one span: αὐτῇ is “to her”", () => {
    const spans = spansFromLinks(
      [
        { wordId: AUTH, token: 10, conf: 0.2 },
        { wordId: AUTH, token: 11, conf: 0.71 },
      ],
      SOLID_MIN_PAIRS,
      everyone,
    )
    expect(spans).toEqual([{ wordId: AUTH, firstToken: 10, lastToken: 11, conf: 0.71, approximate: false }])
    expect(wordsFromSpans(TEXT, spans)!.map((word) => TEXT.slice(word.start, word.end))).toEqual(["to her"])
  })

  it("gives a token two Greek words claim to the more confident one", () => {
    const spans = spansFromLinks(
      [
        { wordId: JESUS, token: 8, conf: 0.4 },
        { wordId: MOI, token: 8, conf: 0.9 },
      ],
      SOLID_MIN_PAIRS,
      everyone,
    )
    expect(spans.map((span) => span.wordId)).toEqual([MOI])
  })

  it("draws a link below the threshold, or from a short book, as approximate", () => {
    const links = [
      { wordId: JESUS, token: 8, conf: 0.9 },
      { wordId: MOI, token: 13, conf: 0.3 },
    ]
    expect(spansFromLinks(links, SOLID_MIN_PAIRS, everyone).map((span) => span.approximate)).toEqual([false, true])
    expect(spansFromLinks(links, 54, everyone).map((span) => span.approximate)).toEqual([true, true])
  })

  it("keeps only the words Who's Who asks for (the mentions)", () => {
    const spans = spansFromLinks([{ wordId: JESUS, token: 8, conf: 0.9 }, { wordId: "n43004007008", token: 9, conf: 0.9 }], SOLID_MIN_PAIRS, (id) => id === JESUS)
    expect(spans.map((span) => span.wordId)).toEqual([JESUS])
  })

  it("places nothing when the text has fewer tokens than the links expect", () => {
    expect(wordsFromSpans("Jesus said", spansFromLinks([{ wordId: MOI, token: 13, conf: 0.9 }], SOLID_MIN_PAIRS, everyone))).toBeNull()
  })

  it("treats a Greek source's own words as certain links to its tokens", () => {
    const text = "λέγει αὐτῇ ὁ Ἰησοῦς· Δός μοι πεῖν·"
    const links = directTokenLinks(text, [{ start: 13, end: 20, wordId: JESUS }])
    expect(links).toEqual([{ wordId: JESUS, token: 3, conf: 1 }])
    expect(spansFromLinks(links, EXACT_PAIRS, everyone)[0].approximate).toBe(false)
  })

  it("carries a word through both bridges onto the target, with the smaller training size", () => {
    const spans = targetSpans(
      { links: [{ wordId: JESUS, token: 8, conf: 0.9 }], trainedPairs: EXACT_PAIRS },
      { links: [{ src: 8, tgt: 0, conf: 0.9 }], trainedPairs: 30 },
      everyone,
    )
    // 0.81 is confident, but Bridge 2 learned from only 30 verses.
    expect(spans).toEqual([{ wordId: JESUS, firstToken: 0, lastToken: 0, conf: 0.9 * 0.9, approximate: true }])
  })
})
