/**
 * Model A/B outcome reporting — the session-scoped assignment map and the
 * fire-and-forget feedback POST. First gesture wins; cells with no pending
 * assignment never produce network traffic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { noteAbAssignment, reportAbOutcome, hasPendingAb, clearPendingAb } from "./feedback"

vi.mock("@/lib/frontier/session-store", () => ({
  loadSession: vi.fn(async () => ({ jwt: "test-jwt", username: "wendi" })),
}))
import { loadSession } from "@/lib/frontier/session-store"

const AB = { requestId: "11111111-1111-7111-8111-111111111111", arm: "challenger" as const, model: "m" }

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  clearPendingAb()
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The POST is fire-and-forget; yield to the microtask queue to observe it. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("reportAbOutcome", () => {
  it("POSTs the outcome for a noted cell, then clears the entry", async () => {
    noteAbAssignment("f1", "c1", AB)
    expect(hasPendingAb("f1", "c1")).toBe(true)

    reportAbOutcome("f1", "c1", "accepted")
    await flush()

    expect(hasPendingAb("f1", "c1")).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/chat\/ab-feedback$/)
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-jwt" })
    expect(JSON.parse(String(init.body))).toEqual({ requestId: AB.requestId, outcome: "accepted" })
  })

  it("does nothing for a cell without a pending assignment", async () => {
    reportAbOutcome("f1", "unknown", "edited")
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("first gesture wins — the second report is a no-op", async () => {
    noteAbAssignment("f1", "c1", AB)
    reportAbOutcome("f1", "c1", "edited")
    reportAbOutcome("f1", "c1", "accepted")
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
      outcome: "edited",
    })
  })

  it("stays silent when there is no session", async () => {
    vi.mocked(loadSession).mockResolvedValueOnce(null)
    noteAbAssignment("f1", "c1", AB)
    reportAbOutcome("f1", "c1", "accepted")
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
