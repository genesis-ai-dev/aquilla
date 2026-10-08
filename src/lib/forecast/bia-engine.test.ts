import { describe, expect, it } from "vitest"
import { BiaEngine, FAITHFUL_OPTIONS, endsInsideWord } from "./bia-engine"
import { BiaIndex, FALLBACK_WEIGHT, type ForecastCell } from "./bia-index"

function engineOf(texts: string[], validated = true): BiaEngine {
  const index = new BiaIndex()
  index.upsert(texts.map((text, i): ForecastCell => ({ id: `c${i}`, text, validated, order: i })))
  return new BiaEngine(index)
}

const words = (list: Array<{ word: string }>) => list.map((s) => s.word)

describe("BiaIndex", () => {
  it("tracks postings at the first position, document frequency and IDF", () => {
    const index = new BiaIndex()
    index.upsert([
      { id: "a", text: "the cat saw the dog", validated: true },
      { id: "b", text: "the dog ran", validated: true },
    ])
    expect(index.postingsOf("the")?.get("a")).toBe(0)
    expect(index.postingsOf("dog")?.get("a")).toBe(4)
    // sklearn smooth idf: ln((1+n)/(1+df)) + 1
    expect(index.idf("the")).toBeCloseTo(Math.log(3 / 3) + 1)
    expect(index.idf("cat")).toBeCloseTo(Math.log(3 / 2) + 1)
    expect(index.idf("never")).toBeCloseTo(Math.log(3 / 1) + 1)
  })

  it("weights unvalidated cells lower in every count", () => {
    const index = new BiaIndex()
    index.upsert([
      { id: "a", text: "grace upon grace", validated: true },
      { id: "b", text: "grace abounds", validated: false },
    ])
    expect(index.frequency("grace")).toBeCloseTo(2 + FALLBACK_WEIGHT)
    expect(index.bigram("grace", "upon")).toBe(1)
    expect(index.bigram("grace", "abounds")).toBe(FALLBACK_WEIGHT)
  })

  it("updates incrementally: replacing and removing a cell undoes its counts", () => {
    const index = new BiaIndex()
    index.upsert([{ id: "a", text: "light shines", validated: true }])
    index.upsert([{ id: "a", text: "darkness falls", validated: true }])
    expect(index.has("light")).toBe(false)
    expect(index.bigram("light", "shines")).toBe(0)
    expect(index.canBeNext("light", "anything")).toBe(true)
    expect(index.bigram("darkness", "falls")).toBe(1)
    index.remove(["a"])
    expect(index.size).toBe(0)
    expect(index.vocabularyByFrequency()).toEqual([])
  })

  it("keys words lower-case but remembers their usual mid-sentence spelling", () => {
    const index = new BiaIndex()
    index.upsert([
      { id: "a", text: "Y dijo Dios", validated: true },
      { id: "b", text: "Y vio Dios que y era bueno", validated: true },
    ])
    expect(index.has("dios")).toBe(true)
    expect(index.display("dios")).toBe("Dios")
    // Sentence-initial "Y" does not outvote the mid-sentence "y".
    expect(index.display("y")).toBe("y")
    const engine = new BiaEngine(index)
    expect(engine.suggestNext("Y dijo ", { extend: false })[0]).toMatchObject({ word: "Dios", insert: "Dios" })
    expect(engine.suggestNext("y vio Di", { extend: false })[0]).toMatchObject({ insert: "os" })
  })

  it("tokenizes non-Latin scripts without shredding combining marks", () => {
    const index = new BiaIndex()
    index.upsert([{ id: "a", text: "बिचमा परमप्रभुको भय छाउनेछ ।", validated: true }])
    expect(index.has("परमप्रभुको")).toBe(true)
    expect(index.bigram("परमप्रभुको", "भय")).toBe(1)
    index.upsert([{ id: "h", text: "בְּרֵאשִׁית בָּרָא", validated: true }])
    expect(index.has("בְּרֵאשִׁית")).toBe(true)
  })
})

describe("BiaEngine.predictAt — anchors and distance voting", () => {
  it("an anchor at distance d votes for the word d places away in other cells", () => {
    const engine = engineOf(["alpha beta gamma", "alpha delta gamma"])
    // blank at 1: anchors alpha (d=-1) and gamma (d=+1) both land on beta and delta.
    const ranked = engine.predictAt(["alpha", "", "gamma"], 1, { neighbors: false })
    expect(new Set(ranked.map(([w]) => w))).toEqual(new Set(["beta", "delta"]))
    expect(ranked[0][1]).toBe(2)
  })

  it("right-side anchors count backwards", () => {
    const engine = engineOf(["one two three zeta"])
    // zeta is two to the right of the blank, so it reads two to its LEFT.
    const ranked = engine.predictAt(["", "x", "zeta"], 0, { neighbors: false })
    expect(ranked.map(([w]) => w)).toContain("two")
    expect(ranked.map(([w]) => w)).not.toContain("three")
  })

  it("each anchor gives a word one vote, however many cells it lands through", () => {
    const engine = engineOf(["rare apple", "rare apple", "rare apple", "other pear"])
    const ranked = engine.predictAt(["rare", ""], 1)
    expect(ranked).toEqual([["apple", 1]])
  })

  it("keeps only the topN rarest anchors", () => {
    const engine = engineOf(["common rare1 target", "common x y", "common z w", "common rare1 q"])
    const ranked = engine.predictAt(["common", "rare1", ""], 2, { topN: 1, neighbors: false })
    // rare1 (df 2) beats common (df 4); with topN=1 only rare1 votes.
    expect(new Set(ranked.map(([w]) => w))).toEqual(new Set(["target", "q"]))
  })

  it("validated landings outweigh unvalidated ones", () => {
    const index = new BiaIndex()
    index.upsert([
      { id: "a", text: "seed of faith", validated: false },
      { id: "b", text: "seed of hope", validated: true },
    ])
    const ranked = new BiaEngine(index).predictAt(["seed", "of", ""], 2)
    expect(ranked[0][0]).toBe("hope")
  })

  it("respects excludeCellId and the cell-order bound", () => {
    const engine = engineOf(["key alpha", "key beta", "key gamma"])
    expect(engine.predictAt(["key", ""], 1, { excludeCellId: "c0" }).map(([w]) => w)).not.toContain("alpha")
    expect(engine.predictAt(["key", ""], 1, { bound: [1, 1] }).map(([w]) => w)).toEqual(["beta"])
  })
})

describe("BiaEngine.suggestNext", () => {
  const corpus = [
    "the lord is my shepherd",
    "the lord is good",
    "the lord is my light",
    "my shepherd leads me",
    "is my cup full",
  ]

  it("faithful mode filters candidates through the forward Markov chain", () => {
    const engine = engineOf(corpus)
    const out = engine.suggestNext("the lord is ", { ...FAITHFUL_OPTIONS, extend: false })
    expect(out.length).toBeGreaterThan(0)
    for (const s of out) expect(engine.index.canBeNext("is", s.word)).toBe(true)
    expect(words(out)[0]).toBe("my")
  })

  it("extends the top suggestions by one more word", () => {
    const engine = engineOf(corpus)
    const [first] = engine.suggestNext("the lord is ")
    expect(first.word).toBe("my")
    expect(first.insert).toBe("my shepherd")
  })

  it("completes a partial word and inserts only the remainder", () => {
    const engine = engineOf(corpus)
    expect(endsInsideWord("the lord is my sh")).toBe(true)
    const [first] = engine.suggestNext("the lord is my sh", { extend: false })
    expect(first.word).toBe("shepherd")
    expect(first.insert).toBe("epherd")
  })

  it("falls back to Markov followers when no anchor lands", () => {
    const engine = engineOf(["unseen alpha omega"])
    const [first] = engine.suggestNext("brand new alpha ", { extend: false })
    expect(first).toMatchObject({ word: "omega" })
    expect(engine.suggestNext("zzz ", { ...FAITHFUL_OPTIONS })).toEqual([])
  })
})

describe("BiaEngine.suggestInfill", () => {
  it("uses both sides of the blank", () => {
    const engine = engineOf(["in the beginning god created", "in the end god rested", "after the beginning came light"])
    const [first] = engine.suggestInfill("in the ", " god created")
    expect(first.word).toBe("beginning")
  })
})

describe("BiaEngine.wordsThatFit (thesaurus)", () => {
  const corpus = [
    "the king went to the city",
    "the queen went to the city",
    "the king spoke to the people",
    "the queen spoke to the people",
    "the prophet spoke to the people",
    "a stone fell on the road",
    "the king sat on the throne",
  ]

  it("returns words that occupy the same slots, never the word itself", () => {
    const engine = engineOf(corpus)
    const fit = words(engine.wordsThatFit("king"))
    expect(fit[0]).toBe("queen")
    expect(fit).toContain("prophet")
    expect(fit).not.toContain("king")
  })

  it("works for a word only the current sentence contains (context sample)", () => {
    const engine = engineOf(corpus)
    const fit = words(engine.wordsThatFit("emperor", { context: { left: "the ", right: " went to the city" } }))
    expect(fit).toContain("king")
  })

  it("only reads cells between the word's first and last occurrence (Python bound)", () => {
    const engine = engineOf(["the king went home", "the queen went home", "the king went home", "the duke went home"])
    expect(words(engine.wordsThatFit("king"))).toEqual(["queen"])
  })

  it("keeps the Python IDF² combine_votes as an option", () => {
    const engine = engineOf(corpus)
    expect(engine.wordsThatFit("king", { weighting: "idf2" }).length).toBeGreaterThan(0)
  })

  it("reflects incremental updates", () => {
    const engine = engineOf(corpus)
    engine.index.upsert([{ id: "new", text: "the regent went to the city", validated: true, order: 3 }])
    expect(words(engine.wordsThatFit("king"))).toContain("regent")
    engine.index.remove(["new"])
    expect(words(engine.wordsThatFit("king"))).not.toContain("regent")
  })
})
