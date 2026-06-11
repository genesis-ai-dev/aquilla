import { describe, it, expect, beforeEach } from "vitest"
import {
  extractPostEditPairs,
  aggregatePostEditMetrics,
  weekStart,
  type CommitEvent,
} from "./post-edit-metrics"

// ── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0
function aiCommit(value: string, serverTs: number): CommitEvent {
  _seq++
  return {
    id: `e${_seq}`,
    parentId: null,
    kind: "target.cell.commit",
    author: "ai-bot",
    serverTs,
    serverSeq: _seq,
    payload: { value, ai_suggestion: true },
  }
}

function humanCommit(value: string, author: string, serverTs: number): CommitEvent {
  _seq++
  return {
    id: `e${_seq}`,
    parentId: null,
    kind: "target.cell.commit",
    author,
    serverTs,
    serverSeq: _seq,
    payload: { value },
  }
}

// ── weekStart ────────────────────────────────────────────────────────────────

describe("weekStart", () => {
  it("returns the Monday of the given week", () => {
    // 2024-01-10 is a Wednesday → Monday is 2024-01-08
    const d = new Date("2024-01-10T12:00:00Z").getTime()
    expect(weekStart(d)).toBe("2024-01-08")
  })

  it("Monday stays on Monday", () => {
    const d = new Date("2024-01-08T00:00:00Z").getTime()
    expect(weekStart(d)).toBe("2024-01-08")
  })

  it("Sunday goes back 6 days to Monday", () => {
    const d = new Date("2024-01-14T23:59:00Z").getTime()
    expect(weekStart(d)).toBe("2024-01-08")
  })
})

// ── extractPostEditPairs ─────────────────────────────────────────────────────

describe("extractPostEditPairs", () => {
  beforeEach(() => { _seq = 0 })

  it("returns empty array when no AI commits exist", () => {
    const events = [
      humanCommit("In the beginning", "alice", 1000),
      humanCommit("At the start", "alice", 2000),
    ]
    expect(extractPostEditPairs(events, "cell-1", "file-1")).toHaveLength(0)
  })

  it("returns empty array when AI commit has no following human commit", () => {
    const events = [aiCommit("AI draft", 1000)]
    expect(extractPostEditPairs(events, "cell-1", "file-1")).toHaveLength(0)
  })

  it("extracts a single AI→human pair", () => {
    const events = [
      aiCommit("AI draft text", 1000),
      humanCommit("Human edited text", "alice", 2000),
    ]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].aiValue).toBe("AI draft text")
    expect(pairs[0].humanValue).toBe("Human edited text")
    expect(pairs[0].author).toBe("alice")
    expect(pairs[0].humanTs).toBe(2000)
    expect(pairs[0].ned).toBeGreaterThan(0)
    expect(pairs[0].ned).toBeLessThanOrEqual(1)
  })

  it("skips consecutive AI re-drafts before finding the human edit", () => {
    const events = [
      aiCommit("AI draft 1", 1000),
      aiCommit("AI draft 2", 1500),
      humanCommit("Human final", "bob", 2000),
    ]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    // Only one pair: first AI commit → first human commit
    expect(pairs).toHaveLength(1)
    expect(pairs[0].aiValue).toBe("AI draft 1")
    expect(pairs[0].humanValue).toBe("Human final")
  })

  it("extracts ned = 0 for identical AI and human values", () => {
    const events = [
      aiCommit("Perfect draft", 1000),
      humanCommit("Perfect draft", "alice", 2000),
    ]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].ned).toBe(0)
  })

  it("extracts ned = 1 for completely replaced text", () => {
    const events = [
      aiCommit("aaaa", 1000),
      humanCommit("bbbb", "alice", 2000),
    ]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].ned).toBe(1)
  })

  it("extracts multiple pairs from a single cell history", () => {
    const events = [
      aiCommit("First AI draft", 1000),
      humanCommit("First human edit", "alice", 2000),
      aiCommit("Second AI draft", 3000),
      humanCommit("Second human edit", "bob", 4000),
    ]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(2)
    expect(pairs[0].author).toBe("alice")
    expect(pairs[1].author).toBe("bob")
  })

  it("includes cellId and fileId on each pair", () => {
    const events = [
      aiCommit("draft", 1000),
      humanCommit("edited", "alice", 2000),
    ]
    const pairs = extractPostEditPairs(events, "my-cell", "my-file")
    expect(pairs[0].cellId).toBe("my-cell")
    expect(pairs[0].fileId).toBe("my-file")
  })

  it("sorts events by serverSeq before processing (handles out-of-order input)", () => {
    // Provide events in reverse order
    const e1 = aiCommit("AI draft", 1000)
    const e2 = humanCommit("Human edit", "alice", 2000)
    // Pass in reverse order
    const pairs = extractPostEditPairs([e2, e1], "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].aiValue).toBe("AI draft")
  })
})

// ── aggregatePostEditMetrics ─────────────────────────────────────────────────

describe("aggregatePostEditMetrics", () => {
  it("returns empty metrics for empty pairs array", () => {
    const result = aggregatePostEditMetrics([])
    expect(result.totalCount).toBe(0)
    expect(result.overallAvgNed).toBe(0)
    expect(result.byWeek).toHaveLength(0)
    expect(result.byUser).toHaveLength(0)
  })

  it("computes correct averages", () => {
    const pairs = [
      { cellId: "c1", fileId: "f1", aiValue: "a", humanValue: "b", ned: 0.5, author: "alice", humanTs: new Date("2024-01-10T00:00:00Z").getTime(), aiTs: 0 },
      { cellId: "c2", fileId: "f1", aiValue: "a", humanValue: "c", ned: 0.3, author: "alice", humanTs: new Date("2024-01-11T00:00:00Z").getTime(), aiTs: 0 },
      { cellId: "c3", fileId: "f1", aiValue: "a", humanValue: "d", ned: 0.8, author: "bob",   humanTs: new Date("2024-01-17T00:00:00Z").getTime(), aiTs: 0 },
    ]
    const result = aggregatePostEditMetrics(pairs)
    expect(result.totalCount).toBe(3)
    expect(result.overallAvgNed).toBeCloseTo((0.5 + 0.3 + 0.8) / 3, 5)

    // Week 2024-01-08: alice×2
    const week1 = result.byWeek.find((w) => w.weekStart === "2024-01-08")
    expect(week1).toBeDefined()
    expect(week1!.count).toBe(2)
    expect(week1!.avgNed).toBeCloseTo((0.5 + 0.3) / 2, 5)

    // Week 2024-01-15: bob×1
    const week2 = result.byWeek.find((w) => w.weekStart === "2024-01-15")
    expect(week2).toBeDefined()
    expect(week2!.count).toBe(1)
    expect(week2!.avgNed).toBeCloseTo(0.8, 5)

    // By user
    const aliceStats = result.byUser.find((u) => u.author === "alice")
    expect(aliceStats?.count).toBe(2)
    expect(aliceStats?.avgNed).toBeCloseTo((0.5 + 0.3) / 2, 5)

    const bobStats = result.byUser.find((u) => u.author === "bob")
    expect(bobStats?.count).toBe(1)
    expect(bobStats?.avgNed).toBeCloseTo(0.8, 5)
  })

  it("returns byWeek sorted chronologically", () => {
    const pairs = [
      { cellId: "c1", fileId: "f1", aiValue: "a", humanValue: "b", ned: 0.5, author: "alice", humanTs: new Date("2024-01-17T00:00:00Z").getTime(), aiTs: 0 },
      { cellId: "c2", fileId: "f1", aiValue: "a", humanValue: "c", ned: 0.3, author: "alice", humanTs: new Date("2024-01-03T00:00:00Z").getTime(), aiTs: 0 },
    ]
    const result = aggregatePostEditMetrics(pairs)
    expect(result.byWeek[0].weekStart < result.byWeek[1].weekStart).toBe(true)
  })
})
