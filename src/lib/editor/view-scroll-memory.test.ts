// AQU-2153: the remember/restore decision behind "each view resumes where you
// left it" — which switches need it, and whose place belongs to whom.

import { describe, expect, it } from "vitest"
import { cellIdForMediaTrace, createViewScrollMemory, viewSwitchRebuilds } from "./view-scroll-memory"

describe("viewSwitchRebuilds", () => {
  it("is true for every switch into or out of Transcribe", () => {
    // Transcribe replaces the editor table with its own list, so the view
    // being left is torn down and the one being entered is built at row 1.
    expect(viewSwitchRebuilds("text", "transcribe")).toBe(true)
    expect(viewSwitchRebuilds("transcribe", "text")).toBe(true)
    expect(viewSwitchRebuilds("audio", "transcribe")).toBe(true)
    expect(viewSwitchRebuilds("transcribe", "audio")).toBe(true)
  })

  it("is false for Text ↔ Media, which share the mounted table", () => {
    // Remembering a row here would put the table back where it stood two
    // visits ago instead of leaving the place it already holds — and it would
    // override the AQU-646 Media → Text trace on a timed video file.
    expect(viewSwitchRebuilds("text", "audio")).toBe(false)
    expect(viewSwitchRebuilds("audio", "text")).toBe(false)
  })

  it("is false when the lens is not changing", () => {
    for (const lens of ["text", "audio", "transcribe"] as const) {
      expect(viewSwitchRebuilds(lens, lens)).toBe(false)
    }
  })
})

describe("cellIdForMediaTrace", () => {
  const at = (index: number) => (index === 40 ? "luke-5" : undefined)

  it("opens Media on the row at the top of the text", () => {
    expect(cellIdForMediaTrace("luke-5", 0, at)).toBe("luke-5")
  })

  it("does not treat an unmeasured index of 0 as the start of the file", () => {
    // The virtualizer reports 0 when the rows above the window were never
    // measured. Seeding that is what opened a later chapter back at chapter 1.
    expect(cellIdForMediaTrace(null, 0, at)).toBeNull()
    expect(cellIdForMediaTrace(null, -1, at)).toBeNull()
  })

  it("uses a later measured index when the top row cannot be read", () => {
    expect(cellIdForMediaTrace(null, 40, at)).toBe("luke-5")
  })
})

describe("createViewScrollMemory", () => {
  it("gives back the row each view of each file was left at", () => {
    const memory = createViewScrollMemory()
    memory.remember("f1", "text", "c40")
    memory.remember("f1", "transcribe", "c30")
    expect(memory.recall("f1", "text")).toBe("c40")
    expect(memory.recall("f1", "transcribe")).toBe("c30")
  })

  it("never lets one file inherit another file's place", () => {
    // Two file tabs scrolled to different rows: switching tab → Transcribe →
    // back must resume each file's own row, not the other's.
    const memory = createViewScrollMemory()
    memory.remember("f1", "text", "f1-c40")
    memory.remember("f2", "text", "f2-c10")
    expect(memory.recall("f1", "text")).toBe("f1-c40")
    expect(memory.recall("f2", "text")).toBe("f2-c10")
  })

  it("reports a first visit to a view as no remembered row", () => {
    const memory = createViewScrollMemory()
    memory.remember("f1", "text", "c40")
    expect(memory.recall("f1", "audio")).toBeNull()
    expect(memory.recall("f3", "text")).toBeNull()
  })

  it("forgets the row when there is none to remember", () => {
    // A view left before it rendered a measurable row hands back null, and
    // that must clear the stale row rather than resume an older position.
    const memory = createViewScrollMemory()
    memory.remember("f1", "text", "c40")
    memory.remember("f1", "text", null)
    expect(memory.recall("f1", "text")).toBeNull()
  })

  it("ignores a file-less remember and recall", () => {
    const memory = createViewScrollMemory()
    memory.remember(null, "text", "c40")
    expect(memory.recall(null, "text")).toBeNull()
    expect(memory.recall("f1", "text")).toBeNull()
  })
})
