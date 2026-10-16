/**
 * #946 — the health-score colour-coding preference.
 *
 * The behaviour worth pinning is the default and the durability: a file nobody
 * has touched must look exactly as it did before this preference existed (so
 * "absent key" has to read as off), and the consultant's choice has to survive
 * a reload.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  getHealthScoreColorCoding,
  resetHealthScoreColorCodingCacheForTests,
  setHealthScoreColorCoding,
} from "./health-score-color-coding-pref"

const STORAGE_KEY = "aq.health-score-color-coding.v1"

beforeEach(() => {
  localStorage.clear()
  resetHealthScoreColorCodingCacheForTests()
})

describe("health-score colour-coding preference", () => {
  it("is off when nothing is stored", () => {
    expect(getHealthScoreColorCoding()).toBe(false)
  })

  it("persists only the opt-in, so clearing storage returns to off", () => {
    setHealthScoreColorCoding(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("on")

    setHealthScoreColorCoding(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getHealthScoreColorCoding()).toBe(false)
  })

  it("reads a stored opt-in back after a reload", () => {
    localStorage.setItem(STORAGE_KEY, "on")
    resetHealthScoreColorCodingCacheForTests()

    expect(getHealthScoreColorCoding()).toBe(true)
  })

  it("treats any other stored value as off", () => {
    localStorage.setItem(STORAGE_KEY, "true")
    resetHealthScoreColorCodingCacheForTests()

    expect(getHealthScoreColorCoding()).toBe(false)
  })
})
