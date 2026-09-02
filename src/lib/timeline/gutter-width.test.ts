import { describe, it, expect, beforeEach } from "vitest"
import {
  GUTTER_COLLAPSED_PX,
  GUTTER_EXPANDED_PX,
  gutterWidthPx,
  loadGutterCollapsed,
  saveGutterCollapsed,
} from "./gutter-width"

describe("the track gutter's two widths (AQU-646 stage 3b)", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("is narrow enough to be worth collapsing and wide enough to be worth expanding", () => {
    // Not a tautology: the request was "fully expanded so you can see the full
    // name and all the information", and the old 128px is what failed at that.
    // Both new widths therefore have to be on the far side of it.
    expect(GUTTER_COLLAPSED_PX).toBeLessThan(128)
    expect(GUTTER_EXPANDED_PX).toBeGreaterThan(128)
    expect(gutterWidthPx(true)).toBe(GUTTER_COLLAPSED_PX)
    expect(gutterWidthPx(false)).toBe(GUTTER_EXPANDED_PX)
  })

  it("defaults to expanded, so no file ever opens with its tracks anonymous", () => {
    expect(loadGutterCollapsed("f1")).toBe(false)
  })

  it("remembers a collapse against the file it was made on", () => {
    saveGutterCollapsed("f1", true)
    expect(loadGutterCollapsed("f1")).toBe(true)
    // Sam's call, and the point of it: the OTHER file is untouched. A global
    // preference would have each visit undo the other's.
    expect(loadGutterCollapsed("f2")).toBe(false)
  })

  it("leaves no key behind when the gutter is expanded again", () => {
    saveGutterCollapsed("f1", true)
    saveGutterCollapsed("f1", false)
    expect(localStorage.getItem("aquilla:tlGutterCollapsed:f1")).toBeNull()
    expect(loadGutterCollapsed("f1")).toBe(false)
  })

  it("reads anything that is not an explicit yes as expanded", () => {
    // A value from another build, a half-written one, a cleared store. Every
    // one of them should show the names rather than hide them.
    for (const junk of ["0", "true", "", "{}", "null"]) {
      localStorage.setItem("aquilla:tlGutterCollapsed:f1", junk)
      expect(loadGutterCollapsed("f1")).toBe(false)
    }
  })

  it("does nothing at all without a file to key on", () => {
    expect(loadGutterCollapsed(null)).toBe(false)
    expect(loadGutterCollapsed(undefined)).toBe(false)
    expect(loadGutterCollapsed("")).toBe(false)
    // And a save with no file must not invent a key — `aquilla:tlGutterCollapsed:`
    // with an empty suffix would be one preference shared by every fileless
    // caller, which is exactly what per-file storage exists to avoid.
    saveGutterCollapsed(null, true)
    expect(localStorage.length).toBe(0)
  })
})
