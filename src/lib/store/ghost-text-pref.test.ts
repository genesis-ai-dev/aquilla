/**
 * "Suggest next words" (BIA ghost text) preference — on by default again
 * after the next-word fix (AQU-2117 turned it off). A browser nobody has
 * touched shows ghost text; an opt-out survives a reload; neither older key
 * (v2 held only an opt-in, v1 only an opt-out of a different feature) is read.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  getGhostTextEnabled,
  resetGhostTextPrefCacheForTests,
  setGhostTextEnabled,
} from "./ghost-text-pref"

const STORAGE_KEY = "aq.ghost-text.v3"

beforeEach(() => {
  localStorage.clear()
  resetGhostTextPrefCacheForTests()
})

describe("ghost-text preference", () => {
  it("is on when nothing is stored", () => {
    expect(getGhostTextEnabled()).toBe(true)
  })

  it("persists only the opt-out, so clearing storage returns to on", () => {
    setGhostTextEnabled(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("off")
    expect(getGhostTextEnabled()).toBe(false)

    setGhostTextEnabled(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getGhostTextEnabled()).toBe(true)
  })

  it("reads a stored opt-out back after a reload", () => {
    localStorage.setItem(STORAGE_KEY, "off")
    resetGhostTextPrefCacheForTests()
    expect(getGhostTextEnabled()).toBe(false)
  })

  it("ignores the v1 and v2 keys and drops them on the next write", () => {
    localStorage.setItem("aq.ghost-text.v1", "off")
    localStorage.setItem("aq.ghost-text.v2", "on")
    resetGhostTextPrefCacheForTests()
    expect(getGhostTextEnabled()).toBe(true)

    setGhostTextEnabled(false)
    expect(localStorage.getItem("aq.ghost-text.v1")).toBeNull()
    expect(localStorage.getItem("aq.ghost-text.v2")).toBeNull()
  })
})
