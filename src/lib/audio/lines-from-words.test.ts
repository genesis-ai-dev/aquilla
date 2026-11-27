import { describe, expect, it } from "vitest"
import { endsSentence, joinWords, linesFromWords, type TimedWord } from "./lines-from-words"

const w = (text: string, start: number, end: number): TimedWord => ({ text, start, end })

describe("linesFromWords (AQU-2426)", () => {
  it("cuts after each sentence, halfway through the gap, and tiles the recording", () => {
    const lines = linesFromWords([
      w("In", 0.4, 0.6), w("the", 0.6, 0.8), w("beginning.", 0.8, 1.4),
      w("God", 2.0, 2.3), w("spoke.", 2.3, 2.9),
    ], 4)
    expect(lines.map((l) => l.text)).toEqual(["In the beginning.", "God spoke."])
    expect(lines[0].startSec).toBe(0)
    expect(lines[0].endSec).toBeCloseTo(1.7)
    expect(lines[1].startSec).toBeCloseTo(1.7)
    expect(lines[1].endSec).toBe(4)
  })

  it("a real pause ends a line even mid-sentence", () => {
    const lines = linesFromWords([w("And", 0, 0.3), w("then", 0.3, 0.6), w("silence", 2.4, 2.9)], 3)
    expect(lines.map((l) => l.text)).toEqual(["And then", "silence"])
  })

  it("a line longer than half a minute is cut at its longest gap", () => {
    const words: TimedWord[] = []
    for (let i = 0; i < 40; i++) words.push(w(`w${i}`, i, i + 0.9 - (i === 19 ? 0.5 : 0)))
    const lines = linesFromWords(words, 41)
    expect(lines.length).toBe(2)
    expect(lines.every((l) => l.endSec - l.startSec <= 31)).toBe(true)
    expect(lines[0].words[lines[0].words.length - 1].text).toBe("w19")
  })

  it("no words is one line over the whole recording", () => {
    expect(linesFromWords([], 12)).toEqual([{ startSec: 0, endSec: 12, text: "", words: [] }])
  })

  it("knows sentence ends in other scripts", () => {
    expect(endsSentence("终。")).toBe(true)
    expect(endsSentence("كلام؟")).toBe(true)
    expect(endsSentence("“Yes.”")).toBe(true)
    expect(endsSentence("and")).toBe(false)
  })

  it("joins words with spaces where the script uses them", () => {
    expect(joinWords([w("Hello", 0, 1), w(",", 1, 1), w("world.", 1, 2)])).toBe("Hello, world.")
    expect(joinWords([w("你好", 0, 1), w("世界", 1, 2)])).toBe("你好世界")
    expect(joinWords([w(" leading", 0, 1), w(" space", 1, 2)])).toBe("leading space")
  })
})
