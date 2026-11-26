import { afterEach, describe, expect, it } from "vitest"
import { draftKey, EMPTY_DRAFT, pushDraft, readDraft, startShiftAfter, undoDraft, writeDraft } from "./drafts"
import { shiftTrim } from "@/components/station/useStationEditor"

describe("unsaved Station edits (Q5)", () => {
  afterEach(() => localStorage.clear())
  const key = draftKey({ fileId: "f", cellId: "c", audioId: "a.webm" })

  it("are kept in this browser until saved or undone", () => {
    const d = pushDraft(EMPTY_DRAFT, { ops: [{ kind: "del", a: 1, b: 1.5 }] })
    writeDraft(key, d)
    expect(readDraft(key)?.ops).toEqual([{ kind: "del", a: 1, b: 1.5 }])
    writeDraft(key, EMPTY_DRAFT)
    expect(readDraft(key)).toBeNull()
  })

  it("undo walks back one edit at a time", () => {
    const one = pushDraft(EMPTY_DRAFT, { ops: [{ kind: "del", a: 1, b: 1.5 }] })
    const two = pushDraft(one, { ops: [...one.ops, { kind: "del", a: 0, b: 0.2 }] })
    expect(undoDraft(two)?.ops).toEqual(one.ops)
    expect(undoDraft(undoDraft(two)!)?.ops).toEqual([])
    expect(undoDraft(EMPTY_DRAFT)).toBeNull()
  })

  it("the kept part keeps its sound through an edit; an End at the edge stays at the edge", () => {
    expect(shiftTrim({ kind: "del", a: 1, b: 1.5 }, 0.5, 3, false)).toEqual({ a: 0.5, b: 2.5 })
    expect(shiftTrim({ kind: "del", a: 1, b: 1.5 }, 0.5, 3.64, true)).toEqual({ a: 0.5, b: -1 })
    expect(shiftTrim({ kind: "del", a: 1, b: 1.5 }, 0, 3.64, true)).toBeNull()
  })
})

// AQU-2493 (review, Nov 9), finding 7: each Delete or Insert adds how far it
// moved Start at that moment; Start moved by hand adds nothing.
describe("the Start shift a draft keeps", () => {
  const ins = (at: number, len: number) => ({ kind: "ins" as const, at, src: "x", len, label: "" })
  it("an insert before Start moves it; one after Start, where Start was moved by hand to, does not", () => {
    const first = startShiftAfter(EMPTY_DRAFT, ins(0, 2), 0.2)
    expect(first).toBeCloseTo(2, 9)
    const d = pushDraft(EMPTY_DRAFT, { ops: [{ kind: "del", a: 3, b: 3.2 }], startShiftSec: 0 })
    // Start dragged to 0, then 2 s inserted at 0.1 s: after Start.
    expect(startShiftAfter(d, ins(0.1, 2), 0)).toBe(0)
    // A delete across Start pulls it back to the delete's start.
    expect(startShiftAfter(d, { kind: "del", a: 0, b: 0.8 }, 0.2)).toBeCloseTo(-0.2, 9)
  })

  it("a draft from before the shift was kept stays unknown, and is read as before", () => {
    const old = { ...EMPTY_DRAFT, ops: [{ kind: "del" as const, a: 2, b: 3 }] }
    expect(startShiftAfter(old, ins(0, 1), 0.2)).toBeUndefined()
  })

  it("Undo before saving takes the shift back with its edit", () => {
    const d = pushDraft(EMPTY_DRAFT, { ops: [{ kind: "del", a: 0, b: 0.8 }], startShiftSec: -0.2 })
    const e = pushDraft(d, { ops: [...d.ops, ins(0, 1)], startShiftSec: 0.8 })
    expect(undoDraft(e)?.startShiftSec).toBeCloseTo(-0.2, 9)
  })
})
