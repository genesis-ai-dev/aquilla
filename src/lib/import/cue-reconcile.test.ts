// Reconciling an audio VTT against the cues already imported.
// (AQU-646 stage 4, 2026-08-14)
//
// The whole value of this operation is that a surviving cue KEEPS ITS CELL ID,
// which is what leaves its recordings and its subtitle pairings attached
// without copying or re-deriving anything. So the assertions that matter most
// are about identity: which cues keep their ids, and which ones don't.

import { describe, it, expect } from "vitest"

import { planCueReconcile, normalizeCueText, type ReconcilableCue } from "./cue-reconcile"
import type { TranslatableString } from "@/lib/parsers/types"

const was = (id: string, start: number, end: number, original: string): ReconcilableCue => ({
  id,
  startTime: start,
  endTime: end,
  original,
  sourceEventId: `evt-${id}`,
  sequenceIndex: Number(id.replace(/\D/g, "")) || 0,
})

const now = (start: number, end: number, original: string): TranslatableString => ({
  id: "ignored",
  original,
  translated: "",
  context: "",
  group: "",
  type: "cue",
  start,
  end,
})

/** Predictable ids so a create can be asserted by name. */
function minter() {
  let n = 0
  return () => `new-${++n}`
}

const plan = (
  existing: ReconcilableCue[],
  incoming: TranslatableString[],
  hasTake?: (id: string) => boolean,
) => planCueReconcile({ existing, incoming, hasTake, mintId: minter() })

describe("normalizeCueText", () => {
  it("treats case, punctuation and markup as presentation", () => {
    expect(normalizeCueText("<i>Two, please.</i>")).toBe(normalizeCueText("TWO PLEASE"))
  })
  it("keeps apostrophes, which are part of the word", () => {
    expect(normalizeCueText("don't")).toBe("don't")
  })
})

describe("a pure retime — the frame-rate correction", () => {
  it("keeps every cell id and only moves what moved", () => {
    const p = plan(
      [was("a", 63.209, 63.667, "Abba?"), was("b", 66.626, 67.751, "You should be sleeping.")],
      [now(63.272, 63.731, "Abba?"), now(66.626, 67.751, "You should be sleeping.")],
    )!
    expect(p.creates).toEqual([])
    expect(p.deletes).toEqual([])
    expect(p.kept).toBe(2)
    expect(p.retimes).toEqual([{ cellId: "a", startMs: 63272, endMs: 63731 }])
  })

  it("matches through a shift far larger than a cue's own length", () => {
    // The reason the plan's "timings must overlap" rule was dropped: a 2.4s
    // drift clears a 0.4s cue's old window completely, and requiring overlap
    // would orphan its take in the exact case this feature exists for.
    const p = plan(
      [was("a", 2353.7, 2354.1, "Never set foot there.")],
      [now(2356.05, 2356.45, "Never set foot there.")],
    )!
    expect(p.kept).toBe(1)
    expect(p.deletes).toEqual([])
    expect(p.maxShiftSec).toBeCloseTo(2.35, 2)
  })

  it("reports nothing to do for an identical file", () => {
    const p = plan([was("a", 1, 2, "Abba?")], [now(1, 2, "Abba?")])!
    expect(p.retimes).toEqual([])
    expect(p.creates).toEqual([])
    expect(p.deletes).toEqual([])
    expect(p.kept).toBe(1)
  })
})

describe("cues that come and go", () => {
  it("creates only the genuinely new cue and leaves its neighbours alone", () => {
    const p = plan(
      [was("a1", 1, 2, "One"), was("a2", 5, 6, "Three")],
      [now(1, 2, "One"), now(3, 4, "Two"), now(5, 6, "Three")],
    )!
    expect(p.deletes).toEqual([])
    expect(p.kept).toBe(2)
    expect(p.creates).toHaveLength(1)
    expect(p.creates[0]).toMatchObject({
      cellId: "new-1",
      value: "Two",
      startMs: 3000,
      endMs: 4000,
      // Anchored to the cue that precedes it in the FINAL time order, so the
      // chain the cells read walks stays coherent.
      anchorCellId: "a1",
    })
  })

  it("anchors a new head cue to null, and the next new one to it", () => {
    const p = plan(
      [was("a9", 10, 11, "Later")],
      [now(1, 2, "First"), now(3, 4, "Second"), now(10, 11, "Later")],
    )!
    expect(p.creates.map((c) => [c.cellId, c.anchorCellId])).toEqual([
      ["new-1", null],
      ["new-2", "new-1"],
    ])
  })

  it("deletes a cue that is gone, carrying the chain head a delete needs", () => {
    const p = plan([was("a1", 1, 2, "One"), was("a2", 3, 4, "Two")], [now(1, 2, "One")])!
    expect(p.deletes).toEqual([{ cellId: "a2", sourceEventId: "evt-a2", hasTake: false }])
    expect(p.kept).toBe(1)
  })

  it("treats a reworded cue as a delete plus a create, never a silent re-point", () => {
    // The bar Sam approved: a take recorded against the old words must not be
    // quietly moved onto new ones. Different wording means a new cell.
    const p = plan([was("a1", 1, 2, "I see him.")], [now(1, 2, "I see her.")])!
    expect(p.deletes.map((d) => d.cellId)).toEqual(["a1"])
    expect(p.creates.map((c) => c.value)).toEqual(["I see her."])
    expect(p.kept).toBe(0)
  })
})

describe("repeated lines", () => {
  it("pairs the Nth 'Yes.' with the Nth 'Yes.', not the first", () => {
    // An episode has dozens of these. Any time-window or index scheme
    // eventually pairs the wrong two; an order-preserving alignment cannot.
    const p = plan(
      [was("y1", 10, 11, "Yes."), was("y2", 50, 51, "Yes."), was("y3", 90, 91, "Yes.")],
      [now(10, 11, "Yes."), now(90, 91, "Yes.")],
    )!
    // The middle one went; the outer two keep their ids and their takes.
    expect(p.deletes.map((d) => d.cellId)).toEqual(["y2"])
    expect(p.retimes).toEqual([])
    expect(p.kept).toBe(2)
  })

  it("keeps alignment when a line is inserted between duplicates", () => {
    const p = plan(
      [was("y1", 10, 11, "No."), was("y2", 50, 51, "No.")],
      [now(10, 11, "No."), now(30, 31, "Wait"), now(50, 51, "No.")],
    )!
    expect(p.deletes).toEqual([])
    expect(p.creates.map((c) => c.value)).toEqual(["Wait"])
  })
})

describe("what it says about recordings before you commit", () => {
  it("counts takes that survive and takes that will be stranded", () => {
    const takes = new Set(["a1", "a2"])
    const p = plan(
      [was("a1", 1, 2, "One"), was("a2", 3, 4, "Two"), was("a3", 5, 6, "Three")],
      [now(1, 2, "One"), now(5, 6, "Three")],
      (id) => takes.has(id),
    )!
    expect(p.keptTakes).toBe(1) // a1 survives
    expect(p.orphanedTakes).toBe(1) // a2 is gone and had a take
    expect(p.deletes.find((d) => d.cellId === "a2")?.hasTake).toBe(true)
  })

  it("reports zero orphans for a pure retime, however far things moved", () => {
    const p = plan(
      [was("a1", 1, 2, "One")],
      [now(100, 101, "One")],
      () => true,
    )!
    expect(p.orphanedTakes).toBe(0)
    expect(p.keptTakes).toBe(1)
  })
})

describe("refusals and edges", () => {
  it("returns null on a first import — nothing to reconcile against", () => {
    expect(plan([], [now(1, 2, "One")])).toBeNull()
  })

  it("returns null when nothing incoming carries a usable timing", () => {
    expect(plan([was("a", 1, 2, "One")], [{ ...now(1, 2, "One"), start: undefined }])).toBeNull()
  })

  it("drops an untimed incoming cue rather than filing it at zero", () => {
    const p = plan(
      [was("a", 1, 2, "One")],
      [now(1, 2, "One"), { ...now(5, 6, "Two"), end: Number.NaN }],
    )!
    expect(p.total).toBe(1)
    expect(p.creates).toEqual([])
  })

  it("surfaces a missing chain head rather than inventing one", () => {
    // A delete without its parent cannot be arbitrated, so the caller has to
    // be able to see that and skip it.
    const p = plan([{ id: "a1", startTime: 1, endTime: 2, original: "One" }], [now(9, 9.5, "Other")])!
    expect(p.deletes[0]).toMatchObject({ cellId: "a1", sourceEventId: null })
  })
})
