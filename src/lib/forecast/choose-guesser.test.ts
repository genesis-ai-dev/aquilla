// The default guesser per task and project size (docs/forecast/bia-head-to-head.md):
// next word — chains only without a source, BIA + source (bigram-weighted)
// with one; infill — plain BIA until the project has SOURCE_MIN_PAIRS
// translated pairs, then BIA + source.

import { describe, expect, it } from "vitest"
import { BiaEngine, SOURCE_MIN_PAIRS, chooseGuesser } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"

const corpus: Array<[string, string]> = [
  ["then moses said to the people", "na musa i tok long ol manmeri"],
  ["then aaron said to the people", "na aron i tok long ol manmeri"],
  ["then joshua said to the people", "na josua i tok long ol manmeri"],
  ["moses went up the mountain", "musa i go antap long maunten"],
  ["aaron went up the mountain", "aron i go antap long maunten"],
]
const SOURCE = "then joshua said to the people"

function engineOf(pairs = corpus): BiaEngine {
  const index = new BiaIndex()
  index.upsert(pairs.map(([source, text], i): ForecastCell => ({ id: `c${i}`, source, text, validated: true, order: i })))
  return new BiaEngine(index)
}

const words = (list: Array<{ word: string }>) => list.map((s) => s.word.toLowerCase())

describe("chooseGuesser", () => {
  it("picks by task, source and translated-pair count only", () => {
    const few = SOURCE_MIN_PAIRS - 1
    expect(chooseGuesser("next", false, 0)).toEqual({ source: false, chains: true, chainsOnly: true })
    expect(chooseGuesser("next", false, 50_000)).toEqual({ source: false, chains: true, chainsOnly: true })
    expect(chooseGuesser("next", true, 1)).toEqual({ source: true, chains: false, chainsOnly: false })
    expect(chooseGuesser("next", true, few)).toEqual({ source: true, chains: false, chainsOnly: false })
    expect(chooseGuesser("next", true, SOURCE_MIN_PAIRS)).toEqual({ source: true, chains: false, chainsOnly: false })
    expect(chooseGuesser("infill", false, 50_000)).toEqual({ source: false, chains: false, chainsOnly: false })
    expect(chooseGuesser("infill", true, few)).toEqual({ source: false, chains: false, chainsOnly: false })
    expect(chooseGuesser("infill", true, SOURCE_MIN_PAIRS)).toEqual({ source: true, chains: false, chainsOnly: false })
  })

  it("defaults to 1,000 translated pairs and honours an explicit threshold", () => {
    expect(SOURCE_MIN_PAIRS).toBe(1000)
    expect(chooseGuesser("infill", true, 5, 5).source).toBe(true)
    expect(chooseGuesser("infill", true, 4, 5).source).toBe(false)
  })
})

describe("BiaEngine defaults follow chooseGuesser", () => {
  it("next word without a source is the chains-only ranking", () => {
    const engine = engineOf()
    expect(engine.suggestNext("na aron i ", { extend: false }))
      .toEqual(engine.suggestNext("na aron i ", { extend: false, chains: true, chainsOnly: true }))
  })

  it("next word with a source mixes it in at any project size, bigram-weighted", () => {
    const engine = engineOf()
    const auto = engine.suggestNext("na ", { extend: false, source: SOURCE })
    expect(auto).toEqual(engine.suggestNext("na ", { extend: false, source: SOURCE, chains: false, sourceMinPairs: 0 }))
    // A 5-pair project: the source still names the person the context cannot.
    expect(words(auto)[0]).toBe("josua")
  })

  it("infill leaves the source out until the project has enough pairs, then uses it", () => {
    const engine = engineOf()
    const left = "na "
    const right = " i tok long ol manmeri"
    const plain = engine.suggestInfill(left, right)
    // A 5-pair project: the lexicon is not trusted, so infill is plain BIA.
    expect(engine.suggestInfill(left, right, { source: SOURCE })).toEqual(plain)
    expect(words(plain)[0]).not.toBe("josua")
    // Trusted (threshold 5): the source verse names the right person.
    expect(words(engine.suggestInfill(left, right, { source: SOURCE, sourceMinPairs: corpus.length }))[0]).toBe("josua")
  })

  it("explicit options still override the default", () => {
    const engine = engineOf()
    // sourceWeight 0 is "no source": the chains-only ranking.
    expect(engine.suggestNext("na ", { extend: false, source: SOURCE, sourceWeight: 0 }))
      .toEqual(engine.suggestNext("na ", { extend: false }))
    // sourceMinPairs 0 forces the lexicon into infill even in a tiny project.
    expect(words(engine.suggestInfill("na ", " i tok long ol manmeri", { source: SOURCE, sourceMinPairs: 0 }))[0]).toBe("josua")
  })
})
