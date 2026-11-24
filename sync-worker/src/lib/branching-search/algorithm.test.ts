// AD-13 branching search over character n-grams (AQU-2727). The loop covers
// the query: pick the cell most like it, remove what that cell shares, search
// again for what is left. These pin that loop and that it works the same in
// scripts that put no space between words.

import { describe, it, expect } from "vitest"
import { branchingSearch, type CorpusCell } from "./algorithm"
import { BRANCHING_SEARCH_DEFAULTS } from "./settings"

function corpus(...sources: string[]): CorpusCell[] {
  return sources.map((sourceText, i) => ({
    cellId: `c${i}`,
    sourceText,
    targetText: `t${i}`,
  }))
}

const ids = (r: { results: { cellId: string }[] }) => r.results.map((x) => x.cellId)

describe("branchingSearch", () => {
  it("returns nothing for an empty query or corpus", () => {
    expect(branchingSearch("", corpus("anything"), BRANCHING_SEARCH_DEFAULTS).results).toEqual([])
    expect(branchingSearch(" ;; ", corpus("anything"), BRANCHING_SEARCH_DEFAULTS).results).toEqual([])
    expect(branchingSearch("anything", [], BRANCHING_SEARCH_DEFAULTS).results).toEqual([])
  })

  it("puts the near-duplicate of the verse first", () => {
    const r = branchingSearch(
      "In the beginning God created the heavens and the earth.",
      corpus(
        "God created man in his own image",
        "In the beginning God created the heaven and the earth",
        "Peace unto you",
      ),
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(ids(r)[0]).toBe("c1")
    expect(r.results[0].queryCoverage).toBeGreaterThan(0.9)
    expect(ids(r)).not.toContain("c2")
  })

  it("searches again for what the first match did not cover", () => {
    const r = branchingSearch(
      "Abraham begat Isaac",
      corpus("Abraham went out", "Isaac grew up", "unrelated"),
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(ids(r)).toEqual(["c0", "c1"])
    // Provenance quotes the query as typed: what each pick removed from it.
    expect(r.provenance.get("c0")).toEqual(["Abraham"])
    expect(r.provenance.get("c1")).toEqual(["Isaac"])
  })

  it("finds a Chinese phrase inside an unspaced verse", () => {
    // Under the old word tokenizer each of these verses was one "word", so
    // nothing matched unless a verse was identical.
    const r = branchingSearch(
      "並所用的一切銅器皿，",
      corpus("他們出去了", "金器皿和銀器皿", "銅器"),
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(ids(r)).toContain("c1")
    expect(ids(r)).toContain("c2")
    expect(ids(r)).not.toContain("c0")
    expect(r.provenance.get("c1")!.join("")).toContain("器皿")
  })

  it("finds a shared stretch of a Thai verse", () => {
    const r = branchingSearch(
      "ในเริ่มแรกนั้นพระเจ้าทรงสร้างฟ้าและแผ่นดิน",
      corpus("พระเจ้าทรงสร้างมนุษย์", "ขอสันติสุขจงมีแก่ท่าน"),
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(ids(r)[0]).toBe("c0")
    expect(r.provenance.get("c0")!.join("")).toContain("พระเจ้าทรงสร้าง")
  })

  it("keeps vowel signs with their letters (Devanagari)", () => {
    const r = branchingSearch("अब्राहामले इसहाक", corpus("अब्राहाम", "मोशे"), BRANCHING_SEARCH_DEFAULTS)
    expect(ids(r)).toEqual(["c0"])
    expect(r.provenance.get("c0")).toEqual(["अब्राहाम"])
  })

  it("matches Korean inside a word joined to its particle", () => {
    const r = branchingSearch("하나님", corpus("태초에 하나님이 천지를", "사람이"), BRANCHING_SEARCH_DEFAULTS)
    expect(ids(r)).toEqual(["c0"])
  })

  it("matches a word-final sigma typed either way", () => {
    const r = branchingSearch("λογος", corpus("ΛΟΓΟΣ ΗΝ", "και"), BRANCHING_SEARCH_DEFAULTS)
    expect(ids(r)[0]).toBe("c0")
    expect(r.results[0].queryCoverage).toBe(1)
  })

  it("restarts on the whole query to fill the remaining slots", () => {
    const r = branchingSearch(
      "the son of David",
      corpus("the son of David", "Jesus the son of David", "David the king", "a son"),
      BRANCHING_SEARCH_DEFAULTS,
    )
    // c0 covers the query in one pick; the restarts bring in the others.
    expect(ids(r)[0]).toBe("c0")
    expect(new Set(ids(r))).toEqual(new Set(["c0", "c1", "c2", "c3"]))
  })

  it("stops at topK", () => {
    const r = branchingSearch(
      "son",
      corpus("son", "a son", "the son", "his son", "my son"),
      { ...BRANCHING_SEARCH_DEFAULTS, topK: 2 },
    )
    expect(r.results).toHaveLength(2)
  })

  it("is deterministic, and ties go to corpus order", () => {
    const cells = corpus("the son", "the son", "a son of man", "son")
    const a = branchingSearch("son of man", cells, BRANCHING_SEARCH_DEFAULTS)
    const b = branchingSearch("son of man", cells, BRANCHING_SEARCH_DEFAULTS)
    expect(a.results).toEqual(b.results)
    expect([...a.provenance]).toEqual([...b.provenance])
    const tie = ids(branchingSearch("the son", cells, BRANCHING_SEARCH_DEFAULTS))
    expect(tie.indexOf("c0")).toBeLessThan(tie.indexOf("c1"))
  })

  it("carries the source file id onto the result", () => {
    const r = branchingSearch(
      "abc",
      [{ cellId: "x", sourceText: "abc", targetText: "", fileId: "f1" }],
      BRANCHING_SEARCH_DEFAULTS,
    )
    expect(r.results[0].fileId).toBe("f1")
  })
})
