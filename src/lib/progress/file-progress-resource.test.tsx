import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  invalidateFileProgress,
  claimLegacyFileProgressCache,
  resetFileProgressResourceForTests,
  setFileProgressCacheOwner,
  setLocalFileProgress,
  useFileProgressResource,
  type FileProgressResponse,
} from "./file-progress-resource"

function progress(fileId: string, filledCount: number, revision = 1): FileProgressResponse {
  return {
    fileId,
    revision,
    validationCount: 1,
    file: { totalCount: 2, filledCount, validatedCount: 0, validationLevels: [0] },
    sections: [{
      key: "GEN 1",
      totalCount: 2,
      filledCount,
      validatedCount: 0,
      validationLevels: [0],
    }],
    source: "projection",
  }
}

function jsonResponse(body: FileProgressResponse, etag: string): Response {
  return Response.json(body, { headers: { ETag: etag } })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await resetFileProgressResourceForTests()
})

describe("file progress resource", () => {
  it("moves a pre-account snapshot into the first resolved owner scope", async () => {
    const server = progress("legacy-progress-file", 1)
    const getToken = async () => "token"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(server, '"legacy"')))
    const legacy = renderHook(() => useFileProgressResource("legacy-progress-project", "legacy-progress-file", getToken))
    await waitFor(() => expect(legacy.result.current.progress?.file.filledCount).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    legacy.unmount()

    await resetFileProgressResourceForTests()
    setFileProgressCacheOwner("alice")
    await claimLegacyFileProgressCache("alice")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")))
    const claimed = renderHook(() => useFileProgressResource("legacy-progress-project", "legacy-progress-file", getToken))
    await waitFor(() => expect(claimed.result.current.progress?.file.filledCount).toBe(1))
    expect(claimed.result.current.fromCache).toBe(true)
    claimed.unmount()
  })

  it("preserves a newer scoped snapshot while deleting its legacy copy", async () => {
    const getToken = async () => "token"
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(progress("upgrade-progress-file", 1, 1), '"legacy"'))
      .mockResolvedValueOnce(jsonResponse(progress("upgrade-progress-file", 2, 2), '"scoped"'))
    vi.stubGlobal("fetch", fetchMock)

    const legacy = renderHook(() => useFileProgressResource("upgrade-progress-project", "upgrade-progress-file", getToken))
    await waitFor(() => expect(legacy.result.current.progress?.revision).toBe(1))
    legacy.unmount()
    await resetFileProgressResourceForTests()

    setFileProgressCacheOwner("alice")
    const scoped = renderHook(() => useFileProgressResource("upgrade-progress-project", "upgrade-progress-file", getToken))
    await waitFor(() => expect(scoped.result.current.progress?.revision).toBe(2))
    scoped.unmount()
    await resetFileProgressResourceForTests()

    setFileProgressCacheOwner("alice")
    await claimLegacyFileProgressCache("alice")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")))
    const claimed = renderHook(() => useFileProgressResource("upgrade-progress-project", "upgrade-progress-file", getToken))
    await waitFor(() => expect(claimed.result.current.progress?.revision).toBe(2))
    expect(claimed.result.current.fromCache).toBe(true)
    claimed.unmount()
  })

  it("paints a persisted snapshot and revalidates it with If-None-Match", async () => {
    const server = progress("cache-file", 1)
    const getToken = async () => "token"
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(server, '"progress:cache-file:1:v1"'))
    vi.stubGlobal("fetch", fetchMock)

    const first = renderHook(() => useFileProgressResource("project", "cache-file", getToken))
    await waitFor(() => expect(first.result.current.progress?.file.filledCount).toBe(1))
    first.unmount()
    await resetFileProgressResourceForTests()

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const warm = renderHook(() => useFileProgressResource("project", "cache-file", getToken))
    await waitFor(() => expect(warm.result.current.progress?.file.filledCount).toBe(1))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>
    expect(headers["If-None-Match"]).toBe('"progress:cache-file:1:v1"')
    warm.unmount()
  })

  it("keeps optimistic progress until the post-outbox server read confirms it", async () => {
    const initial = progress("optimistic-file", 0, 1)
    const confirmed = progress("optimistic-file", 1, 2)
    const getToken = async () => "token"
    let resolveConfirmation!: (response: Response) => void
    const confirmation = new Promise<Response>((resolve) => { resolveConfirmation = resolve })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(initial, '"progress:optimistic-file:1:v1"'))
      .mockReturnValueOnce(confirmation)
    vi.stubGlobal("fetch", fetchMock)

    const hook = renderHook(() => useFileProgressResource("project", "optimistic-file", getToken))
    await waitFor(() => expect(hook.result.current.progress?.file.filledCount).toBe(0))

    const local = progress("optimistic-file", 1, 1)
    act(() => setLocalFileProgress("project", "optimistic-file", local, ["event-1"]))
    expect(hook.result.current.progress?.file.filledCount).toBe(1)

    act(() => setLocalFileProgress("project", "optimistic-file", local, []))
    expect(hook.result.current.progress?.file.filledCount).toBe(1)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(hook.result.current.progress?.file.filledCount).toBe(1)

    resolveConfirmation(jsonResponse(confirmed, '"progress:optimistic-file:2:v1"'))
    await waitFor(() => expect(hook.result.current.progress?.revision).toBe(2))
    hook.unmount()
  })

  it("does not restore an optimistic cache overlay after its outbox event is gone", async () => {
    const initial = progress("restart-file", 0, 1)
    const staleOverlay = progress("restart-file", 1, 1)
    const confirmed = progress("restart-file", 2, 2)
    const getToken = async () => "token"
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(initial, '"progress:restart-file:1:v1:p"'))
      .mockResolvedValueOnce(jsonResponse(confirmed, '"progress:restart-file:2:v1:p"'))
    vi.stubGlobal("fetch", fetchMock)

    const first = renderHook(() => useFileProgressResource("project", "restart-file", getToken))
    await waitFor(() => expect(first.result.current.progress?.file.filledCount).toBe(0))
    act(() => setLocalFileProgress("project", "restart-file", staleOverlay, ["accepted-event"]))
    await waitFor(() => expect(first.result.current.progress?.file.filledCount).toBe(1))
    // Let the IndexedDB put complete before simulating a new tab/session.
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.unmount()
    await resetFileProgressResourceForTests()

    const restarted = renderHook(() => useFileProgressResource("project", "restart-file", getToken))
    await waitFor(() => expect(restarted.result.current.progress?.file.filledCount).toBe(2))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    restarted.unmount()
  })

  it("reports progress unavailable when offline with no cached snapshot", async () => {
    const getToken = async () => "token"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")))
    const hook = renderHook(() => useFileProgressResource("project", "offline-file", getToken))
    await waitFor(() => expect(hook.result.current.error).toBe(true))
    expect(hook.result.current.progress).toBeNull()
    hook.unmount()
  })

  it("keeps an in-flight response in the account namespace that started it", async () => {
    setFileProgressCacheOwner("alice")
    let resolveAlice!: (response: Response) => void
    const aliceResponse = new Promise<Response>((resolve) => { resolveAlice = resolve })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(aliceResponse)
      .mockRejectedValueOnce(new TypeError("offline"))
    vi.stubGlobal("fetch", fetchMock)
    const getAliceToken = async () => "alice-token"
    const getBobToken = async () => "bob-token"

    const alice = renderHook(() => useFileProgressResource(
      "shared-project", "shared-file", getAliceToken,
    ))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    setFileProgressCacheOwner("bob")
    // Account transitions unmount account-scoped routes behind the global
    // loading boundary before publishing the new owner.
    alice.unmount()
    resolveAlice(jsonResponse(progress("shared-file", 1), '"alice-progress"'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const bob = renderHook(() => useFileProgressResource(
      "shared-project", "shared-file", getBobToken,
    ))
    await waitFor(() => expect(bob.result.current.error).toBe(true))
    expect(bob.result.current.progress).toBeNull()
    bob.unmount()
  })

  it("prefers the active store over an incomplete server rollout fallback", async () => {
    const fallback = {
      ...progress("fallback-file", 0, 1),
      sections: [],
      source: "file-counter-fallback" as const,
    }
    const local = progress("fallback-file", 1, 1)
    const getToken = async () => "token"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(fallback, '"progress:fallback-file:1:v1"'),
    ))

    const hook = renderHook(() => useFileProgressResource("project", "fallback-file", getToken))
    await waitFor(() => expect(hook.result.current.progress?.source).toBe("file-counter-fallback"))
    act(() => setLocalFileProgress("project", "fallback-file", local, []))

    expect(hook.result.current.progress?.sections).toHaveLength(1)
    expect(hook.result.current.progress?.file.filledCount).toBe(1)
    hook.unmount()
  })

  it("queues one authoritative refresh when an event lands during an in-flight read", async () => {
    const stale = progress("live-file", 0, 1)
    const fresh = progress("live-file", 1, 2)
    const getToken = async () => "token"
    let resolveInitial!: (response: Response) => void
    const initial = new Promise<Response>((resolve) => { resolveInitial = resolve })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValueOnce(jsonResponse(fresh, '"progress:live-file:2:v1"'))
    vi.stubGlobal("fetch", fetchMock)

    const hook = renderHook(() => useFileProgressResource("project", "live-file", getToken))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    act(() => invalidateFileProgress("project", "live-file"))
    resolveInitial(jsonResponse(stale, '"progress:live-file:1:v1"'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.progress?.revision).toBe(2))
    hook.unmount()
  })
})
