/**
 * AQU-817 — a collaborator's comment must not be lost to a socket gap.
 *
 * The comments list used to have exactly ONE live path: an `event.applied`
 * comment frame arriving over the project WebSocket. Per AD-1 the ProjectSync
 * DO holds no durable state and never replays, so a frame that landed while a
 * client's socket was down was lost to that client permanently — and, unlike
 * cells (AQU-845), nothing ever re-armed the comments read. A contributor's
 * thread therefore stayed invisible to another member sitting in the same cell
 * until a full page reload.
 *
 * These tests pin the re-arm: useComments joins the same window-regained-focus
 * wave every other read hook already subscribes to.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useComments } from "./useComments"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

const mockFetchComments = vi.fn<() => Promise<CommentRecord[]>>()
const mockFetchCounts = vi.fn(async () => ({ unresolved: 0, byFile: {} }))
vi.mock("@/lib/sync/comments-read", () => ({
  fetchCommentsForProject: (..._args: unknown[]) => mockFetchComments(),
  fetchCommentCounts: (..._args: unknown[]) => mockFetchCounts(),
}))
vi.mock("@/lib/sync/events-emit", () => ({ enqueueEvent: vi.fn() }))

/** A thread opened by another member while this client wasn't listening. */
function peerThread(): CommentRecord {
  return {
    commentId: "cmt-from-contributor",
    projectId: "proj-1",
    scopeKind: "cell",
    fileId: "file-1",
    cellId: "cell-2",
    parentCommentId: null,
    body: "Is this rendering right?",
    resolved: false,
    authorId: "tetiana",
    authorLabel: "tetiana",
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    createdForTranslated: null,
  }
}

const GET_TOKEN = async (_fileId: string) => "test-token"

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchComments.mockResolvedValue([])
  resetWindowFocusRevalidateForTests()
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
})

afterEach(() => {
  resetWindowFocusRevalidateForTests()
})

describe("useComments — window-regained-focus re-arm (AQU-817)", () => {
  it("surfaces a peer's thread that landed while the socket was down, on the next focus", async () => {
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "joel" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.comments).toHaveLength(0)

    // The contributor's comment is committed server-side, but this client
    // never received the broadcast — the DO never replays it.
    mockFetchComments.mockResolvedValue([peerThread()])

    window.dispatchEvent(new Event("focus"))

    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.comments[0]?.commentId).toBe("cmt-from-contributor")
  })

  it("unsubscribes on unmount so a focus after teardown fires no fetch", async () => {
    const { result, unmount } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "joel" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const callsAfterLoad = mockFetchComments.mock.calls.length

    unmount()
    window.dispatchEvent(new Event("focus"))

    expect(mockFetchComments.mock.calls.length).toBe(callsAfterLoad)
  })

  it("does not fire while the auth token is explicitly not ready", async () => {
    renderHook(() =>
      useComments({
        projectId: "proj-1",
        getToken: GET_TOKEN,
        author: "joel",
        tokenReady: false,
      }),
    )
    // The initial auto-load is held too (AQU-640), so nothing has fetched yet.
    expect(mockFetchComments).not.toHaveBeenCalled()

    window.dispatchEvent(new Event("focus"))

    expect(mockFetchComments).not.toHaveBeenCalled()
  })

  it("does nothing without a project", async () => {
    renderHook(() => useComments({ projectId: null, getToken: GET_TOKEN, author: "joel" }))

    window.dispatchEvent(new Event("focus"))

    expect(mockFetchComments).not.toHaveBeenCalled()
  })
})

// AQU-2654 — the focus read is a revalidation: it must not flip the list's
// loading flags, replace the list with an equal one, or ask twice.
describe("useComments — a focus revalidation is quiet (AQU-2654)", () => {
  function mountWithPriorityFile() {
    const seen: Array<{ isLoading: boolean; isLoadingRest: boolean }> = []
    let renders = 0
    const hook = renderHook(() => {
      const api = useComments({
        projectId: "proj-1",
        getToken: GET_TOKEN,
        author: "joel",
        priorityFileId: "file-1",
      })
      renders += 1
      seen.push({ isLoading: api.isLoading, isLoadingRest: api.isLoadingRest })
      return api
    })
    return { ...hook, seen, renders: () => renders }
  }

  it("sends one list read, shows no loading state and keeps the list's identity when nothing changed", async () => {
    // A new, equal array of new, equal rows per read, as the network gives.
    mockFetchComments.mockImplementation(async () => [peerThread()])
    const { result, seen, renders } = mountWithPriorityFile()
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    await waitFor(() => expect(result.current.isLoadingRest).toBe(false))
    // Open: the open file's threads first, then the project (two reads).
    expect(mockFetchComments).toHaveBeenCalledTimes(2)
    const listBefore = result.current.comments
    const countsBefore = result.current.counts
    const rendersBefore = renders()
    seen.length = 0

    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(mockFetchComments).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockFetchComments).toHaveBeenCalledTimes(3)
    expect(result.current.comments).toBe(listBefore)
    expect(result.current.counts).toBe(countsBefore)
    expect(seen.some((flags) => flags.isLoading || flags.isLoadingRest)).toBe(false)
    // At most ONE render, and none that changed anything (asserted above). The
    // first state update that changes nothing after a real render still makes
    // React run the hook once before it bails out. Which no-change update pays
    // for that — the mount-time outbox read's, or this revalidation's —
    // depends on when the outbox read settles, so an exact count is a race.
    // A revalidation that flipped a flag or replaced the list renders twice.
    expect(renders()).toBeLessThanOrEqual(rendersBefore + 1)
  })

  it("keeps every thread on screen until the whole new answer is in", async () => {
    const second = { ...peerThread(), commentId: "cmt-2", createdAt: 2000, updatedAt: 2000 }
    mockFetchComments.mockResolvedValue([peerThread(), second])
    const { result, seen } = mountWithPriorityFile()
    await waitFor(() => expect(result.current.comments).toHaveLength(2))
    await waitFor(() => expect(result.current.isLoadingRest).toBe(false))
    seen.length = 0

    let release!: (rows: CommentRecord[]) => void
    mockFetchComments.mockImplementationOnce(() => new Promise<CommentRecord[]>((resolve) => { release = resolve }))
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(mockFetchComments).toHaveBeenCalledTimes(3))
    expect(result.current.comments).toHaveLength(2)

    const third = { ...peerThread(), commentId: "cmt-3", createdAt: 3000, updatedAt: 3000 }
    release([peerThread(), second, third])
    await waitFor(() => expect(result.current.comments).toHaveLength(3))
    expect(seen.some((flags) => flags.isLoading || flags.isLoadingRest)).toBe(false)
  })
})
