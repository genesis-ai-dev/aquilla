import { describe, expect, it } from "vitest"
import { BiaEngine, mixScores } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"
import { suggestAtCaret } from "./forecast-protocol"

function indexOf(pairs: Array<[source: string, target: string]>, validated = true): BiaIndex {
  const index = new BiaIndex()
  index.upsert(pairs.map(([source, text], i): ForecastCell => ({ id: `c${i}`, source, text, validated, order: i })))
  return index
}

const words = (list: Array<{ word: string }>) => list.map((s) => s.word.toLowerCase())

describe("SourceLexicon — project-learned translation lexicon", () => {
  it("associates source and target words by Dice over cell pairs", () => {
    const { lexicon } = indexOf([
      ["moses spoke", "musa i tok"],
      ["moses went", "musa i go"],
      ["aaron spoke", "aron i tok"],
    ])
    // c(moses, musa) = 2, df(moses) = 2, df(musa) = 2 → 1
    expect(lexicon.dice("moses", "musa")).toBeCloseTo(1)
    // c(spoke, tok) = 2, df(spoke) = 2, df(tok) = 2 → 1; spoke/musa: 2·1/(2+2)
    expect(lexicon.dice("spoke", "tok")).toBeCloseTo(1)
    expect(lexicon.dice("spoke", "musa")).toBeCloseTo(0.5)
    expect(lexicon.dice("moses", "aron")).toBe(0)
    expect(lexicon.lengthRatio).toBeCloseTo(9 / 6)
  })

  it("keeps the source of an untranslated cell without learning from it", () => {
    const index = indexOf([["moses spoke", "musa i tok"]])
    index.upsert([{ id: "blank", source: "moses went", text: "", validated: false }])
    expect(index.lexicon.sourceOf("blank")).toEqual(["moses", "went"])
    expect(index.lexicon.pairCount).toBe(1)
    expect(index.lexicon.dice("went", "musa")).toBe(0)
  })

  it("updates incrementally and honours excludeCellId", () => {
    const index = indexOf([["moses spoke", "musa i tok"], ["moses went", "musa i go"]])
    expect(index.lexicon.dice("moses", "musa")).toBeCloseTo(1)
    expect(index.lexicon.dice("moses", "musa", "c0")).toBeCloseTo(2 / 3) // c=1, dfS=1, dfT=2
    index.upsert([{ id: "c1", source: "moses went", text: "mosis i go", validated: true }])
    expect(index.lexicon.dice("moses", "mosis")).toBeCloseTo(2 / 3)
    index.remove(["c0", "c1"])
    expect(index.lexicon.pairCount).toBe(0)
    expect(index.lexicon.associations("moses")).toEqual([])
  })

  it("weights source words near the cursor's relative position (λ)", () => {
    const { lexicon } = indexOf([
      ["alpha beta", "aa bb"],
      ["alpha gamma", "aa cc"],
      ["delta beta", "dd bb"],
    ])
    const source = ["alpha", "beta"]
    const atStart = lexicon.scoreTargets(source, { left: [], lambda: 8 })
    expect(atStart.get("aa")!).toBeGreaterThan(atStart.get("bb")!)
    const atEnd = lexicon.scoreTargets(source, { left: ["aa"], lambda: 8 })
    expect(atEnd.get("bb")!).toBeGreaterThan(atStart.get("bb")!)
    const blind = lexicon.scoreTargets(source, { left: [], lambda: 0 })
    expect(blind.get("aa")).toBeCloseTo(blind.get("bb")!)
  })

  it("discounts a target word the translator already typed", () => {
    const { lexicon } = indexOf([["alpha", "aa"], ["alpha beta", "aa bb"]])
    const fresh = lexicon.scoreTargets(["alpha"], { left: [], lambda: 0 })
    const used = lexicon.scoreTargets(["alpha"], { left: ["aa"], lambda: 0 })
    expect(used.get("aa")!).toBeLessThan(fresh.get("aa")!)
  })
})

describe("source mixing in the engine", () => {
  const corpus: Array<[string, string]> = [
    ["then moses said to the people", "na musa i tok long ol manmeri"],
    ["then aaron said to the people", "na aron i tok long ol manmeri"],
    ["then joshua said to the people", "na josua i tok long ol manmeri"],
    ["moses went up the mountain", "musa i go antap long maunten"],
    ["aaron went up the mountain", "aron i go antap long maunten"],
  ]

  it("mixScores max-normalises both sides and adds α × the second", () => {
    const mixed = mixScores([["a", 4], ["b", 2]], new Map([["b", 10], ["c", 5]]), 2)
    expect(mixed.get("a")).toBeCloseTo(1)
    expect(mixed.get("b")).toBeCloseTo(0.5 + 2)
    expect(mixed.get("c")).toBeCloseTo(1)
  })

  it("the source verse picks the right name where context alone cannot", () => {
    const engine = new BiaEngine(indexOf(corpus))
    const left = "na "
    const plain = words(engine.suggestNext(left, { extend: false, sourceWeight: 0 }))
    expect(plain[0]).not.toBe("josua")
    const aligned = words(engine.suggestNext(left, { extend: false, source: "then joshua said to the people" }))
    expect(aligned[0]).toBe("josua")
  })

  it("sourceWeight 0 is exactly the no-source ranking", () => {
    const engine = new BiaEngine(indexOf(corpus))
    const a = engine.suggestNext("na aron i ", { extend: false, sourceWeight: 0, source: "aaron went up" })
    const b = engine.suggestNext("na aron i ", { extend: false })
    expect(a).toEqual(b)
  })

  it("resolves the edited cell's own source verse through the protocol", () => {
    const index = indexOf(corpus)
    index.upsert([{ id: "blank", source: "then joshua went up the mountain", text: "", validated: false }])
    const engine = new BiaEngine(index)
    const [first] = suggestAtCaret(engine, "na ", "", { excludeCellId: "blank" })
    expect(first.word.toLowerCase()).toBe("josua")
    // An empty cell: a word aligned to the start of the source, and nothing
    // without a source. (The rare "joshua" outweighs the ubiquitous "then".)
    expect(["na", "josua"]).toContain(suggestAtCaret(engine, "", "", { excludeCellId: "blank" })[0]?.word.toLowerCase())
    expect(suggestAtCaret(engine, "", "", { excludeCellId: "c0x" })).toEqual([])
  })

  it("words that fit here ranks other renderings of the same source word", () => {
    const engine = new BiaEngine(indexOf([
      ...corpus,
      ["the people went up", "ol lain i go antap"],
      ["the people said", "ol lain i tok"],
    ]))
    const fit = words(engine.wordsThatFit("manmeri", {
      context: { left: "na musa i tok long ol ", right: "" },
      source: "then moses said to the people",
    }))
    expect(fit).toContain("lain")
    const before = words(engine.wordsThatFit("manmeri", { context: { left: "na musa i tok long ol ", right: "" } }))
    expect(fit.indexOf("lain")).toBeLessThanOrEqual(before.indexOf("lain") === -1 ? Infinity : before.indexOf("lain"))
  })
})
