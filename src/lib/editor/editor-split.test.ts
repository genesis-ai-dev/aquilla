import { afterEach, describe, expect, it } from "vitest"
import {
  EDITOR_SPLIT_MIN_PX,
  clampEditorSplit,
  editorSplitBounds,
  editorSplitFromPointer,
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

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("clampEditorSplit", () => {
  it("keeps today's even split when nothing is saved", () => {
    expect(clampEditorSplit(null, 1200)).toBeNull()
  })

  it("keeps a saved split that fits", () => {
    expect(clampEditorSplit(0.3, 1200)).toBe(0.3)
  })

  it("clamps a saved split that no longer fits so neither side drops under the minimum", () => {
    // 600px of text: each side needs 240px, so Source may take 240..360px.
    expect(clampEditorSplit(0.1, 600)).toBeCloseTo(EDITOR_SPLIT_MIN_PX / 600)
    expect(clampEditorSplit(0.9, 600)).toBeCloseTo(1 - EDITOR_SPLIT_MIN_PX / 600)
  })

  it("falls back to today's split when the two minimums do not fit", () => {
    expect(clampEditorSplit(0.3, EDITOR_SPLIT_MIN_PX * 2 - 1)).toBeNull()
    expect(editorSplitBounds(EDITOR_SPLIT_MIN_PX * 2 - 1)).toBeNull()
    // No layout yet (width 0) is the same: nothing to clamp against.
    expect(clampEditorSplit(0.3, 0)).toBeNull()
  })

  it("ignores a value that is not a share", () => {
    expect(clampEditorSplit(Number.NaN, 1200)).toBeNull()
  })
})

describe("editorSplitFromPointer", () => {
  it("measures Source from its start edge, minus half the gap, in LTR", () => {
    // Source starts at x=100; pointer at 504 → Source 400px of 1000.
    expect(editorSplitFromPointer({ pointerX: 504, sourceStart: 100, textWidth: 1000, rtl: false })).toBeCloseTo(0.4)
  })

  it("measures from the right in RTL", () => {
    // Source starts at its right edge x=1100; pointer at 696 → Source 400px.
    expect(editorSplitFromPointer({ pointerX: 696, sourceStart: 1100, textWidth: 1000, rtl: true })).toBeCloseTo(0.4)
  })

  it("never drags a side under the minimum", () => {
    expect(editorSplitFromPointer({ pointerX: 0, sourceStart: 100, textWidth: 1000, rtl: false })).toBeCloseTo(0.24)
    expect(editorSplitFromPointer({ pointerX: 5000, sourceStart: 100, textWidth: 1000, rtl: false })).toBeCloseTo(0.76)
  })
})

describe("editorSplitStep", () => {
  it("moves the line the way the arrow points, Shift for bigger steps", () => {
    expect(editorSplitStep(0.5, "ArrowRight", false, false, 1000)).toBeCloseTo(0.516)
    expect(editorSplitStep(0.5, "ArrowLeft", true, false, 1000)).toBeCloseTo(0.436)
  })

  it("mirrors in RTL, where Source is on the right", () => {
    expect(editorSplitStep(0.5, "ArrowLeft", false, true, 1000)).toBeCloseTo(0.516)
    expect(editorSplitStep(0.5, "ArrowRight", false, true, 1000)).toBeCloseTo(0.484)
  })

  it("starts from today's split and ignores other keys", () => {
    expect(editorSplitStep(null, "ArrowRight", false, false, 1000)).toBeCloseTo(0.516)
    expect(editorSplitStep(0.5, "ArrowUp", false, false, 1000)).toBeUndefined()
  })
})

describe("editorSplitVars", () => {
  it("keeps the two tracks summing to 2fr so the other tracks keep their width", () => {
    expect(editorSplitVars(0.25)).toEqual({ source: "0.5fr", target: "1.5fr" })
    expect(editorSplitVars(null)).toBeNull()
  })
})

describe("stored split", () => {
  it("is kept per person on this device", () => {
    setClientLocalStorageOwner("ana")
    writeEditorSplit(0.35)
    expect(readEditorSplit()).toBe(0.35)
    expect(localStorage.getItem(localStorageKeyForOwner("ana", "editor:source-target-split"))).toBe("0.35")

    setClientLocalStorageOwner("ben")
    expect(readEditorSplit()).toBeNull()
  })

  it("forgets the split on reset, and ignores junk", () => {
    setClientLocalStorageOwner("ana")
    writeEditorSplit(0.35)
    writeEditorSplit(null)
    expect(readEditorSplit()).toBeNull()

    localStorage.setItem(localStorageKeyForOwner("ana", "editor:source-target-split"), "wide")
    expect(readEditorSplit()).toBeNull()
    localStorage.setItem(localStorageKeyForOwner("ana", "editor:source-target-split"), "1.5")
    expect(readEditorSplit()).toBeNull()
  })
})
