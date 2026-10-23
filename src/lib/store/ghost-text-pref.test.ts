/**
 * AQU-2117 — the "Suggest next words" (BIA ghost text) preference.
 *
 * The claims worth pinning are the default and the durability: a browser
 * nobody has touched must show no ghost text (so "absent key" has to read as
 * off), a translator's opt-in has to survive a reload, and a browser that
 * opted out under the old on-by-default scheme must not be read as on.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  getGhostTextEnabled,
  resetGhostTextPrefCacheForTests,
  setGhostTextEnabled,
} from "./ghost-text-pref"

const STORAGE_KEY = "aq.ghost-text.v2"
const LEGACY_STORAGE_KEY = "aq.ghost-text.v1"

beforeEach(() => {
  localStorage.clear()
  resetGhostTextPrefCacheForTests()
})

describe("ghost-text preference", () => {
  it("is off when nothing is stored", () => {
    expect(getGhostTextEnabled()).toBe(false)
  })

  it("persists only the opt-in, so clearing storage returns to off", () => {
    setGhostTextEnabled(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe("on")
    expect(getGhostTextEnabled()).toBe(true)

    setGhostTextEnabled(false)
    // Removed rather than written as "off": a cleared key and an explicit
    // opt-out must be indistinguishable, or a future default flip would treat
    // the two differently.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(getGhostTextEnabled()).toBe(false)
  })

  it("reads a stored opt-in back after a reload", () => {
    localStorage.setItem(STORAGE_KEY, "on")
    resetGhostTextPrefCacheForTests()

    expect(getGhostTextEnabled()).toBe(true)
  })

  it("treats any other stored value as off", () => {
    localStorage.setItem(STORAGE_KEY, "true")
    resetGhostTextPrefCacheForTests()

    expect(getGhostTextEnabled()).toBe(false)
  })

  it("ignores the v1 key from the on-by-default era and drops it on the next write", () => {
    // Under v1 only an opt-out was ever stored; its absence meant on. Neither
    // state may read as on now.
    localStorage.setItem(LEGACY_STORAGE_KEY, "off")
    resetGhostTextPrefCacheForTests()
    expect(getGhostTextEnabled()).toBe(false)

    setGhostTextEnabled(true)
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
    expect(getGhostTextEnabled()).toBe(true)
  })
})
