// AQU-1849 — the Monday API client is deadline-bounded.
//
// The gap this closes: `mondayGraphQL` had no timeout, so a Monday endpoint
// that accepted the connection and then went quiet held the push engine — and
// the cron flush behind it — open until the platform killed the invocation,
// with nothing in the logs naming Monday as the cause.
//
// Two properties matter, and the second is the subtle one: a blown deadline
// must be classified TRANSIENT, so the link stays dirty and the flush tries
// again. A timeout mapped to a permanent failure would silently drop the
// project off the board — the exact AQU-1828 regression, reintroduced.

import { describe, it, expect, afterEach, vi } from "vitest"
import { mondayGraphQL, MondayApiError } from "../lib/monday/client"
import { isTransientPushError } from "../lib/monday/push"
import { VENDOR_TIMEOUT_MS } from "../../../shared/vendor-timeouts"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** What a blown `AbortSignal.timeout` rejects a fetch with. */
function stubHangingMonday(): () => RequestInit | undefined {
  let seen: RequestInit | undefined
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seen = init
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
  }) as unknown as typeof fetch
  return () => seen
}

describe("mondayGraphQL deadline", () => {
  it("attaches a bounded abort signal to the GraphQL subrequest", async () => {
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init
      return new Response(JSON.stringify({ data: { me: { id: 7 } } }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(mondayGraphQL("tok", "{ me { id } }")).resolves.toEqual({ me: { id: 7 } })
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    expect(seen?.signal?.aborted).toBe(false)
  })

  it("raises a 504 MondayApiError naming the vendor when Monday never responds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    stubHangingMonday()

    const err = await mondayGraphQL("tok", "{ me { id } }").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MondayApiError)
    expect((err as MondayApiError).status).toBe(504)
    expect((err as MondayApiError).message).toContain("mondayGraphQL")
    expect((err as MondayApiError).message).toContain(
      `${VENDOR_TIMEOUT_MS.mondayGraphQL / 1000}s`,
    )
  })

  it("logs the blown deadline with the vendor name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    stubHangingMonday()

    await mondayGraphQL("tok", "{ me { id } }").catch(() => undefined)

    expect(spy).toHaveBeenCalled()
    expect(String(spy.mock.calls[0]?.[0])).toContain("[vendor-timeout] mondayGraphQL")
  })

  it("classifies the timeout as transient, so the link stays dirty and the flush retries it", () => {
    // AQU-1828's guarantee must survive the new error: a slow Monday is not a
    // reason to stop tracking a project.
    expect(isTransientPushError(new MondayApiError("monday timed out", 504))).toBe(true)
  })

  it("does not retry inside one call — the deadline applies per attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }) as unknown as typeof fetch

    await mondayGraphQL("tok", "{ me { id } }").catch(() => undefined)

    // The 429 retry path sleeps and calls again; a timeout must NOT, or one
    // hung endpoint costs two full deadlines per push.
    expect(calls).toBe(1)
  })
})
