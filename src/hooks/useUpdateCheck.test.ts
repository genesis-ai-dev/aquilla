import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __startUpdatePollingForTests } from "./useUpdateCheck"

// AQU-2654: the update poll only feeds an indicator. A hidden tab skips it and
// catches up once when it is shown again.
describe("useUpdateCheck — the poll pauses in a hidden tab", () => {
  let stop: () => void
  let hidden = false
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ sha: "same" })))
  const versionChecks = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/version.json")).length

  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
    fetchMock.mockClear()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("__APP_SHA__", "same")
    stop = __startUpdatePollingForTests()
  })
  afterEach(() => {
    stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const show = (visible: boolean) => {
    hidden = !visible
    document.dispatchEvent(new Event("visibilitychange"))
  }

  it("checks every minute while the tab is visible", async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(versionChecks()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(versionChecks()).toBe(2)
  })

  it("sends nothing while hidden, then checks once on return", async () => {
    show(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(versionChecks()).toBe(0)
    show(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(versionChecks()).toBe(1)
    // The catch-up is one check, not one per skipped tick.
    show(false)
    show(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(versionChecks()).toBe(1)
  })

  it("a short absence that skipped no tick adds no request on return", async () => {
    await vi.advanceTimersByTimeAsync(10_000)
    show(false)
    await vi.advanceTimersByTimeAsync(30_000)
    show(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(versionChecks()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(versionChecks()).toBe(1)
  })
})
