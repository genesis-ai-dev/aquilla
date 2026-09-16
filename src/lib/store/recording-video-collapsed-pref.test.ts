// The default here is the whole feature: absent key must read as EXPANDED, or
// the film the recorder was built to show is hidden for everyone who has never
// touched the toggle — a feature that looks unbuilt rather than switched off.

import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingVideoCollapsed,
  resetRecordingVideoCollapsedCacheForTests,
  setRecordingVideoCollapsed,
} from "./recording-video-collapsed-pref"

const KEY = "aq.recording-video-collapsed.v1"

describe("recording-video-collapsed-pref", () => {
  beforeEach(() => {
    localStorage.clear()
    resetRecordingVideoCollapsedCacheForTests()
  })

  it("shows the film when nothing is stored", () => {
    expect(getRecordingVideoCollapsed()).toBe(false)
  })

  it("stores only the opt-in, so clearing storage restores the film", () => {
    setRecordingVideoCollapsed(true)
    expect(localStorage.getItem(KEY)).toBe("on")
    expect(getRecordingVideoCollapsed()).toBe(true)

    setRecordingVideoCollapsed(false)
    // Removed, not written as "off": a half-cleared or corrupt store must fall
    // back to the film being visible.
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getRecordingVideoCollapsed()).toBe(false)
  })

  it("reads a value written by a previous session", () => {
    localStorage.setItem(KEY, "on")
    resetRecordingVideoCollapsedCacheForTests()
    expect(getRecordingVideoCollapsed()).toBe(true)
  })
})
