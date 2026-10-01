import { beforeEach, describe, expect, it } from "vitest"

import {
  countdownStepMs,
  getRecordingCountdownSpeed,
  resetRecordingCountdownCacheForTests,
  setRecordingCountdownSpeed,
} from "./recording-countdown-pref"

const KEY = "aq.recording-countdown.v1"

describe("recording-countdown-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingCountdownCacheForTests()
  })

  // NORMAL is the behaviour that existed before the setting — an operator who
  // never opens the popover must keep their one-second 3-2-1.
  it("defaults to Normal when nothing is stored", () => {
    expect(getRecordingCountdownSpeed()).toBe("normal")
    expect(countdownStepMs("normal")).toBe(1000)
  })

  it("persists only a departure from Normal", () => {
    setRecordingCountdownSpeed("fast")
    expect(getRecordingCountdownSpeed()).toBe("fast")
    expect(localStorage.getItem(KEY)).toBe("fast")

    setRecordingCountdownSpeed("off")
    expect(localStorage.getItem(KEY)).toBe("off")

    setRecordingCountdownSpeed("normal")
    expect(getRecordingCountdownSpeed()).toBe("normal")
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  // The on/off switch this replaced stored "off" under this same key. Nobody
  // who turned the count off gets it back on by upgrading.
  it("reads the old switch's stored opt-out as Off", () => {
    localStorage.setItem(KEY, "off")
    resetRecordingCountdownCacheForTests()
    expect(getRecordingCountdownSpeed()).toBe("off")
    expect(countdownStepMs("off")).toBeNull()
  })

  it("reads a stored speed after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "slow")
    resetRecordingCountdownCacheForTests()
    expect(getRecordingCountdownSpeed()).toBe("slow")
    expect(countdownStepMs("slow")).toBe(1500)
  })

  it("treats an unknown stored value as Normal", () => {
    localStorage.setItem(KEY, "warp")
    resetRecordingCountdownCacheForTests()
    expect(getRecordingCountdownSpeed()).toBe("normal")
  })
})
