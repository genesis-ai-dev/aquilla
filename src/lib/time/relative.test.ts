import { describe, it, expect } from "vitest"
import { formatRelativeTime, isStale, STALE_THRESHOLD_MS } from "./relative"

const NOW = Date.parse("2026-04-29T12:00:00Z")

describe("formatRelativeTime", () => {
  it("returns null for null/undefined input", () => {
    expect(formatRelativeTime(null, NOW)).toBeNull()
    expect(formatRelativeTime(undefined, NOW)).toBeNull()
  })

  it("returns null for unparseable input", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBeNull()
  })

  it("formats sub-minute as 'just now'", () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now")
  })

  it("formats minutes / hours / days / months / years", () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 minutes ago")
    expect(formatRelativeTime(new Date(NOW - 60_000).toISOString(), NOW)).toBe("1 minute ago")
    expect(formatRelativeTime(new Date(NOW - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3 hours ago")
    expect(formatRelativeTime(new Date(NOW - 1 * 60 * 60_000).toISOString(), NOW)).toBe("1 hour ago")
    expect(formatRelativeTime(new Date(NOW - 7 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("7 days ago")
    expect(formatRelativeTime(new Date(NOW - 60 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2 months ago")
    expect(formatRelativeTime(new Date(NOW - 400 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("1 year ago")
  })

  it("clamps future timestamps to 'just now' rather than negative offset", () => {
    expect(formatRelativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now")
  })
})

describe("isStale", () => {
  it("is false for null/undefined (no signal yet ≠ stale)", () => {
    expect(isStale(null, NOW)).toBe(false)
    expect(isStale(undefined, NOW)).toBe(false)
  })

  it("is false within the threshold", () => {
    expect(isStale(new Date(NOW - STALE_THRESHOLD_MS / 2).toISOString(), NOW)).toBe(false)
  })

  it("is true past the threshold", () => {
    expect(isStale(new Date(NOW - STALE_THRESHOLD_MS - 60_000).toISOString(), NOW)).toBe(true)
  })

  it("is false for unparseable input", () => {
    expect(isStale("garbage", NOW)).toBe(false)
  })
})
