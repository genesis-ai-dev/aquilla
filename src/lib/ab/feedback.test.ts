/**
 * Model A/B outcome reporting — the session-scoped assignment map, the edit
 * -distance computation against the captured draft text, and the
 * fire-and-forget feedback POST. Outcome story: edits refine the distance and
 * keep the entry; validation closes it (distance 0 when never touched).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  noteAbAssignment,
  noteAbDraftText,
  reportAbOutcome,
  hasPendingAb,
  clearPendingAb,
} from "./feedback"

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

/** The POST is fire-and-forget; yield to the macrotask queue to observe it. */
const flush = () => new Promise((r) => setTimeout(r, 0))

const sentBodies = () =>
  fetchSpy.mock.calls.map((c: unknown[]) => JSON.parse(String((c as [string, RequestInit])[1].body)))

describe("reportAbOutcome", () => {
  it("validate-first reports accepted with distance 0 and consumes the entry", async () => {
    noteAbAssignment("f1", "c1", AB)
    noteAbDraftText("f1", "c1", "the draft")

    reportAbOutcome("f1", "c1", "accepted")
    await flush()

    expect(hasPendingAb("f1", "c1")).toBe(false)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/chat\/ab-feedback$/)
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-jwt" })
    expect(JSON.parse(String(init.body))).toEqual({
      requestId: AB.requestId,
      outcome: "accepted",
      editDistance: 0,
    })
  })

  it("edits compute the draft distance, keep the entry, and refine on later commits", async () => {
    noteAbAssignment("f1", "c1", AB)
    noteAbDraftText("f1", "c1", "abcd")

    reportAbOutcome("f1", "c1", "edited", "abXd") // 1 of 4 chars changed
    expect(hasPendingAb("f1", "c1")).toBe(true)
    reportAbOutcome("f1", "c1", "edited", "WXYZ") // fully rewritten
    reportAbOutcome("f1", "c1", "accepted") // validate closes with the last distance
    await flush()

    expect(hasPendingAb("f1", "c1")).toBe(false)
    const bodies = sentBodies()
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toMatchObject({ outcome: "edited", editDistance: 0.25 })
    expect(bodies[1]).toMatchObject({ outcome: "edited", editDistance: 1 })
    expect(bodies[2]).toMatchObject({ outcome: "accepted", editDistance: 1 })
  })

  it("an edit without a captured draft text reports no distance", async () => {
    noteAbAssignment("f1", "c1", AB)
    reportAbOutcome("f1", "c1", "edited", "whatever")
    await flush()
    expect(sentBodies()[0]).toEqual({ requestId: AB.requestId, outcome: "edited" })
  })

  it("does nothing for a cell without a pending assignment", async () => {
    reportAbOutcome("f1", "unknown", "edited", "x")
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("stays silent when there is no session", async () => {
    vi.mocked(loadSession).mockResolvedValueOnce(null)
    noteAbAssignment("f1", "c1", AB)
    reportAbOutcome("f1", "c1", "accepted")
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
