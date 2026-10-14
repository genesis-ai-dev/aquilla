// Per-distance chains: full counts of which word appears 1, 2, 3 places after
// (and before) each word, combined as a product of experts. Next word reads
// the left context forward; infill also reads the right context backward.

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

  it("fills a gap from both sides: the right context predicts backwards", () => {
    // After "the", "blue" is the commoner follower; but only "red" is ever
    // seen right before "king", so the backward chain decides.
    const engine = new BiaEngine(indexOf(["the red king", "the blue sea", "the blue sea"]))
    const [infill] = engine.suggestInfill("the ", " king", { chains: true, chainsOnly: true })
    expect(infill.word).toBe("red")
    const [next] = engine.suggestNext("the ", { extend: false, chains: true, chainsOnly: true })
    expect(next.word).toBe("blue")
  })

  it("counts the words 1, 2 and 3 places before each word, incrementally", () => {
    const index = indexOf(["a b c d", "x b c d"])
    expect(index.backChainProbability(1, "d", "c")).toBeCloseTo(1)
    expect(index.backChainProbability(3, "d", "a")).toBeCloseTo(1 / 2)
    expect(Array.from(index.chainPredecessors(3, "d")).sort()).toEqual(["a", "x"])
    index.remove(["c0"])
    expect(index.backChainProbability(3, "d", "a")).toBe(0)
    expect(index.backChainProbability(3, "d", "x")).toBeCloseTo(1)
  })
})
