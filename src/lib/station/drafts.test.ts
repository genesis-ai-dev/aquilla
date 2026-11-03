import { afterEach, describe, expect, it } from "vitest"
import { draftKey, EMPTY_DRAFT, pushDraft, readDraft, undoDraft, writeDraft } from "./drafts"
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
