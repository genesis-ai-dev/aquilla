/**
 * Tests for useComments — focusing on the two correctness fixes in AQU-228:
 *
 * 1. Optimistic comments survive a WS-triggered refresh (stale-refetch-wipes-
 *    optimistic regression — same class as commit b813940 fixed for cells).
 *
 * 2. Project-scoped comment.* mutations stamp the '__project__' sentinel
 *    fileId so the outbox-flush can mint a token (verified via enqueueEvent
 *    call shape rather than actual IDB in unit tests — the IDB flush path is
 *    tested in outbox-flush.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useComments } from "./useComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock fetchCommentsForProject so tests control what the server "returns".
const mockFetchComments = vi.fn<() => Promise<CommentRecord[]>>()
vi.mock("@/lib/sync/comments-read", () => ({
  fetchCommentsForProject: (..._args: unknown[]) => mockFetchComments(),
}))

// Mock enqueueEvent to capture what the hook enqueues without touching IDB.
const mockEnqueueEvent = vi.fn()
vi.mock("@/lib/sync/events-emit", () => ({
  enqueueEvent: (ev: unknown) => mockEnqueueEvent(ev),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeServerComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "cmt-server-1",
    projectId: "proj-1",
    scopeKind: "project",
    fileId: null,
    cellId: null,
    parentCommentId: null,
    body: "Server comment",
    resolved: false,
    authorId: "alice",
    authorLabel: "alice",
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  }
}

const GET_TOKEN = async (_fileId: string) => "test-token"

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchComments.mockResolvedValue([])
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useComments — optimistic comment survives refresh (AQU-228 WARN)", () => {
  it("an optimistic comment added before a refresh is still visible after the refresh completes", async () => {
    // Initial load: server returns one comment.
    mockFetchComments.mockResolvedValue([makeServerComment()])

    const { result } = renderHook(() =>
      useComments({
        projectId: "proj-1",
        getToken: GET_TOKEN,
        author: "alice",
      }),
    )

    // Wait for initial load.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.comments).toHaveLength(1)

    // Add an optimistic comment locally (simulate offline or pre-flush).
    // The server still returns only the original comment on the NEXT refresh.
    mockFetchComments.mockResolvedValue([makeServerComment()])

    await act(async () => {
      await result.current.addComment({
        scope: { kind: "project" },
        body: "Optimistic comment — not yet on server",
      })
    })

    // After addComment, we should see 2 comments (server + optimistic).
    expect(result.current.comments).toHaveLength(2)
    expect(result.current.comments.some((c) => c.body === "Optimistic comment — not yet on server")).toBe(true)

    // Now trigger a WS-driven refresh while the optimistic comment is NOT YET
    // in the server response. This simulates the bug: refresh() doing a full
    // setComments(serverRows) would wipe the optimistic comment.
    await act(async () => {
      await result.current.refresh()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // The optimistic comment must still be visible (merged back in).
    expect(result.current.comments.some((c) => c.body === "Optimistic comment — not yet on server")).toBe(true)
  })

  it("optimistic comment is dropped once the server confirms it", async () => {
    mockFetchComments.mockResolvedValue([])

    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let capturedCommentId = ""
    await act(async () => {
      capturedCommentId = await result.current.addComment({
        scope: { kind: "project" },
        body: "Soon confirmed",
      })
    })

    expect(result.current.comments).toHaveLength(1)

    // Server now returns the confirmed comment in the next refresh.
    mockFetchComments.mockResolvedValue([
      makeServerComment({ commentId: capturedCommentId, body: "Soon confirmed" }),
    ])

    await act(async () => {
      await result.current.refresh()
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Confirmed comment is in the list once (not duplicated).
    const confirmedComments = result.current.comments.filter((c) => c.commentId === capturedCommentId)
    expect(confirmedComments).toHaveLength(1)
  })
})

describe("useComments — auto-load re-arms once the auth token is ready (AQU-640)", () => {
  it("does not clobber the loading state or fetch while tokenReady is false, then loads when it flips true", async () => {
    // Server has a comment, but getToken only yields a real token once the
    // session has 'loaded' — mirroring CommentsPage's null-token-until-JWT race.
    mockFetchComments.mockResolvedValue([makeServerComment()])
    let jwtReady = false
    const getTokenGatedOnJwt = async (_fileId: string) =>
      jwtReady ? "test-token" : null

    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useComments({
          projectId: "proj-1",
          getToken: getTokenGatedOnJwt,
          author: "alice",
          tokenReady: ready,
        }),
      { initialProps: { ready: false } },
    )

    // Cold-load window: session not ready. The hook must show the loading state
    // and must NOT have fetched (a fetch now would bail on the null token and
    // never retry — the original bug).
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(mockFetchComments).not.toHaveBeenCalled()
    expect(result.current.comments).toHaveLength(0)

    // Session/JWT finishes loading → token becomes available.
    jwtReady = true
    rerender({ ready: true })

    // The auto-load now fires on its own (no manual refresh) and populates.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockFetchComments).toHaveBeenCalled()
    expect(result.current.comments).toHaveLength(1)
  })

  it("negative case: a genuinely comment-free project resolves to the empty state once ready (no infinite spinner)", async () => {
    mockFetchComments.mockResolvedValue([])
    let jwtReady = false
    const getTokenGatedOnJwt = async (_fileId: string) =>
      jwtReady ? "test-token" : null

    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useComments({
          projectId: "proj-1",
          getToken: getTokenGatedOnJwt,
          author: "alice",
          tokenReady: ready,
        }),
      { initialProps: { ready: false } },
    )

    await waitFor(() => expect(result.current.isLoading).toBe(true))

    jwtReady = true
    rerender({ ready: true })

    // Resolves to a clean empty state — no false error, no stuck spinner.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.comments).toHaveLength(0)
  })

  it("omitting tokenReady preserves the legacy auto-load-on-mount behavior", async () => {
    mockFetchComments.mockResolvedValue([makeServerComment()])
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    // No readiness signal → loads immediately on mount, as before.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockFetchComments).toHaveBeenCalled()
    expect(result.current.comments).toHaveLength(1)
  })
})

describe("useComments — sentinel fileId for project-scoped mutations (AQU-228 BLOCKER 1 client side)", () => {
  it("addComment with project scope enqueues event with __project__ fileId sentinel", async () => {
    mockFetchComments.mockResolvedValue([])
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.addComment({
        scope: { kind: "project" },
        body: "A project comment",
      })
    })

    expect(mockEnqueueEvent).toHaveBeenCalledOnce()
    const enqueuedEvent = mockEnqueueEvent.mock.calls[0][0] as { kind: string; fileId?: string }
    expect(enqueuedEvent.kind).toBe("comment.create")
    expect(enqueuedEvent.fileId).toBe("__project__")
  })

  it("addComment with cell scope enqueues event with the cell's real fileId (not sentinel)", async () => {
    mockFetchComments.mockResolvedValue([])
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.addComment({
        scope: { kind: "cell", fileId: "file-abc", cellId: "cell-123" },
        body: "Cell comment",
      })
    })

    expect(mockEnqueueEvent).toHaveBeenCalledOnce()
    const enqueuedEvent = mockEnqueueEvent.mock.calls[0][0] as { kind: string; fileId?: string }
    expect(enqueuedEvent.kind).toBe("comment.create")
    expect(enqueuedEvent.fileId).toBe("file-abc")
  })

  it("resolveThread on a project-scoped comment enqueues event with __project__ sentinel", async () => {
    // Simulate a loaded project-scoped comment in state.
    mockFetchComments.mockResolvedValue([makeServerComment({ commentId: "cmt-proj", fileId: null })])
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.comments).toHaveLength(1)

    await act(async () => {
      await result.current.resolveThread("cmt-proj", true)
    })

    const enqueuedEvent = mockEnqueueEvent.mock.calls[0][0] as { kind: string; fileId?: string }
    expect(enqueuedEvent.kind).toBe("comment.resolve")
    // Project-scoped comment has no fileId in the record → sentinel must be used.
    expect(enqueuedEvent.fileId).toBe("__project__")
  })

  it("resolveThread on a cell comment uses the comment's real fileId (not sentinel)", async () => {
    mockFetchComments.mockResolvedValue([
      makeServerComment({ commentId: "cmt-cell", scopeKind: "cell", fileId: "file-xyz", cellId: "cell-1" }),
    ])
    const { result } = renderHook(() =>
      useComments({ projectId: "proj-1", getToken: GET_TOKEN, author: "alice" }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.resolveThread("cmt-cell", true)
    })

    const enqueuedEvent = mockEnqueueEvent.mock.calls[0][0] as { kind: string; fileId?: string }
    expect(enqueuedEvent.kind).toBe("comment.resolve")
    expect(enqueuedEvent.fileId).toBe("file-xyz")
  })
})
