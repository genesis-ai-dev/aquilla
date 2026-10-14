import { describe, it, expect } from "vitest"
import { tokenize, tokenSpans } from "./tokenize"
import { tokenize as interlinearTokenize } from "./interlinear"

describe("tokenize — combining marks stay inside the word (AQU-462, AQU-1190)", () => {
  it("keeps each pointed Hebrew word whole", () => {
    // Genesis 1:1 in Macula/OSHB pointing. The defect cut this into eleven
    // single-consonant fragments: ["ב","ר","אש","ית","ב","ר","א","א","ל","ה","ים"].
    expect(tokenize("בְּרֵאשִׁית בָּרָא אֱלֹהִים")).toHaveLength(3)
  })

  it("keeps each vowelled Arabic word whole", () => {
    expect(tokenize("بِسْمِ اللَّهِ")).toHaveLength(2)
  })

  it("keeps a Devanagari word with its matras whole", () => {
    expect(tokenize("शुरुआत में")).toHaveLength(2)
  })

  it("leaves precomposed Greek, Latin and CJK boundaries alone", () => {
    expect(tokenize("Ἐν ἀρχῇ ἦν ὁ λόγος")).toEqual(["ἐν", "ἀρχῇ", "ἦν", "ὁ", "λόγος"])
    expect(tokenize("In the beginning")).toEqual(["in", "the", "beginning"])
    expect(tokenize("起初 神创造")).toEqual(["起初", "神创造"])
  })

  it("still splits on punctuation, whitespace and other non-word characters", () => {
    expect(tokenize("God said, “Let there be light.”")).toEqual([
      "god",
      "said",
      "let",
      "there",
      "be",
      "light",
    ])
  })

  it("keeps digits as tokens", () => {
    expect(tokenize("Genesis 1:1")).toEqual(["genesis", "1", "1"])
  })
})

describe("one tokenizer, not two (AQU-1190)", () => {
  it("interlinear re-exports the shared tokenizer rather than keeping a copy", () => {
    // The glosser and the alignment model drifted apart once already: AQU-462
    // widened interlinear's class and bt-glosser kept the narrow one for four
    // months. Identity here is what stops that happening a second time.
    expect(interlinearTokenize).toBe(tokenize)
  })
})

describe("tokenSpans — where each token sits (AQU-1694)", () => {
  it("yields the tokenize tokens, in order, at their offsets", () => {
    // Word alignment stores a token INDEX; Who's Who draws it at an OFFSET.
    // If the two came from different splits, a tint would land on the wrong
    // word, so the spans must be tokenize() plus positions, nothing else.
    const text = "Jesus said to her, “Give Me a drink.”"
    const spans = tokenSpans(text)
    expect(spans.map((span) => span.token)).toEqual(tokenize(text))
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(spans.map((span) => span.raw))
    expect(spans[5]).toEqual({ token: "me", raw: "Me", start: 25, end: 27 })
  })
})
