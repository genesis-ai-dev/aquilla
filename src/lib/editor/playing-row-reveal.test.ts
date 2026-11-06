import { describe, expect, it } from "vitest"
import { isPlaybackStart, rowNeedsReveal } from "./playing-row-reveal"

describe("isPlaybackStart", () => {
  it("is a start when a row that was silent begins to sound", () => {
    expect(isPlaybackStart(false, true)).toBe(true)
  })

  it("is not a start while the row keeps playing", () => {
    expect(isPlaybackStart(true, true)).toBe(false)
  })

  it("is not a start when playback stops", () => {
    expect(isPlaybackStart(true, false)).toBe(false)
    expect(isPlaybackStart(false, false)).toBe(false)
  })

  // AQU-1636: the regression itself. A virtualized row remounts while its
  // clip is already sounding; treating that first observation as a start is
  // what scrolled the list back onto the playing row and stopped the user
  // from scrolling away.
  it("is not a start on a row's first observation of an already-playing clip", () => {
    expect(isPlaybackStart(null, true)).toBe(false)
  })

  it("is not a start on a first observation of a silent row", () => {
    expect(isPlaybackStart(null, false)).toBe(false)
  })
})

describe("rowNeedsReveal", () => {
  const viewport = { top: 100, bottom: 700 }

  it("leaves a row that is wholly inside the viewport alone", () => {
    expect(rowNeedsReveal({ top: 200, bottom: 300 }, viewport)).toBe(false)
  })

  it("reveals a row above the viewport", () => {
    expect(rowNeedsReveal({ top: -50, bottom: 40 }, viewport)).toBe(true)
  })

  it("reveals a row below the viewport", () => {
    expect(rowNeedsReveal({ top: 900, bottom: 1000 }, viewport)).toBe(true)
  })

  it("reveals a row that straddles the viewport's top edge", () => {
    expect(rowNeedsReveal({ top: 60, bottom: 260 }, viewport)).toBe(true)
  })

  it("reveals a row that straddles the viewport's bottom edge", () => {
    expect(rowNeedsReveal({ top: 600, bottom: 760 }, viewport)).toBe(true)
  })

  // AQU-1636: an expanded cell on a transcribed media file can be taller than
  // the list viewport. It already covers the screen, so moving it only drags
  // text out from under the reader.
  it("leaves a row taller than the viewport alone while it covers the viewport", () => {
    expect(rowNeedsReveal({ top: 20, bottom: 900 }, viewport)).toBe(false)
  })

  it("measures against the list viewport, not the window", () => {
    // A row sitting under a sticky header: visible in the window, hidden in
    // the list's own scroll container.
    expect(rowNeedsReveal({ top: 10, bottom: 90 }, viewport)).toBe(true)
  })

  it("treats a row flush with both viewport edges as readable", () => {
    expect(rowNeedsReveal({ top: 100, bottom: 700 }, viewport)).toBe(false)
  })
})
