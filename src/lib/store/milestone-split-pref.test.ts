import { beforeEach, describe, expect, it } from "vitest"

import {
  getMilestoneSplit,
  resetMilestoneSplitCacheForTests,
  setMilestoneSplit,
} from "./milestone-split-pref"

const KEY = "aq.milestone-split.v1"

describe("milestone-split-pref", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMilestoneSplitCacheForTests()
  })

  it("shows the whole file when nothing is stored", () => {
    expect(getMilestoneSplit()).toBe(false)
  })

  it("stores only the opt-in, so clearing storage restores the continuous list", () => {
    setMilestoneSplit(true)
    expect(localStorage.getItem(KEY)).toBe("on")
    expect(getMilestoneSplit()).toBe(true)

    setMilestoneSplit(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getMilestoneSplit()).toBe(false)
  })

  it("reads a value written by a previous session", () => {
    localStorage.setItem(KEY, "on")
    resetMilestoneSplitCacheForTests()
    expect(getMilestoneSplit()).toBe(true)
  })
})
