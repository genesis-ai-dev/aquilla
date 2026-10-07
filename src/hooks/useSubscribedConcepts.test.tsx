/**
 * AQU-1721 — useSubscribedConcepts is the editor's read of the org termbases a
 * project subscribes to. It must apply exactly the termbases that route #8's
 * gate (canReadTermbase) lets through, in subscription-priority order, mark
 * them as another project's, and never let a failed or stale read pass for a
 * termbase with no terms.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Concept } from "@/lib/terminology/types"
import type { TermbaseSubscription } from "@/lib/terminology/subscriptions-api"

let jwt: string | null = "jwt-1"
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: jwt ? { username: "tester", jwt } : null }),
}))

const listSubscriptions = vi.fn<(jwt: string, projectId: string) => Promise<TermbaseSubscription[]>>()
vi.mock("@/lib/terminology/subscriptions-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/terminology/subscriptions-api")>()),
  listSubscriptions: (j: string, p: string) => listSubscriptions(j, p),
}))

import { useSubscribedConcepts } from "./useSubscribedConcepts"

function sub(termbaseProjectId: string, priority: number, published = true): TermbaseSubscription {
  return { termbaseProjectId, termbaseName: termbaseProjectId, priority, createdAt: "2026-10-01T00:00:00Z", published }
}

function concept(id: string, status: Concept["status"] = "active"): Concept {
  return {
    id,
    sourceTerm: id,
    renderings: [{ rendering: `r-${id}`, status: "preferred" }],
    status,
    createdAt: "2026-10-01T00:00:00Z",
  }
}

/** Route #8 by termbase id: its concepts (200) or a bare status. Any other
 *  request fails the test, so a termbase the hook should skip cannot be read. */
function stubRouteEight(byTermbase: Record<string, Concept[] | number>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const match = /\/projects\/([^/]+)\/termbase\/concepts\?/.exec(url)
    const answer = match ? byTermbase[decodeURIComponent(match[1]!)] : undefined
    if (answer === undefined) throw new Error(`unexpected request: ${url}`)
    if (typeof answer === "number") return new Response("{}", { status: answer })
    return new Response(JSON.stringify({ concepts: answer }), { status: 200 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const ids = (concepts: Concept[]) => concepts.map((c) => c.id)

afterEach(() => {
  vi.unstubAllGlobals()
  listSubscriptions.mockReset()
  jwt = "jwt-1"
})

describe("useSubscribedConcepts (AQU-1721)", () => {
  it("returns each termbase's active concepts in subscription order, marked with their termbase", async () => {
    listSubscriptions.mockResolvedValue([sub("tb-first", 0), sub("tb-second", 1)])
    stubRouteEight({
      "tb-first": [concept("first-a"), concept("first-draft", "draft")],
      "tb-second": [concept("second-a")],
    })

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    await waitFor(() => expect(ids(result.current.concepts)).toEqual(["first-a", "second-a"]))
    expect(result.current.concepts.map((c) => c.termbaseProjectId)).toEqual(["tb-first", "tb-second"])
    expect(result.current.error).toBeNull()
    expect(listSubscriptions).toHaveBeenCalledWith("jwt-1", "p1")
  })

  it("does not read a termbase that has been unpublished", async () => {
    listSubscriptions.mockResolvedValue([sub("tb-live", 0), sub("tb-unpublished", 1, false)])
    const fetchMock = stubRouteEight({ "tb-live": [concept("live")] })

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    await waitFor(() => expect(ids(result.current.concepts)).toEqual(["live"]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it("treats a 403 as a gated-off termbase: no concepts and no error", async () => {
    // Route #8 refuses an archived, deleted or other-org termbase with a 403.
    listSubscriptions.mockResolvedValue([sub("tb-trashed", 0), sub("tb-live", 1)])
    stubRouteEight({ "tb-trashed": 403, "tb-live": [concept("live")] })

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    await waitFor(() => expect(ids(result.current.concepts)).toEqual(["live"]))
    expect(result.current.error).toBeNull()
  })

  it("reports any other failure as an error, not as a termbase with no terms", async () => {
    listSubscriptions.mockResolvedValue([sub("tb-down", 0)])
    stubRouteEight({ "tb-down": 500 })

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    await waitFor(() => expect(result.current.error).toMatch(/tb-down/))
    expect(result.current.concepts).toEqual([])
  })

  it("reports a failed subscriptions list as an error", async () => {
    listSubscriptions.mockRejectedValue(new Error("subscriptions list failed"))
    stubRouteEight({})

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    await waitFor(() => expect(result.current.error).toBe("subscriptions list failed"))
  })

  it("never lets a slower read for the previous project replace the current one", async () => {
    let releaseFirst: (subs: TermbaseSubscription[]) => void = () => {}
    listSubscriptions.mockImplementation((_jwt, projectId) =>
      projectId === "p1"
        ? new Promise<TermbaseSubscription[]>((resolve) => {
            releaseFirst = resolve
          })
        : Promise.resolve([sub("tb-p2", 0)]),
    )
    const fetchMock = stubRouteEight({ "tb-p1": [concept("from-p1")], "tb-p2": [concept("from-p2")] })

    const { result, rerender } = renderHook(({ projectId }) => useSubscribedConcepts(projectId), {
      initialProps: { projectId: "p1" },
    })
    rerender({ projectId: "p2" })
    await waitFor(() => expect(ids(result.current.concepts)).toEqual(["from-p2"]))

    // p1's read finishes last. Its concepts belong to a project no longer open.
    act(() => releaseFirst([sub("tb-p1", 0)]))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/tb-p1/"))).toBe(true),
    )
    // Let that response settle before checking it was ignored.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(ids(result.current.concepts)).toEqual(["from-p2"])
    expect(result.current.isLoading).toBe(false)
  })

  it("reads nothing until there is a session", () => {
    jwt = null
    stubRouteEight({})

    const { result } = renderHook(() => useSubscribedConcepts("p1"))

    expect(listSubscriptions).not.toHaveBeenCalled()
    expect(result.current.concepts).toEqual([])
    expect(result.current.error).toBeNull()
  })
})
