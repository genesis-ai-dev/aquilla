import { describe, it, expect } from "vitest"
import {
  TM_MATCH_FLOOR,
  diffSourceTokens,
  matchBand,
  matchPercent,
  normalizeForMatch,
  rankTmMatches,
} from "./fuzzy-match"
import type { ScoredPair } from "./dual-index"

function pair(cellId: string, source: string, target = `t:${source}`): ScoredPair {
  return {
    cellId,
    fileId: "f1",
    source,
    target,
    score: 1,
    matchedTokens: [],
    coverageWeight: 1,
  }
}

describe("normalizeForMatch", () => {
  it("folds case, collapses whitespace, and strips tags", () => {
    expect(normalizeForMatch("In  the <i>beginning</i>\n")).toBe("in the beginning")
  })

  it("keeps punctuation, which is a real difference a reviewer must see", () => {
    expect(normalizeForMatch("God said.")).toBe("god said.")
  })
})

describe("matchPercent", () => {
  it("reports 100 only for a normalization-equal source", () => {
    expect(matchPercent("In the beginning", "in   the beginning")).toBe(100)
  })

  it("never reports 100 for text that merely rounds to it", () => {
    const long = "a".repeat(400)
    expect(matchPercent(long, long + "b")).toBe(99)
  })

  it("scores a near match between the floor and 100", () => {
    const percent = matchPercent("God created the heavens", "God created the heaven")
    expect(percent).toBeGreaterThanOrEqual(TM_MATCH_FLOOR)
    expect(percent).toBeLessThan(100)
  })

  it("scores unrelated text low", () => {
    expect(matchPercent("In the beginning", "Paul, an apostle")).toBeLessThan(TM_MATCH_FLOOR)
  })

  it("returns 0 when either side is empty", () => {
    expect(matchPercent("", "In the beginning")).toBe(0)
    expect(matchPercent("In the beginning", "   ")).toBe(0)
  })
})

describe("matchBand", () => {
  it("bands by the documented thresholds", () => {
    expect(matchBand(100)).toBe("exact")
    expect(matchBand(99)).toBe("high")
    expect(matchBand(95)).toBe("high")
    expect(matchBand(94)).toBe("good")
    expect(matchBand(85)).toBe("good")
    expect(matchBand(84)).toBe("fair")
    expect(matchBand(75)).toBe("fair")
    expect(matchBand(74)).toBe("example")
    expect(matchBand(0)).toBe("example")
  })
})

describe("rankTmMatches", () => {
  it("sorts scored matches by descending percent ahead of examples", () => {
    const ranked = rankTmMatches("God created the heavens and the earth", [
      pair("loose", "Paul, an apostle of Christ Jesus"),
      pair("near", "God created the heavens and the earth."),
      pair("exact", "god created the heavens and the earth"),
    ])
    expect(ranked.map((m) => m.cellId)).toEqual(["exact", "near", "loose"])
    expect(ranked[0].percent).toBe(100)
    expect(ranked[0].band).toBe("exact")
    expect(ranked[2].band).toBe("example")
  })

  it("keeps below-floor candidates in retrieval order and out of the match bands", () => {
    const ranked = rankTmMatches("In the beginning", [
      pair("a", "Paul, an apostle"),
      pair("b", "Timothy, my child"),
    ])
    expect(ranked.map((m) => m.cellId)).toEqual(["a", "b"])
    expect(ranked.every((m) => m.band === "example")).toBe(true)
    expect(ranked.every((m) => m.percent < TM_MATCH_FLOOR)).toBe(true)
  })

  it("leaves candidates past the re-rank limit unscored", () => {
    const pairs = [
      pair("filler-1", "Paul, an apostle"),
      pair("filler-2", "Timothy, my child"),
      pair("identical", "In the beginning"),
    ]
    const ranked = rankTmMatches("In the beginning", pairs, 2)
    expect(ranked.map((m) => m.cellId)).toEqual(["filler-1", "filler-2", "identical"])
    expect(ranked[2].percent).toBe(0)
  })

  it("preserves every candidate and its pair fields", () => {
    const ranked = rankTmMatches("In the beginning", [pair("a", "In the beginning", "Au commencement")])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].target).toBe("Au commencement")
    expect(ranked[0].fileId).toBe("f1")
  })

  it("returns an empty list for no candidates", () => {
    expect(rankTmMatches("In the beginning", [])).toEqual([])
  })
})

describe("diffSourceTokens", () => {
  it("marks only the candidate's differing words", () => {
    const segments = diffSourceTokens(
      "God created the heavens",
      "God created the earth",
    )
    expect(segments.filter((s) => s.kind === "added").map((s) => s.text.trim())).toEqual(["earth"])
    expect(segments.filter((s) => s.kind === "removed").map((s) => s.text.trim())).toEqual(["heavens"])
  })

  it("reproduces the candidate source from its equal + added segments", () => {
    const candidate = "And God said, “Let there be light”"
    const segments = diffSourceTokens("And God saw the light", candidate)
    const rebuilt = segments
      .filter((s) => s.kind !== "removed")
      .map((s) => s.text)
      .join("")
    expect(rebuilt).toBe(candidate)
  })

  it("returns one equal segment for an identical source", () => {
    expect(diffSourceTokens("In the beginning", "In the beginning")).toEqual([
      { kind: "equal", text: "In the beginning" },
    ])
  })

  it("is case-insensitive when aligning but renders the candidate's own casing", () => {
    const segments = diffSourceTokens("in the beginning", "In the Beginning")
    expect(segments).toEqual([{ kind: "equal", text: "In the Beginning" }])
  })

  it("merges adjacent segments of the same kind", () => {
    const segments = diffSourceTokens("one", "one two three")
    expect(segments).toEqual([
      { kind: "equal", text: "one " },
      { kind: "added", text: "two three" },
    ])
  })

  it("skips the diff for paragraph-length candidates", () => {
    const long = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ")
    const segments = diffSourceTokens("word0", long)
    expect(segments).toEqual([{ kind: "equal", text: long }])
  })

  it("handles an empty candidate", () => {
    expect(diffSourceTokens("In the beginning", "")).toEqual([])
  })
})
