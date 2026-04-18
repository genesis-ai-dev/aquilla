import { describe, it, expect } from "vitest"
import { deriveLivenessState, formatSyncedAgo } from "./useLiveness"

describe("deriveLivenessState", () => {
  it("returns 'offline' when online=false regardless of recency", () => {
    expect(deriveLivenessState({ online: false, lastUpdate: 1000, now: 1500 })).toBe("offline")
  })

  it("returns 'updating' when a recent update is within the flash window", () => {
    // Flash window is 800ms; 500ms ago is within it.
    expect(deriveLivenessState({ online: true, lastUpdate: 1000, now: 1500 })).toBe("updating")
  })

  it("returns 'live' when last update is outside the flash window", () => {
    expect(deriveLivenessState({ online: true, lastUpdate: 1000, now: 2000 })).toBe("live")
  })

  it("returns 'live' when lastUpdate is null", () => {
    expect(deriveLivenessState({ online: true, lastUpdate: null, now: 1000 })).toBe("live")
  })
})

describe("formatSyncedAgo", () => {
  it("says 'just now' when within 5 seconds", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 3000 })).toBe("just now")
  })

  it("formats seconds when under a minute", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 31000 })).toBe("30s ago")
  })

  it("formats minutes when under an hour", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 1000 + 120_000 })).toBe("2m ago")
  })

  it("formats hours beyond that", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 1000 + 3 * 3600_000 })).toBe("3h ago")
  })

  it("returns empty string when lastUpdate is null", () => {
    expect(formatSyncedAgo({ lastUpdate: null, now: 1000 })).toBe("")
  })
})
