import { beforeEach, describe, expect, it } from "vitest"

import {
  getRecordingTakesDrawerOpen,
  resetRecordingTakesDrawerCacheForTests,
  setRecordingTakesDrawerOpen,
} from "./recording-takes-drawer-pref"

const KEY = "aq.recording-takes-drawer.v1"

describe("recording-takes-drawer-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetRecordingTakesDrawerCacheForTests()
  })

  it("rests open when nothing is stored", () => {
    expect(getRecordingTakesDrawerOpen()).toBe(true)
  })

  it("persists only the choice to rest closed", () => {
    setRecordingTakesDrawerOpen(false)
    expect(getRecordingTakesDrawerOpen()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe("closed")

    setRecordingTakesDrawerOpen(true)
    expect(getRecordingTakesDrawerOpen()).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("reads a stored choice after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, "closed")
    resetRecordingTakesDrawerCacheForTests()
    expect(getRecordingTakesDrawerOpen()).toBe(false)
  })
})
