import { afterEach, describe, expect, it } from "vitest"
import {
  EDITOR_SPLIT_MIN_PX,
  clampEditorSplit,
  editorSplitBounds,
  editorSplitFromPointer,
  editorSplitShares,
  editorSplitStep,
  editorSplitVars,
  readEditorSplit,
  writeEditorSplit,
} from "./editor-split"
import {
  localStorageKeyForOwner,
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

const KEY = "editor:target-split"

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("clampEditorSplit (Target's share)", () => {
  it("keeps today's equal tracks when nothing is saved", () => {
    expect(clampEditorSplit(null, 1200)).toBeNull()
  })

  it("keeps a saved split that fits", () => {
    expect(clampEditorSplit(0.7, 1200)).toBe(0.7)
  })

  it("clamps a saved split that no longer fits so no track drops under the minimum", () => {
    // 500px of text, two tracks of at least 200px: Target may take 200..300px.
    expect(clampEditorSplit(0.9, 500)).toBeCloseTo(1 - EDITOR_SPLIT_MIN_PX / 500)
    expect(clampEditorSplit(0.1, 500)).toBeCloseTo(EDITOR_SPLIT_MIN_PX / 500)
  })

  it("keeps every Bible column at the minimum too", () => {
    // Source, one Bible, Target in 1000px: the other two need 400px between them.
    expect(editorSplitBounds(1000, 3)).toEqual({ min: 0.2, max: 0.6 })
    expect(clampEditorSplit(0.9, 1000, 3)).toBeCloseTo(0.6)
  })

  it("falls back to today's split when the minimums do not fit", () => {
    expect(clampEditorSplit(0.6, EDITOR_SPLIT_MIN_PX * 2 - 1)).toBeNull()
    expect(editorSplitBounds(EDITOR_SPLIT_MIN_PX * 3 - 1, 3)).toBeNull()
    // No layout yet (width 0) is the same: nothing to clamp against.
    expect(clampEditorSplit(0.6, 0)).toBeNull()
  })

  it("ignores a value that is not a share", () => {
    expect(clampEditorSplit(Number.NaN, 1200)).toBeNull()
  })
})

describe("editorSplitFromPointer", () => {
  it("measures Target back from its end edge, minus half the gap, in LTR", () => {
    // Target ends at x=1100; pointer at 696 → Target 400px of 1000.
    expect(editorSplitFromPointer({ pointerX: 696, targetEnd: 1100, textWidth: 1000, rtl: false })).toBeCloseTo(0.4)
  })

  it("measures from the left in RTL, where Target is on the left", () => {
    // Target ends at its left edge x=100; pointer at 504 → Target 400px.
    expect(editorSplitFromPointer({ pointerX: 504, targetEnd: 100, textWidth: 1000, rtl: true })).toBeCloseTo(0.4)
  })

  it("never drags a track under the minimum", () => {
    expect(editorSplitFromPointer({ pointerX: 5000, targetEnd: 1100, textWidth: 1000, rtl: false })).toBeCloseTo(0.2)
    expect(editorSplitFromPointer({ pointerX: 0, targetEnd: 1100, textWidth: 1000, rtl: false })).toBeCloseTo(0.8)
    expect(editorSplitFromPointer({ pointerX: 0, targetEnd: 1100, textWidth: 1000, tracks: 3, rtl: false })).toBeCloseTo(0.6)
  })
})

describe("editorSplitStep", () => {
  it("moves the line the way the arrow points, Shift for bigger steps", () => {
    // LTR: Target is on the right, so moving the line right narrows it.
    expect(editorSplitStep(0.5, "ArrowRight", false, false, 1000)).toBeCloseTo(0.484)
    expect(editorSplitStep(0.5, "ArrowLeft", true, false, 1000)).toBeCloseTo(0.564)
  })

  it("mirrors in RTL, where Target is on the left", () => {
    expect(editorSplitStep(0.5, "ArrowLeft", false, true, 1000)).toBeCloseTo(0.484)
    expect(editorSplitStep(0.5, "ArrowRight", false, true, 1000)).toBeCloseTo(0.516)
  })

  it("starts from today's equal tracks and ignores other keys", () => {
    expect(editorSplitStep(null, "ArrowLeft", false, false, 1000)).toBeCloseTo(0.516)
    expect(editorSplitStep(null, "ArrowLeft", false, false, 1200, 3)).toBeCloseTo(1 / 3 + 16 / 1200)
    expect(editorSplitStep(0.5, "ArrowUp", false, false, 1000)).toBeUndefined()
  })
})

describe("editorSplitVars", () => {
  it("keeps the shared tracks summing to their count, so the other tracks keep their width", () => {
    expect(editorSplitVars(0.75)).toEqual({ target: "1.5fr", rest: "0.5fr" })
    // Source + one Bible + Target: Target 0.5 → 1.5fr, the other two 0.75fr each.
    expect(editorSplitVars(0.5, 3)).toEqual({ target: "1.5fr", rest: "0.75fr" })
    expect(editorSplitVars(null)).toBeNull()
  })

  it("names each track's share for the screen reader", () => {
    expect(editorSplitShares(null)).toEqual({ target: 0.5, rest: 0.5 })
    expect(editorSplitShares(0.5, 3)).toEqual({ target: 0.5, rest: 0.25 })
  })
})

describe("stored split", () => {
  it("is kept per person on this device", () => {
    setClientLocalStorageOwner("ana")
    writeEditorSplit(0.65)
    expect(readEditorSplit()).toBe(0.65)
    expect(localStorage.getItem(localStorageKeyForOwner("ana", KEY))).toBe("0.65")

    setClientLocalStorageOwner("ben")
    expect(readEditorSplit()).toBeNull()
  })

  it("forgets the split on reset, and ignores junk", () => {
    setClientLocalStorageOwner("ana")
    writeEditorSplit(0.65)
    writeEditorSplit(null)
    expect(readEditorSplit()).toBeNull()

    localStorage.setItem(localStorageKeyForOwner("ana", KEY), "wide")
    expect(readEditorSplit()).toBeNull()
    localStorage.setItem(localStorageKeyForOwner("ana", KEY), "1.5")
    expect(readEditorSplit()).toBeNull()
  })
})
