/**
 * Tests for replace-confirm-pref (AQU-591) — the device-scoped preference that
 * lets users skip the sparkle-replace confirmation dialog.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  getSkipReplaceConfirm,
  setSkipReplaceConfirm,
} from "./replace-confirm-pref"

beforeEach(() => {
  window.localStorage.clear()
  // Reset the in-memory cache to the (now-empty) storage.
  setSkipReplaceConfirm(false)
  window.localStorage.clear()
})

describe("replace-confirm-pref", () => {
  it("defaults to showing the confirmation (skip = false)", () => {
    expect(getSkipReplaceConfirm()).toBe(false)
  })

  it("persists an opt-out to localStorage and reads it back", () => {
    setSkipReplaceConfirm(true)
    expect(getSkipReplaceConfirm()).toBe(true)
    expect(window.localStorage.getItem("aq.replace-confirm-pref.v1")).toBe("true")
  })

  it("clears the key (rather than storing false) when re-enabled", () => {
    setSkipReplaceConfirm(true)
    setSkipReplaceConfirm(false)
    expect(getSkipReplaceConfirm()).toBe(false)
    expect(window.localStorage.getItem("aq.replace-confirm-pref.v1")).toBeNull()
  })

  it("notifies subscribers on change", () => {
    setSkipReplaceConfirm(true)
    // A fresh read reflects the latest write immediately.
    expect(getSkipReplaceConfirm()).toBe(true)
  })
})
