import { describe, it, expect, beforeEach } from "vitest"
import {
  shouldShowVideoPane,
  clearStoredVideoPaneWidth,
  readStoredVideoPaneWidth,
  writeStoredVideoPaneWidth,
  VIDEO_PANE_DEFAULT_WIDTH,
  VIDEO_PANE_MIN_WIDTH,
} from "./video-pane-layout"

// Nothing in the suite renders ProjectWorkspace, so without these the gate that
// decides whether the pane exists at all would ship with no coverage.
describe("shouldShowVideoPane", () => {
  it("shows the pane in the media lens when a video is linked", () => {
    expect(
      shouldShowVideoPane({ timelineStacked: true, coreMediaUrl: "https://cdn/v.webm", timingMode: "dubbing" }),
    ).toBe(true)
  })

  it("stays hidden in Free timing — the footage cannot follow a re-flowed track", () => {
    expect(
      shouldShowVideoPane({ timelineStacked: true, coreMediaUrl: "https://cdn/v.webm", timingMode: "audioFirst" }),
    ).toBe(false)
  })

  it("stays hidden with no video linked, and outside the media lens", () => {
    expect(
      shouldShowVideoPane({ timelineStacked: true, coreMediaUrl: null, timingMode: "dubbing" }),
    ).toBe(false)
    expect(
      shouldShowVideoPane({ timelineStacked: false, coreMediaUrl: "https://cdn/v.webm", timingMode: "dubbing" }),
    ).toBe(false)
  })
})

describe("video pane width", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a width per file", () => {
    writeStoredVideoPaneWidth("f1", 340)
    expect(readStoredVideoPaneWidth("f1")).toBe(340)
    // Media redesign, layout: each file keeps its own arrangement.
    expect(readStoredVideoPaneWidth("f2")).toBe(VIDEO_PANE_DEFAULT_WIDTH)
  })

  it("starts a file with no width of its own from the width its kind starts at", () => {
    expect(readStoredVideoPaneWidth("f1", 480)).toBe(480)
    // The old shared width no longer decides a file's start.
    localStorage.setItem("aquilla:video-pane-width", "600")
    expect(readStoredVideoPaneWidth("f1", 480)).toBe(480)
  })

  it("falls back to the default when unset or nonsense", () => {
    expect(readStoredVideoPaneWidth("f1")).toBe(VIDEO_PANE_DEFAULT_WIDTH)
    localStorage.setItem("aquilla:video-pane-width:f1", "not-a-number")
    expect(readStoredVideoPaneWidth("f1")).toBe(VIDEO_PANE_DEFAULT_WIDTH)
    // A stored width below the floor would render a pane too narrow to read.
    localStorage.setItem("aquilla:video-pane-width:f1", String(VIDEO_PANE_MIN_WIDTH - 50))
    expect(readStoredVideoPaneWidth("f1")).toBe(VIDEO_PANE_DEFAULT_WIDTH)
  })

  it("forgets a file's width on Reset layout", () => {
    writeStoredVideoPaneWidth("f1", 500)
    clearStoredVideoPaneWidth("f1")
    expect(readStoredVideoPaneWidth("f1", 480)).toBe(480)
  })
})
