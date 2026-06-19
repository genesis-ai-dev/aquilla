import { describe, it, expect } from "vitest"
import { compressExampleSource, dedupeExamples } from "../compress-examples"

describe("compressExampleSource", () => {
  it("returns short source unchanged (no truncation needed)", () => {
    const s = "In the beginning God created the heavens and the earth."
    expect(compressExampleSource(s, { matchedTokens: ["god"] })).toBe(s)
  })

  it("keeps the matched span and elides head and tail with an ellipsis", () => {
    const long =
      "Now it came to pass in those distant days that a certain man traveled far " +
      "and the COVENANT was established between them forever " +
      "and afterwards the people returned to their tents and dwelt in peace for many years."
    const out = compressExampleSource(long, { matchedTokens: ["covenant"], keepWholeUnder: 80, marginChars: 20 })
    expect(out).toContain("COVENANT")
    expect(out.startsWith("…")).toBe(true)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThan(long.length)
  })

  it("does not cut mid-word (snaps to a boundary char)", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november"
    const out = compressExampleSource(long, { matchedTokens: ["hotel"], keepWholeUnder: 20, marginChars: 8 })
    // every retained token is whole — no partial word fragments
    for (const frag of out.replace(/…/g, " ").trim().split(/\s+/)) {
      expect(long).toContain(frag)
    }
  })

  it("falls back to head+ellipsis when no matched tokens are supplied", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
    const out = compressExampleSource(long, { keepWholeUnder: 20 })
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("one")).toBe(true)
  })
})

describe("dedupeExamples", () => {
  it("drops later duplicates by normalized source, keeping the first", () => {
    const out = dedupeExamples([
      { source: "the LORD said", target: "A" },
      { source: "the  LORD   said", target: "B" }, // whitespace-normalized dup
      { source: "and it was so", target: "C" },
    ])
    expect(out.map((e) => e.target)).toEqual(["A", "C"])
  })

  it("drops empty/blank-source examples", () => {
    const out = dedupeExamples([
      { source: "  ", target: "X" },
      { source: "real", target: "Y" },
    ])
    expect(out.map((e) => e.target)).toEqual(["Y"])
  })
})
