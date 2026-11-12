import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  PROJECT_OPEN_LEAVE_GRACE_MS,
  claimHydrationReport,
  retainProjectOpen,
} from "./project-settings-open"

// Module state is shared across tests, so each test uses its own project id.
describe("project-settings-open (AQU-1470)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("lets one claim through per open, however many consumers retain it", () => {
    const releaseA = retainProjectOpen("open-1")
    const releaseB = retainProjectOpen("open-1")
    expect(claimHydrationReport("open-1")).not.toBeNull()
    expect(claimHydrationReport("open-1")).toBeNull()
    releaseA()
    releaseB()
  })

  it("returns null when no open is live", () => {
    expect(claimHydrationReport("open-never")).toBeNull()
  })

  it("measures within_ms from the start of the open", () => {
    const release = retainProjectOpen("open-2")
    vi.advanceTimersByTime(1500)
    expect(claimHydrationReport("open-2")).toBe(1500)
    release()
  })

  it("keeps the open across a page change inside the grace period", () => {
    const releaseEditor = retainProjectOpen("open-3")
    expect(claimHydrationReport("open-3")).not.toBeNull()
    releaseEditor()
    vi.advanceTimersByTime(PROJECT_OPEN_LEAVE_GRACE_MS - 1)
    const releaseOverview = retainProjectOpen("open-3")
    expect(claimHydrationReport("open-3")).toBeNull()
    releaseOverview()
  })

  it("starts a new open after the project is left for the grace period", () => {
    const first = retainProjectOpen("open-4")
    expect(claimHydrationReport("open-4")).not.toBeNull()
    first()
    vi.advanceTimersByTime(PROJECT_OPEN_LEAVE_GRACE_MS)
    const second = retainProjectOpen("open-4")
    expect(claimHydrationReport("open-4")).toBe(0)
    second()
  })

  it("does not end the open while any consumer is still mounted", () => {
    const releaseA = retainProjectOpen("open-5")
    const releaseB = retainProjectOpen("open-5")
    expect(claimHydrationReport("open-5")).not.toBeNull()
    releaseA()
    vi.advanceTimersByTime(PROJECT_OPEN_LEAVE_GRACE_MS * 2)
    expect(claimHydrationReport("open-5")).toBeNull()
    releaseB()
  })

  it("tracks each project separately", () => {
    const releaseA = retainProjectOpen("open-6a")
    const releaseB = retainProjectOpen("open-6b")
    expect(claimHydrationReport("open-6a")).not.toBeNull()
    expect(claimHydrationReport("open-6b")).not.toBeNull()
    releaseA()
    releaseB()
  })
})
