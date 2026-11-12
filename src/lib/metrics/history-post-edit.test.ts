// AQU-1321 — per-cell post-editing distance in the Edit History drawer.
//
// These tests encode WHY each rule exists, because every one of them is a
// judgement about what the reader is being shown on the card next to the
// number: a reading that contradicts the card is worse than no reading.
import { describe, it, expect } from "vitest"
import { derivePostEditSeries } from "./history-post-edit"
import type { CellHistoryEntry } from "@/lib/parsers/types"

let clock = 0

function entry(
  source: "human" | "llm",
  value: string,
  extra: Partial<CellHistoryEntry> = {},
): CellHistoryEntry {
  clock += 1000
  return {
    timestamp: new Date(clock).toISOString(),
    value,
    source,
    author: source === "llm" ? "gpt" : "ana",
    validated: false,
    ...extra,
  }
}

describe("derivePostEditSeries", () => {
  it("reads a human revision against the draft above it", () => {
    // "the value matches what a tester sees by comparing the two versions in
    // Edit History" — so the pair must be exactly the two cards on screen.
    const history = [entry("llm", "abcdefghij"), entry("human", "abcdefghXY")]
    const series = derivePostEditSeries(history)

    expect(series[0]).toBeNull()
    expect(series[1]?.draftIndex).toBe(0)
    // Two of ten characters substituted → 80% of the draft survived.
    expect(series[1]?.keptFraction).toBeCloseTo(0.8)
    expect(series[1]?.ned).toBeCloseTo(0.2)
    expect(series[1]?.acceptedAsIs).toBe(false)
  })

  it("reports a rewritten-from-scratch cell as ~0% kept", () => {
    const series = derivePostEditSeries([
      entry("llm", "aaaaaaaa"),
      entry("human", "ZZZZZZZZ"),
    ])
    expect(series[1]?.keptFraction).toBeCloseTo(0)
  })

  it("reports a validated draft nobody edited as 100% kept", () => {
    const series = derivePostEditSeries([entry("llm", "good enough", { validated: true })])
    expect(series[0]).toEqual({
      keptFraction: 1,
      ned: 0,
      draftIndex: 0,
      acceptedAsIs: true,
    })
  })

  it("does not call an unreviewed draft 100% kept", () => {
    // Nobody has looked at it yet. "100% kept" would claim a human approved it,
    // which is the single most misleading thing this number could say.
    expect(derivePostEditSeries([entry("llm", "untouched")])).toEqual([null])
  })

  it("excludes a cell that was never AI-drafted", () => {
    // AC: human-authored cells must not distort the project average, and must
    // not show a number here either — there is no draft to have survived.
    const series = derivePostEditSeries([
      entry("human", "typed"),
      entry("human", "typed out", { validated: true }),
    ])
    expect(series).toEqual([null, null])
  })

  it("attaches the reading to the last edit of a keystroke run, not the first", () => {
    // The drawer collapses this run into one card and renders only the terminal
    // entry. A reading on the first keystroke would be inside the collapsed
    // section — present in the data and invisible on screen.
    const history = [
      entry("llm", "abcdefghij"),
      entry("human", "abcdefghi"),
      entry("human", "abcdefgh"),
      entry("human", "abcdefgZZ"),
    ]
    const series = derivePostEditSeries(history)

    expect(series[1]).toBeNull()
    expect(series[2]).toBeNull()
    expect(series[3]?.draftIndex).toBe(0)
    // Measured against where the human ended up, not their first stroke.
    expect(series[3]?.keptFraction).toBeCloseTo(1 - normalized("abcdefghij", "abcdefgZZ"))
  })

  it("measures a re-draft against the closest draft, not the first one", () => {
    const history = [
      entry("llm", "first attempt entirely"),
      entry("llm", "second attempt"),
      entry("human", "second attempt!"),
    ]
    const series = derivePostEditSeries(history)

    expect(series[2]?.draftIndex).toBe(1)
    // One character added to a 14-character draft.
    expect(series[2]?.keptFraction).toBeCloseTo(1 - 1 / 15)
  })

  it("gives a second, later human edit no reading of its own", () => {
    // A separate edit session that reworks the human's own text is not the
    // draft being eroded further, and reporting it as draft survival double
    // counts one draft against two revisions.
    const history = [
      entry("llm", "draft text"),
      entry("human", "draft text edited"),
      entry("llm", "fresh draft"),
      entry("human", "fresh draft ok"),
    ]
    const series = derivePostEditSeries(history)
    expect(series[1]?.draftIndex).toBe(0)
    expect(series[3]?.draftIndex).toBe(2)
  })

  it("skips a stale branch rather than measuring against it", () => {
    // The card for a stale entry says the edit never became the cell's value.
    // A survival number on it would contradict the badge beside it.
    const history = [
      entry("llm", "abcdefghij"),
      entry("human", "totally different", { isStale: true }),
      entry("human", "abcdefghXY"),
    ]
    const series = derivePostEditSeries(history)

    expect(series[1]).toBeNull()
    expect(series[2]?.draftIndex).toBe(0)
    expect(series[2]?.keptFraction).toBeCloseTo(0.8)
  })

  it("skips an entry whose sync failed", () => {
    const history = [
      entry("llm", "abcdefghij"),
      entry("human", "abcdefghXY", { syncState: "failed" }),
    ]
    expect(derivePostEditSeries(history)).toEqual([null, null])
  })

  it("does not read a human edit against a stale draft", () => {
    // The draft itself never applied, so the human cannot have worked from it.
    const history = [
      entry("llm", "never applied", { isStale: true }),
      entry("human", "hand written"),
    ]
    expect(derivePostEditSeries(history)).toEqual([null, null])
  })

  it("treats a draft emptied by the human as nothing kept, without dividing by zero", () => {
    const series = derivePostEditSeries([entry("llm", "some draft"), entry("human", "")])
    expect(series[1]?.keptFraction).toBe(0)
  })

  it("returns an empty series for an empty history", () => {
    expect(derivePostEditSeries([])).toEqual([])
  })
})

/** Mirror of normalizedEditDistance, kept local so the expectation is legible. */
function normalized(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i++) dp[i][0] = i
  for (let j = 0; j < cols; j++) dp[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length] / Math.max(a.length, b.length)
}
