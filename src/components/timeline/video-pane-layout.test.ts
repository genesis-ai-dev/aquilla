import { describe, it, expect, beforeEach } from "vitest"
import {
  shouldShowVideoPane,
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
  beforeEach(() => localStorage.removeItem("codex:video-pane-width"))

  it("round-trips a width", () => {
    writeStoredVideoPaneWidth(340)
    expect(readStoredVideoPaneWidth()).toBe(340)
  })

  it("falls back to the default when unset or nonsense", () => {
    expect(readStoredVideoPaneWidth()).toBe(VIDEO_PANE_DEFAULT_WIDTH)
    localStorage.setItem("codex:video-pane-width", "not-a-number")
    expect(readStoredVideoPaneWidth()).toBe(VIDEO_PANE_DEFAULT_WIDTH)
    // A stored width below the floor would render a pane too narrow to read.
    localStorage.setItem("codex:video-pane-width", String(VIDEO_PANE_MIN_WIDTH - 50))
    expect(readStoredVideoPaneWidth()).toBe(VIDEO_PANE_DEFAULT_WIDTH)
  })
})
