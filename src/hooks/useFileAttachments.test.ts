/**
 * AQU-777: useFileAttachments.
 *
 * The cases worth pinning are the ones a hand-rolled optimistic list gets
 * wrong:
 *   - an optimistic add survives a refresh that hasn't caught up yet (the
 *     stale-refetch-wipes-optimistic class of bug, same as AQU-228 on
 *     comments), and stops being tracked once the server echoes it;
 *   - an optimistic removal hides the row until the server agrees;
 *   - switching files clears local intent, so one file's attachments can never
 *     surface in another's list — the "drawer doesn't leak attachments across
 *     files" line in the issue's own test checklist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useFileAttachments } from "./useFileAttachments"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"

const mockFetch = vi.fn<
  () => Promise<{ attachments: CellAttachmentRecord[]; truncated: boolean }>
>()
vi.mock("@/lib/sync/cell-attachments-read", () => ({
  fetchAttachmentsForFile: (..._args: unknown[]) => mockFetch(),
}))

function makeRecord(overrides: Partial<CellAttachmentRecord> = {}): CellAttachmentRecord {
  return {
    attachmentId: "att-1",
    projectId: "proj-1",
    fileId: "file-1",
    cellId: "GEN 1:1",
    objectName: "att-1.png",
    name: "layout.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    authorId: "ana",
    authorLabel: "ana",
    createdAt: 1000,
    cellRef: "GEN 1:1",
    ...overrides
  }
}

const getToken = async () => "test-jwt"

function renderForFile(fileId: string | null) {
  return renderHook(
    (props: { fileId: string | null }) =>
      useFileAttachments({ projectId: "proj-1", fileId: props.fileId, getToken }),
    { initialProps: { fileId } },
  )
}

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ attachments: [], truncated: false })
})

describe("useFileAttachments", () => {
  it("loads the file's attachments and indexes them by cell", async () => {
    mockFetch.mockResolvedValue({
      attachments: [
        makeRecord({ attachmentId: "a1", cellId: "GEN 1:1" }),
        makeRecord({ attachmentId: "a2", cellId: "GEN 1:1", createdAt: 1001 }),
        makeRecord({ attachmentId: "a3", cellId: "GEN 1:2" }),
      ],
      truncated: false,
    })

    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.attachments).toHaveLength(3))

    expect(result.current.byCell.get("GEN 1:1")).toHaveLength(2)
    expect(result.current.byCell.get("GEN 1:2")).toHaveLength(1)
    // A cell with none is ABSENT from the map, not an empty array — which is
    // what keeps the drawer from rendering an empty group for it.
    expect(result.current.byCell.has("GEN 1:3")).toBe(false)
  })

  it("keeps an optimistic add through a refresh that has not caught up", async () => {
    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => result.current.addOptimistic(makeRecord({ attachmentId: "pending" })))
    expect(result.current.attachments.map((a) => a.attachmentId)).toEqual(["pending"])

    // The server still doesn't know about it (the outbox hasn't flushed).
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.attachments.map((a) => a.attachmentId)).toEqual(["pending"])
  })

  it("stops tracking an optimistic add once the server echoes it", async () => {
    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => result.current.addOptimistic(makeRecord({ attachmentId: "a1" })))
    mockFetch.mockResolvedValue({
      attachments: [makeRecord({ attachmentId: "a1" })],
      truncated: false,
    })
    await act(async () => {
      await result.current.refresh()
    })

    // Exactly one row — not the server's plus the pending duplicate.
    expect(result.current.attachments).toHaveLength(1)
  })

  it("hides an optimistically removed row until the server agrees", async () => {
    mockFetch.mockResolvedValue({
      attachments: [makeRecord({ attachmentId: "a1" })],
      truncated: false,
    })
    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.attachments).toHaveLength(1))

    act(() => result.current.removeOptimistic("a1"))
    expect(result.current.attachments).toHaveLength(0)

    // Server still returns it — the removal hasn't flushed. Stay hidden.
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.attachments).toHaveLength(0)

    // Now the server agrees; the pending removal is settled and dropped.
    mockFetch.mockResolvedValue({ attachments: [], truncated: false })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.attachments).toHaveLength(0)
  })

  it("does not leak one file's attachments into another", async () => {
    mockFetch.mockResolvedValue({
      attachments: [makeRecord({ attachmentId: "a1", fileId: "file-1" })],
      truncated: false,
    })
    const { result, rerender } = renderForFile("file-1")
    await waitFor(() => expect(result.current.attachments).toHaveLength(1))

    // A pending add on file-1 must not survive the switch either — it is keyed
    // to a row of the file being left.
    act(() => result.current.addOptimistic(makeRecord({ attachmentId: "pending" })))
    expect(result.current.attachments).toHaveLength(2)

    mockFetch.mockResolvedValue({ attachments: [], truncated: false })
    rerender({ fileId: "file-2" })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.attachments).toEqual([])
    expect(result.current.byCell.size).toBe(0)
  })

  it("clears the list when no file is open", async () => {
    mockFetch.mockResolvedValue({
      attachments: [makeRecord()],
      truncated: false,
    })
    const { result, rerender } = renderForFile("file-1")
    await waitFor(() => expect(result.current.attachments).toHaveLength(1))

    rerender({ fileId: null })
    await waitFor(() => expect(result.current.attachments).toEqual([]))
  })

  it("waits for the token-ready signal before its first load", async () => {
    const { rerender } = renderHook(
      (props: { ready: boolean }) =>
        useFileAttachments({
          projectId: "proj-1",
          fileId: "file-1",
          getToken,
          tokenReady: props.ready,
        }),
      { initialProps: { ready: false } },
    )
    expect(mockFetch).not.toHaveBeenCalled()

    rerender({ ready: true })
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
  })

  it("surfaces a read failure rather than showing an empty file", async () => {
    // An error rendered as "no attachments" is the comments-drawer bug from
    // AQU-1275 — a fetch failure must not read as an empty state.
    mockFetch.mockRejectedValue(new Error("network"))
    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.attachments).toEqual([])
  })

  it("reports truncation so a partial list can say so", async () => {
    mockFetch.mockResolvedValue({ attachments: [makeRecord()], truncated: true })
    const { result } = renderForFile("file-1")
    await waitFor(() => expect(result.current.truncated).toBe(true))
  })
})
