// Decision 11: one person's history on two devices, merged step by step.
import { describe, it, expect } from "vitest"
import { mergeHistories, type HistoryDoc } from "./history-merge"
import type { StepRecord } from "./history"

const LIMITS = { steps: 100, log: 30 }
const rec = (id: string, at: number, movedAt?: number): StepRecord => ({
  id,
  kind: "test",
  data: {},
  labelKey: id,
  at,
  ...(movedAt !== undefined ? { movedAt } : {}),
})
const doc = (d: Partial<HistoryDoc>): HistoryDoc => ({ undo: [], redo: [], log: [], gone: [], ...d })
const ids = (d: HistoryDoc) => ({ undo: d.undo.map((r) => r.id), redo: d.redo.map((r) => r.id) })

describe("merging two copies of one history", () => {
  it("keeps every step either device made, oldest first", () => {
    const a = doc({ undo: [rec("a1", 1), rec("a2", 3)] })
    const b = doc({ undo: [rec("b1", 2), rec("b2", 4)] })
    expect(ids(mergeHistories(a, b, LIMITS))).toEqual({ undo: ["a1", "b1", "a2", "b2"], redo: [] })
    // The same history whichever copy merges the other.
    expect(ids(mergeHistories(b, a, LIMITS))).toEqual({ undo: ["a1", "b1", "a2", "b2"], redo: [] })
  })

  it("the device that moved a step last says where it is", () => {
    // A undid s2 at t=10; B, which still holds it on Undo, never touched it.
    const a = doc({ undo: [rec("s1", 1)], redo: [rec("s2", 2, 10)] })
    const b = doc({ undo: [rec("s1", 1), rec("s2", 2)] })
    expect(ids(mergeHistories(b, a, LIMITS))).toEqual({ undo: ["s1"], redo: ["s2"] })
    // …and redoing it on B later (t=20) wins over A's undo.
    const b2 = doc({ undo: [rec("s1", 1), rec("s2", 2, 20)] })
    expect(ids(mergeHistories(a, b2, LIMITS))).toEqual({ undo: ["s1", "s2"], redo: [] })
  })

  it("two devices undoing the same step leave it on Redo once", () => {
    const a = doc({ undo: [rec("s1", 1)], redo: [rec("s2", 2, 10)] })
    const b = doc({ undo: [rec("s1", 1)], redo: [rec("s2", 2, 11)] })
    const merged = mergeHistories(a, b, LIMITS)
    expect(ids(merged)).toEqual({ undo: ["s1"], redo: ["s2"] })
    expect(merged.redo[0].movedAt).toBe(11)
  })

  it("a step that left one copy for good never comes back from the other", () => {
    // A's undo of s2 was skipped (someone changed it): it left A's stacks.
    const a = doc({ undo: [rec("s1", 1)], gone: [{ id: "s2", at: 10 }] })
    const b = doc({ undo: [rec("s1", 1), rec("s2", 2)] })
    const merged = mergeHistories(b, a, LIMITS)
    expect(ids(merged)).toEqual({ undo: ["s1"], redo: [] })
    expect(merged.gone.map((g) => g.id)).toEqual(["s2"])
  })

  it("a step undone before another device made a new one can no longer be redone", () => {
    // A undid s2 at t=10. B, offline, made s3 at t=12 without knowing.
    const a = doc({ undo: [rec("s1", 1)], redo: [rec("s2", 2, 10)] })
    const b = doc({ undo: [rec("s1", 1), rec("s3", 12)] })
    const merged = mergeHistories(a, b, LIMITS)
    expect(ids(merged)).toEqual({ undo: ["s1", "s3"], redo: [] })
    expect(merged.gone.map((g) => g.id)).toContain("s2")
  })

  it("keeps Redo in the order it redoes: the step undone last comes back first", () => {
    const a = doc({ undo: [rec("s1", 1)], redo: [rec("s3", 3, 10), rec("s2", 2, 11)] })
    expect(ids(mergeHistories(a, doc({}), LIMITS)).redo).toEqual(["s3", "s2"])
  })

  it("keeps the newest steps up to the limit, and one copy of each skipped entry", () => {
    const many = Array.from({ length: 6 }, (_, i) => rec(`s${i}`, i))
    const entry = { id: "x", labelKey: "x", which: "undo" as const, reason: "changed" as const, at: 5 }
    const merged = mergeHistories(doc({ undo: many, log: [entry] }), doc({ log: [entry] }), { steps: 4, log: 30 })
    expect(ids(merged).undo).toEqual(["s2", "s3", "s4", "s5"])
    expect(merged.log).toHaveLength(1)
  })
})
