import { afterEach, describe, expect, it } from "vitest"
import {
  isAnalyticsEnabled,
  hasAnalyticsConsentBeenSet,
  setAnalyticsEnabled,
} from "./analytics-consent"

const STORAGE_KEY = "codex:analyticsEnabled"

afterEach(() => {
  localStorage.clear()
})

describe("isAnalyticsEnabled", () => {
  it("returns false when no choice has been recorded (default-off)", () => {
    // No key in storage — must be OFF until explicit opt-in
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(isAnalyticsEnabled()).toBe(false)
  })

  it("returns true when a stored 'yes' is present", () => {
    localStorage.setItem(STORAGE_KEY, "true")
    expect(isAnalyticsEnabled()).toBe(true)
  })

  it("returns false when a stored 'no' is present", () => {
    localStorage.setItem(STORAGE_KEY, "false")
    expect(isAnalyticsEnabled()).toBe(false)
  })
})

describe("hasAnalyticsConsentBeenSet", () => {
  it("returns false when nothing is stored", () => {
    expect(hasAnalyticsConsentBeenSet()).toBe(false)
  })

  it("returns true after setAnalyticsEnabled(true)", () => {
    setAnalyticsEnabled(true)
    expect(hasAnalyticsConsentBeenSet()).toBe(true)
  })

  it("returns true after setAnalyticsEnabled(false)", () => {
    setAnalyticsEnabled(false)
    expect(hasAnalyticsConsentBeenSet()).toBe(true)
  })
})

describe("setAnalyticsEnabled", () => {
  it("persists and retrieves true correctly", () => {
    setAnalyticsEnabled(true)
    expect(isAnalyticsEnabled()).toBe(true)
  })

  it("persists and retrieves false correctly", () => {
    setAnalyticsEnabled(false)
    expect(isAnalyticsEnabled()).toBe(false)
  })
})
