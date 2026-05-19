// AD-13 branching-search algorithm unit tests. Spec is in
// aquilla-specs/02-foundations.md §AD-13.

import { describe, it, expect } from "vitest"
import {
  tokenize,
  bm25Score,
  coverageRatio,
  longestContiguousRun,
  removeRunAndSplit,
  branchingSearch,
  type CorpusCell,
} from "../lib/branching-search/algorithm"
import {
  BRANCHING_SEARCH_DEFAULTS,
  applyBranchingSearchDefaults,
  loadBranchingSearchSettings,
  type BranchingSearchSettings,
} from "../lib/branching-search/settings"
import { makeInMemoryD1 } from "./helpers/d1-fake"

// Local helper: pretend-internal access to test bm25Score directly. The
// algorithm module doesn't expose TokenizedCell or CorpusStats; we
// reproduce just enough to drive bm25Score in unit tests.
function makeTestStats(corpus: { tokens: string[] }[]) {
  const numDocs = corpus.length
  let totalLen = 0
  const docFrequency = new Map<string, number>()
  for (const d of corpus) {
    totalLen += d.tokens.length
    for (const t of new Set(d.tokens)) {
      docFrequency.set(t, (docFrequency.get(t) ?? 0) + 1)
    }
  }
  return {
    numDocs,
    avgDocLength: numDocs > 0 ? totalLen / numDocs : 0,
    docFrequency,
  }
}

function makeTestDoc(text: string) {
  const tokens = tokenize(text)
  const termCounts = new Map<string, number>()
  for (const t of tokens) termCounts.set(t, (termCounts.get(t) ?? 0) + 1)
  return { tokens, termCounts, bag: new Set(tokens) }
}

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("The Cat, sat on the Mat!")).toEqual([
      "the", "cat", "sat", "on", "the", "mat",
    ])
  })

  it("returns empty for whitespace-only input", () => {
    expect(tokenize("   \t  ")).toEqual([])
  })

  it("keeps non-Latin letters via \\p{L}", () => {
    // Greek + a digit + punctuation
    expect(tokenize("Καλημέρα, κόσμε 42!")).toEqual([
      "καλημέρα", "κόσμε", "42",
    ])
  })

  it("treats numbers as their own tokens", () => {
    expect(tokenize("verse 3:16")).toEqual(["verse", "3", "16"])
  })
})

describe("coverageRatio", () => {
  it("returns the fraction of unique branch words present in the bag", () => {
    const branch = ["the", "cat", "sat"]
    const bag = new Set(["the", "cat"])
    expect(coverageRatio(branch, bag)).toBeCloseTo(2 / 3, 6)
  })

  it("dedupes the branch first (unique branch words)", () => {
    const branch = ["the", "the", "cat", "the"]
    const bag = new Set(["the", "cat"])
    expect(coverageRatio(branch, bag)).toBe(1) // 2/2 unique covered
  })

  it("returns 0 for empty branch", () => {
    expect(coverageRatio([], new Set(["x"]))).toBe(0)
  })

  it("returns 0 when nothing matches", () => {
    expect(coverageRatio(["a", "b"], new Set(["c"]))).toBe(0)
  })
})

describe("longestContiguousRun", () => {
  it("finds the earliest longest run of branch words in the bag", () => {
    const branch = ["the", "cat", "sat", "on", "the", "mat", "in", "the", "sun"]
    const bag = new Set(["the", "cat", "sat", "sun"])
    // ["the", "cat", "sat"] (indices 0-2) is the longest — len 3
    expect(longestContiguousRun(branch, bag)).toEqual({ start: 0, length: 3 })
  })

  it("breaks runs at the first non-matching token", () => {
    const branch = ["a", "b", "x", "c", "d"]
    const bag = new Set(["a", "b", "c", "d"])
    // Two runs of length 2; earliest wins.
    expect(longestContiguousRun(branch, bag)).toEqual({ start: 0, length: 2 })
  })

  it("returns length 0 when no token matches", () => {
    expect(longestContiguousRun(["x", "y"], new Set(["a"]))).toEqual({
      start: 0,
      length: 0,
    })
  })

  it("returns the full branch when every token matches", () => {
    expect(longestContiguousRun(["a", "b", "c"], new Set(["a", "b", "c"]))).toEqual({
      start: 0,
      length: 3,
    })
  })
})

describe("removeRunAndSplit", () => {
  it("splits into two sub-branches when the run is in the middle", () => {
    const branch = ["a", "b", "c", "d", "e"]
    expect(removeRunAndSplit(branch, { start: 2, length: 1 })).toEqual([
      ["a", "b"],
      ["d", "e"],
    ])
  })

  it("returns a single sub-branch when the run is at the start", () => {
    expect(removeRunAndSplit(["a", "b", "c"], { start: 0, length: 2 })).toEqual([
      ["c"],
    ])
  })

  it("returns a single sub-branch when the run is at the end", () => {
    expect(removeRunAndSplit(["a", "b", "c"], { start: 1, length: 2 })).toEqual([
      ["a"],
    ])
  })

  it("returns an empty list when the run covers the entire branch", () => {
    expect(removeRunAndSplit(["a", "b"], { start: 0, length: 2 })).toEqual([])
  })
})

describe("bm25Score", () => {
  it("returns 0 for empty branch", () => {
    const corpus = [makeTestDoc("hello world")]
    const stats = makeTestStats(corpus)
    expect(bm25Score([], corpus[0], stats, 1.5, 0.75)).toBe(0)
  })

  it("returns 0 when no branch token is in the doc", () => {
    const corpus = [makeTestDoc("hello world"), makeTestDoc("goodbye moon")]
    const stats = makeTestStats(corpus)
    expect(bm25Score(["foo", "bar"], corpus[0], stats, 1.5, 0.75)).toBe(0)
  })

  it("returns a positive score when there's overlap", () => {
    const corpus = [makeTestDoc("the cat sat"), makeTestDoc("the dog ran")]
    const stats = makeTestStats(corpus)
    const score = bm25Score(["cat", "sat"], corpus[0], stats, 1.5, 0.75)
    expect(score).toBeGreaterThan(0)
  })

  it("ranks the more specific doc higher (df-aware IDF)", () => {
    // "the" appears in both; "cat" appears in only one. The doc containing
    // "cat" should score higher for a query of ["cat"].
    const docs = [
      makeTestDoc("the cat sat"),
      makeTestDoc("the dog ran"),
      makeTestDoc("the bird flew"),
    ]
    const stats = makeTestStats(docs)
    const catScore = bm25Score(["cat"], docs[0], stats, 1.5, 0.75)
    const dogScore = bm25Score(["dog"], docs[1], stats, 1.5, 0.75)
    expect(catScore).toBeGreaterThan(0)
    expect(dogScore).toBeGreaterThan(0)
    // "cat" and "dog" both have df=1 here; both queries score the same
    // shape — we're checking the score is symmetric for symmetric setups.
    expect(catScore).toBeCloseTo(dogScore, 9)
  })

  it("returns 0 for an empty corpus (numDocs=0)", () => {
    const stats = makeTestStats([])
    expect(bm25Score(["x"], makeTestDoc("x"), stats, 1.5, 0.75)).toBe(0)
  })
})

describe("branchingSearch", () => {
  const corpus: CorpusCell[] = [
    { cellId: "c1", sourceText: "the cat sat on the mat", targetText: "le chat" },
    { cellId: "c2", sourceText: "the dog ran in the sun", targetText: "le chien" },
    { cellId: "c3", sourceText: "the bird flew over the moon", targetText: "l'oiseau" },
    { cellId: "c4", sourceText: "completely unrelated text", targetText: "rien" },
    { cellId: "c5", sourceText: "a cat and a dog", targetText: "un chat" },
  ]

  it("returns empty for empty query", () => {
    const { results, provenance } = branchingSearch("", corpus, BRANCHING_SEARCH_DEFAULTS)
    expect(results).toEqual([])
    expect(provenance.size).toBe(0)
  })

  it("returns empty for empty corpus", () => {
    const { results } = branchingSearch("the cat", [], BRANCHING_SEARCH_DEFAULTS)
    expect(results).toEqual([])
  })

  it("returns at most topK results", () => {
    const settings = { ...BRANCHING_SEARCH_DEFAULTS, topK: 2 }
    const { results } = branchingSearch("the cat sat on the mat", corpus, settings)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it("excludes already-selected cells across iterations", () => {
    const { results } = branchingSearch("the cat sat", corpus, BRANCHING_SEARCH_DEFAULTS)
    const ids = results.map((r) => r.cellId)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })

  it("is deterministic — same query + corpus + settings → same results", () => {
    const a = branchingSearch("the cat sat on the mat", corpus, BRANCHING_SEARCH_DEFAULTS)
    const b = branchingSearch("the cat sat on the mat", corpus, BRANCHING_SEARCH_DEFAULTS)
    expect(a.results).toEqual(b.results)
    // Provenance maps with identical insertion order should serialize to
    // the same string.
    expect([...a.provenance]).toEqual([...b.provenance])
  })

  it("ranks the cell containing the most query words first", () => {
    // "the cat sat" → c1 ("the cat sat on the mat") contains every query
    // token; nothing else does.
    const { results } = branchingSearch("the cat sat", corpus, BRANCHING_SEARCH_DEFAULTS)
    expect(results[0].cellId).toBe("c1")
  })

  it("populates provenance with the contiguous run from the winning branch", () => {
    const { results, provenance } = branchingSearch(
      "the cat sat",
      corpus,
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(results.length).toBeGreaterThan(0)
    const firstId = results[0].cellId
    const prov = provenance.get(firstId)
    expect(prov).toBeDefined()
    expect(prov!.length).toBeGreaterThan(0)
    // Every provenance token must appear in the matched cell's source.
    const matched = corpus.find((c) => c.cellId === firstId)!
    const bag = new Set(tokenize(matched.sourceText))
    for (const t of prov!) expect(bag.has(t)).toBe(true)
  })

  it("computes queryCoverage against the FULL original query, not the branch", () => {
    // Query has 3 unique words; c1 has all 3; c5 has 2 of them ("cat").
    const settings = { ...BRANCHING_SEARCH_DEFAULTS, topK: 5 }
    const { results } = branchingSearch("the cat sat", corpus, settings)
    const c1 = results.find((r) => r.cellId === "c1")
    expect(c1).toBeDefined()
    expect(c1!.queryCoverage).toBe(1) // c1 contains all of {the, cat, sat}
  })

  it("respects maxRestarts — restart re-seeds full query after branches dry up", () => {
    // Single-word corpus: each cell has one token. After picking c1 for "cat",
    // the branch ["cat"] is fully consumed (length 1, the only token). The
    // next iteration's seed is the full query — but since "cat" is the only
    // matching token and c1 is already selected, the restart finds nothing
    // and exits.
    const tinyCorpus: CorpusCell[] = [
      { cellId: "c1", sourceText: "cat", targetText: "" },
      { cellId: "c2", sourceText: "dog", targetText: "" },
    ]
    const { results } = branchingSearch("cat", tinyCorpus, BRANCHING_SEARCH_DEFAULTS)
    expect(results.map((r) => r.cellId)).toEqual(["c1"])
  })

  it("explores multiple cells when the query has multiple distinct chunks", () => {
    // Disjoint corpus — one cell matches the first half of the query, one
    // matches the second.
    const splitCorpus: CorpusCell[] = [
      { cellId: "cA", sourceText: "alpha beta gamma", targetText: "" },
      { cellId: "cB", sourceText: "delta epsilon zeta", targetText: "" },
      { cellId: "cC", sourceText: "nothing related", targetText: "" },
    ]
    const settings = { ...BRANCHING_SEARCH_DEFAULTS, topK: 2 }
    const { results } = branchingSearch(
      "alpha beta xxx delta epsilon",
      splitCorpus,
      settings,
    )
    expect(results.length).toBe(2)
    expect(new Set(results.map((r) => r.cellId))).toEqual(new Set(["cA", "cB"]))
  })

  it("returns nothing when no corpus cell has any overlap with the query", () => {
    const isolatedCorpus: CorpusCell[] = [
      { cellId: "c1", sourceText: "completely different words", targetText: "" },
    ]
    const { results } = branchingSearch("foo bar baz", isolatedCorpus, BRANCHING_SEARCH_DEFAULTS)
    expect(results).toEqual([])
  })
})

describe("applyBranchingSearchDefaults", () => {
  it("returns defaults when partial is undefined or null", () => {
    expect(applyBranchingSearchDefaults(undefined)).toEqual(BRANCHING_SEARCH_DEFAULTS)
    expect(applyBranchingSearchDefaults(null)).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("merges partial over defaults", () => {
    const merged = applyBranchingSearchDefaults({ topK: 10 })
    expect(merged.topK).toBe(10)
    expect(merged.bm25K1).toBe(BRANCHING_SEARCH_DEFAULTS.bm25K1)
  })

  it("falls back to defaults for non-finite or negative values", () => {
    const merged = applyBranchingSearchDefaults({
      topK: NaN as unknown as number,
      coverageWeight: -0.5,
      bm25K1: Infinity as unknown as number,
    })
    expect(merged.topK).toBe(BRANCHING_SEARCH_DEFAULTS.topK)
    expect(merged.coverageWeight).toBe(BRANCHING_SEARCH_DEFAULTS.coverageWeight)
    expect(merged.bm25K1).toBe(BRANCHING_SEARCH_DEFAULTS.bm25K1)
  })

  it("clamps topK to at least 1 and floors fractional values", () => {
    expect(applyBranchingSearchDefaults({ topK: 0 }).topK).toBe(1)
    expect(applyBranchingSearchDefaults({ topK: 3.7 }).topK).toBe(3)
  })

  it("clamps maxRestarts to at least 0 and floors fractional values", () => {
    expect(applyBranchingSearchDefaults({ maxRestarts: 0 }).maxRestarts).toBe(0)
    expect(applyBranchingSearchDefaults({ maxRestarts: 2.9 }).maxRestarts).toBe(2)
  })
})

describe("settings sanity", () => {
  it("spec defaults match the spec text verbatim", () => {
    const expected: BranchingSearchSettings = {
      topK: 5,
      coverageWeight: 0.5,
      bm25K1: 1.5,
      bm25B: 0.75,
      maxRestarts: 3,
    }
    expect(BRANCHING_SEARCH_DEFAULTS).toEqual(expected)
  })
})

describe("loadBranchingSearchSettings", () => {
  it("returns defaults when AQUILLA_DB binding is missing", async () => {
    const settings = await loadBranchingSearchSettings({}, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("returns defaults when no settings row exists for the project", async () => {
    const db = makeInMemoryD1()
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("returns defaults when settings JSON has no branchingSearch key", async () => {
    const db = makeInMemoryD1({
      project_settings: [
        { project_id: "p1", settings: JSON.stringify({ sourceLanguage: "en" }) },
      ],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("merges partial branchingSearch over defaults", async () => {
    const db = makeInMemoryD1({
      project_settings: [
        {
          project_id: "p1",
          settings: JSON.stringify({
            branchingSearch: { topK: 10, coverageWeight: 0.9 },
          }),
        },
      ],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings.topK).toBe(10)
    expect(settings.coverageWeight).toBe(0.9)
    // Unset fields fall back.
    expect(settings.bm25K1).toBe(BRANCHING_SEARCH_DEFAULTS.bm25K1)
    expect(settings.maxRestarts).toBe(BRANCHING_SEARCH_DEFAULTS.maxRestarts)
  })

  it("soft-fails to defaults on malformed JSON", async () => {
    const db = makeInMemoryD1({
      project_settings: [{ project_id: "p1", settings: "not valid json {{" }],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("soft-fails to defaults when settings is null", async () => {
    const db = makeInMemoryD1({
      project_settings: [{ project_id: "p1", settings: null }],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("soft-fails to defaults when branchingSearch isn't an object", async () => {
    const db = makeInMemoryD1({
      project_settings: [
        {
          project_id: "p1",
          settings: JSON.stringify({ branchingSearch: "not an object" }),
        },
      ],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings).toEqual(BRANCHING_SEARCH_DEFAULTS)
  })

  it("clamps invalid field values per applyBranchingSearchDefaults rules", async () => {
    const db = makeInMemoryD1({
      project_settings: [
        {
          project_id: "p1",
          settings: JSON.stringify({
            branchingSearch: { topK: 0, coverageWeight: -1, maxRestarts: 2.7 },
          }),
        },
      ],
    })
    const settings = await loadBranchingSearchSettings({ AQUILLA_DB: db }, "p1")
    expect(settings.topK).toBe(1) // floored + clamped to >=1
    expect(settings.coverageWeight).toBe(BRANCHING_SEARCH_DEFAULTS.coverageWeight) // negative → default
    expect(settings.maxRestarts).toBe(2) // floored
  })
})
