import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingCountdown,
  resetRecordingCountdownCacheForTests,
  setRecordingCountdown,
} from "./recording-countdown-pref"

const KEY = "aq.recording-countdown.v1"

describe("recording-countdown-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingCountdownCacheForTests()
  })

  // ON is the behaviour that existed before the toggle — an operator who never
  // opens the popover must keep their 3-2-1.
  it("defaults to on when nothing is stored", () => {
    expect(getRecordingCountdown()).toBe(true)
  })

  it("persists only the opt-out", () => {
    setRecordingCountdown(false)
    expect(getRecordingCountdown()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe("off")

    setRecordingCountdown(true)
    expect(getRecordingCountdown()).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("reads a stored opt-out after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "off")
    resetRecordingCountdownCacheForTests()
    expect(getRecordingCountdown()).toBe(false)
  })
})
