import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
let consent: typeof import("./analytics-consent")
let isAnalyticsEnabled: typeof consent.isAnalyticsEnabled
let hasAnalyticsConsentBeenSet: typeof consent.hasAnalyticsConsentBeenSet
let setAnalyticsEnabled: typeof consent.setAnalyticsEnabled
beforeEach(async () => {
  vi.resetModules()
  consent = await import("./analytics-consent")
  ;({ isAnalyticsEnabled, hasAnalyticsConsentBeenSet, setAnalyticsEnabled } = consent)
})

const STORAGE_KEY = "aquilla:analyticsEnabled"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("isAnalyticsEnabled", () => {
  it("returns true when no choice is recorded (production default)", () => {
    // Match production: users can switch sharing off.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(isAnalyticsEnabled()).toBe(true)
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

it.each(["read", "write", "both"])("retains explicit choices and notifications when storage %s is denied", (denied) => {
  const notify = vi.fn()
  const off = consent.onAnalyticsConsentChange(notify)
  try {
    expect(isAnalyticsEnabled()).toBe(true)
    expect(hasAnalyticsConsentBeenSet()).toBe(false)
    // A stale persisted ON must not override a failed opt-out write.
    if (denied === "write") localStorage.setItem(STORAGE_KEY, "true")
    if (denied !== "write") vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError") })
    if (denied !== "read") vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError") })
    setAnalyticsEnabled(false)
    expect(isAnalyticsEnabled()).toBe(false)
    expect(hasAnalyticsConsentBeenSet()).toBe(true)
    expect(notify).toHaveBeenLastCalledWith(false)
    setAnalyticsEnabled(true)
    expect(isAnalyticsEnabled()).toBe(true)
    expect(notify).toHaveBeenLastCalledWith(true)
  } finally { off() }
})
