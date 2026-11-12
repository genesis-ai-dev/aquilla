// The default guesser per task and project size (docs/forecast/bia-head-to-head.md):
// next word — chains only without a source; with one, the BIA vote weighted
// by the chains, + α = 1 × source, then the bigram factor; infill — plain BIA
// until the project has SOURCE_MIN_PAIRS translated pairs, then BIA + source.

import fixtureRaw from "../../../e2e/fixtures/forecast-genesis-1.json?raw"
import { describe, expect, it } from "vitest"
import { BiaEngine, NEXT_SOURCE_WEIGHT, SOURCE_MIN_PAIRS, chooseGuesser, type SuggestOptions } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"

const NEXT_WITH_SOURCE = {
  source: true, chains: true, chainsOnly: false, chainForm: "soft-sum", chainStage: "target", sourceWeight: NEXT_SOURCE_WEIGHT,
}

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
    expect(chooseGuesser("next", true, 1)).toEqual(NEXT_WITH_SOURCE)
    expect(chooseGuesser("next", true, few)).toEqual(NEXT_WITH_SOURCE)
    expect(chooseGuesser("next", true, SOURCE_MIN_PAIRS)).toEqual(NEXT_WITH_SOURCE)
    expect(NEXT_SOURCE_WEIGHT).toBe(1)
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

  it("next word with a source: chains on the target guess, then α = 1 × source, then the bigram", () => {
    const engine = engineOf()
    const auto = engine.suggestNext("na ", { extend: false, source: SOURCE })
    expect(auto).toEqual(engine.suggestNext("na ", {
      extend: false, source: SOURCE, chains: true, chainsOnly: false, chainForm: "soft-sum", chainStage: "target", sourceWeight: 1,
    }))
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

// The real 30-verse Genesis 1 fixture the ghost-text e2e journey seeds
// (WEB source, RV1909 target): the same producer data, without the browser.
describe("next-word default on the e2e Genesis 1 project", () => {
  const fixture = JSON.parse(fixtureRaw) as {
    verses: Array<{ ref: string; source: string; target: string }>
  }
  const project = (heldOut: string) => {
    const index = new BiaIndex()
    index.upsert(fixture.verses.map((v, i): ForecastCell => ({
      id: v.ref, text: v.ref === heldOut ? "" : v.target, source: v.source, validated: v.ref !== heldOut, order: i,
    })))
    return new BiaEngine(index)
  }
  const ghost = (engine: BiaEngine, ref: string, left: string, extra: SuggestOptions = {}) =>
    engine.suggestNext(left, { excludeCellId: ref, source: engine.index.lexicon.sourceOf(ref), ...extra })[0]?.insert.trim()

  it("a key term only the source proposes still surfaces mid-sentence", () => {
    const engine = project("GEN 1:22")
    // "Be fruitful" → "Fructificad": no earlier verse puts it after "diciendo:".
    expect(ghost(engine, "GEN 1:22", "Y Dios los bendijo diciendo: ")).toMatch(/^Fructificad/)
    // Weighting the MIXED score by the chain product floors it instead.
    expect(ghost(engine, "GEN 1:22", "Y Dios los bendijo diciendo: ", {
      chains: true, chainsOnly: false, chainForm: "product", chainStage: "final", sourceWeight: 2,
    })).not.toMatch(/^Fructificad/)
  })

  it("keeps the context-driven suggestions of the journey", () => {
    const engine = project("GEN 1:25")
    expect(ghost(engine, "GEN 1:25", "E hizo Dios animales de ")).toBe("la tierra")
    expect(ghost(engine, "GEN 1:25", "E hizo Dios animales de la tierra según ")).toBe("su género")
  })
})
