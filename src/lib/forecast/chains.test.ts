// Per-distance chains (Daniel's 2024 forecaster, restored for next-word mode
// when a cell has no source signal): full counts of which word appears 1, 2, 3
// places after each word, combined as a product of experts.

import { describe, expect, it } from "vitest"
import { BiaEngine } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"

function indexOf(texts: string[], sources: string[] = []): BiaIndex {
  const index = new BiaIndex()
  index.upsert(texts.map((text, i): ForecastCell => ({ id: `c${i}`, text, source: sources[i], validated: true, order: i })))
  return index
}

describe("per-distance chains", () => {
  it("keeps full counts per distance and updates incrementally", () => {
    const index = indexOf(["a b c d", "a b x d", "a y c d"])
    expect(index.chainProbability(1, "a", "b")).toBeCloseTo(2 / 3)
    expect(index.chainProbability(2, "a", "c")).toBeCloseTo(2 / 3)
    expect(index.chainProbability(3, "a", "d")).toBeCloseTo(1)
    index.remove(["c0"])
    expect(index.chainProbability(2, "a", "c")).toBeCloseTo(1 / 2)
    expect(index.chainProbability(1, "a", "b")).toBeCloseTo(1 / 2)
  })

  it("uses the word two back, which a bigram cannot see", () => {
    // After "the", the bigram says "king" or "land"; two back, "rule" is
    // followed two places later by "land" only.
    const engine = new BiaEngine(indexOf([
      "they rule the land", "they rule the land", "we see the king", "we see the king", "we see the king",
    ]))
    const [best] = engine.suggestNext("you rule the ", { extend: false, chains: true, chainsOnly: true })
    expect(best.word).toBe("land")
  })

  it("is the default only when the cell has no source signal", () => {
    const engine = new BiaEngine(indexOf(
      ["they rule the land", "we see the king", "we see the king"],
      ["ils règnent sur le pays", "nous voyons le roi", "nous voyons le roi"],
    ))
    const auto = engine.suggestNext("they rule the ", { extend: false })
    const chainsOnly = engine.suggestNext("they rule the ", { extend: false, chains: true, chainsOnly: true })
    expect(auto).toEqual(chainsOnly)
    const withSource = engine.suggestNext("they rule the ", { extend: false, source: "nous voyons le roi" })
    const bigramPath = engine.suggestNext("they rule the ", { extend: false, source: "nous voyons le roi", chains: false })
    expect(withSource).toEqual(bigramPath)
  })

  it("leaves infill on BIA", () => {
    const engine = new BiaEngine(indexOf(["they rule the land", "we see the king"]))
    const a = engine.suggestInfill("they rule ", " land", { chains: true })
    const b = engine.suggestInfill("they rule ", " land", { chains: false })
    expect(a).toEqual(b)
  })
})
