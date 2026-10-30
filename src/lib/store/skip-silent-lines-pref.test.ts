// AQU-2251 (Sam, Oct 28): "Skip lines with nothing to play" — on unless the
// person turned it off, remembered on this device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  getSkipSilentLinesPref,
  resetSkipSilentLinesPrefCacheForTests,
  setSkipSilentLinesPref,
} from "./skip-silent-lines-pref"

const KEY = "aq.skip-silent-lines.v1"

describe("skip-silent-lines-pref", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetSkipSilentLinesPrefCacheForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(KEY)
    resetSkipSilentLinesPrefCacheForTests()
  })

  it("is on when nothing is stored", () => {
    expect(getSkipSilentLinesPref()).toBe(true)
  })

  it("stores only the turn-off, and forgets it when turned back on", () => {
    setSkipSilentLinesPref(false)
    expect(getSkipSilentLinesPref()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe("off")

    setSkipSilentLinesPref(true)
    expect(getSkipSilentLinesPref()).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("is still off after a reload", () => {
    localStorage.setItem(KEY, "off")
    resetSkipSilentLinesPrefCacheForTests()
    expect(getSkipSilentLinesPref()).toBe(false)
  })

  it("reads anything else stored as on", () => {
    localStorage.setItem(KEY, "sometimes")
    resetSkipSilentLinesPrefCacheForTests()
    expect(getSkipSilentLinesPref()).toBe(true)
  })

  it("keeps working when storage refuses to be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(getSkipSilentLinesPref()).toBe(true)
    setSkipSilentLinesPref(false)
    expect(getSkipSilentLinesPref()).toBe(false)
  })
})
