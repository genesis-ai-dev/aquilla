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
    parentId: _seq > 1 ? `e${_seq - 1}` : null,
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
    parentId: _seq > 1 ? `e${_seq - 1}` : null,
    kind: "target.cell.commit",
    author,
    serverTs,
    serverSeq: _seq,
    payload: { value },
  }
}

function validate(editEventId: string, author: string, serverTs: number): CommitEvent {
  _seq++
  return {
    id: `e${_seq}`,
    parentId: null,
    kind: "cell.validate",
    author,
    serverTs,
    serverSeq: _seq,
    payload: { editEventId },
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

  it("returns empty array when an AI draft has not been approved", () => {
    const events = [aiCommit("AI draft", 1000)]
    expect(extractPostEditPairs(events, "cell-1", "file-1")).toHaveLength(0)
  })

  it("extracts a single AI→approved-human pair", () => {
    const ai = aiCommit("AI draft text", 1000)
    const human = humanCommit("Human edited text", "alice", 2000)
    const events = [ai, human, validate(human.id, "reviewer", 3000)]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].aiValue).toBe("AI draft text")
    expect(pairs[0].humanValue).toBe("Human edited text")
    expect(pairs[0].author).toBe("reviewer")
    expect(pairs[0].humanTs).toBe(3000)
    expect(pairs[0].reviewTimeMs).toBe(2000)
    expect(pairs[0].acceptedAsIs).toBe(false)
    expect(pairs[0].ned).toBeGreaterThan(0)
    expect(pairs[0].ned).toBeLessThanOrEqual(1)
  })

  it("attributes approval to the most recent AI re-draft", () => {
    const ai1 = aiCommit("AI draft 1", 1000)
    const ai2 = aiCommit("AI draft 2", 1500)
    const human = humanCommit("Human final", "bob", 2000)
    const events = [ai1, ai2, human, validate(human.id, "reviewer", 2500)]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].aiValue).toBe("AI draft 2")
    expect(pairs[0].humanValue).toBe("Human final")
  })

  it("records direct validation as accepted-as-is with ned = 0", () => {
    const ai = aiCommit("Perfect draft", 1000)
    const events = [ai, validate(ai.id, "alice", 2000)]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].ned).toBe(0)
    expect(pairs[0].acceptedAsIs).toBe(true)
  })

  it("extracts ned = 1 for completely replaced text", () => {
    const ai = aiCommit("aaaa", 1000)
    const human = humanCommit("bbbb", "alice", 2000)
    const events = [ai, human, validate(human.id, "alice", 2500)]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(1)
    expect(pairs[0].ned).toBe(1)
  })

  it("extracts multiple pairs from a single cell history", () => {
    const ai1 = aiCommit("First AI draft", 1000)
    const human1 = humanCommit("First human edit", "alice", 2000)
    const validation1 = validate(human1.id, "alice", 2500)
    const ai2 = aiCommit("Second AI draft", 3000)
    const human2 = humanCommit("Second human edit", "bob", 4000)
    const validation2 = validate(human2.id, "bob", 4500)
    const events = [ai1, human1, validation1, ai2, human2, validation2]
    const pairs = extractPostEditPairs(events, "cell-1", "file-1")
    expect(pairs).toHaveLength(2)
    expect(pairs[0].author).toBe("alice")
    expect(pairs[1].author).toBe("bob")
  })

  it("includes cellId and fileId on each pair", () => {
    const events = [
      aiCommit("draft", 1000),
    ]
    const human = humanCommit("edited", "alice", 2000)
    events.push(human, validate(human.id, "alice", 2500))
    const pairs = extractPostEditPairs(events, "my-cell", "my-file")
    expect(pairs[0].cellId).toBe("my-cell")
    expect(pairs[0].fileId).toBe("my-file")
  })

  it("sorts events by serverSeq before processing (handles out-of-order input)", () => {
    // Provide events in reverse order
    const e1 = aiCommit("AI draft", 1000)
    const e2 = humanCommit("Human edit", "alice", 2000)
    const e3 = validate(e2.id, "alice", 2500)
    // Pass in reverse order
    const pairs = extractPostEditPairs([e3, e2, e1], "cell-1", "file-1")
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
    expect(result.acceptanceRate).toBe(0)
    expect(result.overallAvgReviewMs).toBe(0)
    expect(result.byWeek).toHaveLength(0)
    expect(result.byUser).toHaveLength(0)
  })

  it("computes correct averages", () => {
    const pairs = [
      { cellId: "c1", fileId: "f1", aiValue: "a", humanValue: "a", ned: 0, insertions: 0, deletions: 0, substitutions: 0, author: "alice", humanTs: new Date("2024-01-10T00:00:00Z").getTime(), aiTs: 0, acceptedAsIs: true, reviewTimeMs: 1000 },
      { cellId: "c2", fileId: "f1", aiValue: "a", humanValue: "c", ned: 0.3, insertions: 0, deletions: 0, substitutions: 1, author: "alice", humanTs: new Date("2024-01-11T00:00:00Z").getTime(), aiTs: 0, acceptedAsIs: false, reviewTimeMs: 3000 },
      { cellId: "c3", fileId: "f1", aiValue: "a", humanValue: "d", ned: 0.8, insertions: 0, deletions: 0, substitutions: 1, author: "bob",   humanTs: new Date("2024-01-17T00:00:00Z").getTime(), aiTs: 0, acceptedAsIs: false, reviewTimeMs: 5000 },
    ]
    const result = aggregatePostEditMetrics(pairs)
    expect(result.totalCount).toBe(3)
    expect(result.overallAvgNed).toBeCloseTo((0 + 0.3 + 0.8) / 3, 5)
    expect(result.acceptanceRate).toBeCloseTo(1 / 3, 5)
    expect(result.overallAvgReviewMs).toBe(3000)

    // Week 2024-01-08: alice×2
    const week1 = result.byWeek.find((w) => w.weekStart === "2024-01-08")
    expect(week1).toBeDefined()
    expect(week1!.count).toBe(2)
    expect(week1!.avgNed).toBeCloseTo((0 + 0.3) / 2, 5)

    // Week 2024-01-15: bob×1
    const week2 = result.byWeek.find((w) => w.weekStart === "2024-01-15")
    expect(week2).toBeDefined()
    expect(week2!.count).toBe(1)
    expect(week2!.avgNed).toBeCloseTo(0.8, 5)

    // By user
    const aliceStats = result.byUser.find((u) => u.author === "alice")
    expect(aliceStats?.count).toBe(2)
    expect(aliceStats?.avgNed).toBeCloseTo((0 + 0.3) / 2, 5)

    const bobStats = result.byUser.find((u) => u.author === "bob")
    expect(bobStats?.count).toBe(1)
    expect(bobStats?.avgNed).toBeCloseTo(0.8, 5)
  })

  it("returns byWeek sorted chronologically", () => {
    const pairs = [
      { cellId: "c1", fileId: "f1", aiValue: "a", humanValue: "b", ned: 0.5, insertions: 0, deletions: 0, substitutions: 1, author: "alice", humanTs: new Date("2024-01-17T00:00:00Z").getTime(), aiTs: 0, acceptedAsIs: false, reviewTimeMs: 1000 },
      { cellId: "c2", fileId: "f1", aiValue: "a", humanValue: "c", ned: 0.3, insertions: 0, deletions: 0, substitutions: 1, author: "alice", humanTs: new Date("2024-01-03T00:00:00Z").getTime(), aiTs: 0, acceptedAsIs: false, reviewTimeMs: 1000 },
    ]
    const result = aggregatePostEditMetrics(pairs)
    expect(result.byWeek[0].weekStart < result.byWeek[1].weekStart).toBe(true)
  })
})
