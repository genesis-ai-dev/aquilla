import { describe, expect, it } from "vitest"
import { looseWords, transcriptVerdict, wordDifferences } from "./transcript-verdict"

// Word timings as the transcriber stores them: `end` is a char offset into the
// cell text when the heard words line up with it.
function timed(words: string[], text: string) {
  let at = 0
  return words.map((word) => {
    const start = text.indexOf(word, at)
    at = start < 0 ? at : start + word.length
    return { word, start: Math.max(0, start), end: start < 0 ? at : start + word.length, t0: 0, t1: 0 }
  })
}

describe("transcriptVerdict", () => {
  it("says none when the take was never transcribed", () => {
    expect(transcriptVerdict({ timings: undefined, cellText: "Hola" })).toEqual({ kind: "none" })
    expect(transcriptVerdict({ timings: [], cellText: "Hola" })).toEqual({ kind: "none" })
  })

  it("matches regardless of case and punctuation, as the transcript card always has", () => {
    const text = "¿Te vuelve a doler la cabeza?"
    const timings = timed(["te", "vuelve", "a", "doler", "la", "cabeza"], text.toLowerCase())
    expect(transcriptVerdict({ timings, cellText: text })).toEqual({ kind: "match" })
  })

  it("counts the words added, dropped or changed", () => {
    const text = "Te he llamado por tu nombre"
    // one changed ("llamé"), one dropped ("he")
    const timings = [{ word: "Te", end: 2 }, { word: "llamé", end: 8 }, { word: "por", end: 12 }, { word: "tu", end: 15 }, { word: "nombre", end: 22 }]
    expect(transcriptVerdict({ timings, cellText: text, alignedToCellText: false })).toEqual({ kind: "differs", words: 2 })
  })

  it("is stale when the text was shortened after transcribing", () => {
    const timings = [{ word: "uno", end: 3 }, { word: "dos", end: 7 }, { word: "tres", end: 12 }]
    expect(transcriptVerdict({ timings, cellText: "uno dos", alignedToCellText: true })).toEqual({ kind: "stale" })
  })
})

describe("wordDifferences", () => {
  it("is an edit distance over words", () => {
    expect(wordDifferences([], [])).toBe(0)
    expect(wordDifferences(["a", "b"], ["a", "b"])).toBe(0)
    expect(wordDifferences(["a", "b", "c"], ["a", "c"])).toBe(1)
    expect(wordDifferences(["a"], ["b", "c"])).toBe(2)
  })

  it("normalises the way the transcript card does", () => {
    expect(looseWords("  ¡Hola,   Mundo! ")).toEqual(["hola", "mundo"])
    expect(looseWords("…")).toEqual([])
  })
})
