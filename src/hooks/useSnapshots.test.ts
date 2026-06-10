// useSnapshots hook tests (FRO-176).
//
// Mocks the snapshots-api module and verifies the hook's fetch/create/delete/
// restore wiring without a live server.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useSnapshots } from "./useSnapshots"
import * as SnapshotsApi from "@/lib/sync/snapshots-api"
import type { Snapshot, RestoreResult } from "@/lib/sync/snapshots-api"

vi.mock("@/lib/sync/snapshots-api", () => ({
  listSnapshots: vi.fn(),
  createSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  SnapshotApiError: class SnapshotApiError extends Error {
    status: number
    body: string
    constructor(status: number, body: string) {
      super(`snapshot-api: HTTP ${status}`)
      this.status = status
      this.body = body
    }
  },
}))

const mockListSnapshots = vi.mocked(SnapshotsApi.listSnapshots)
const mockCreateSnapshot = vi.mocked(SnapshotsApi.createSnapshot)
const mockDeleteSnapshot = vi.mocked(SnapshotsApi.deleteSnapshot)
const mockRestoreSnapshot = vi.mocked(SnapshotsApi.restoreSnapshot)

const SAMPLE_SNAP: Snapshot = {
  id: "snap-1",
  projectId: "proj-1",
  name: "My snapshot",
  description: "A test snapshot",
  createdBy: "alice",
  snapshotTs: 1700000000000,
  createdAt: "2023-11-14T00:00:00Z",
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useSnapshots", () => {
  it("fetches snapshots on mount when enabled", async () => {
    mockListSnapshots.mockResolvedValue([SAMPLE_SNAP])

    const getToken = vi.fn().mockResolvedValue("test-token")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.snapshots).toEqual([SAMPLE_SNAP])
    expect(mockListSnapshots).toHaveBeenCalledWith("proj-1", "test-token")
  })

  it("sets isError when listSnapshots throws", async () => {
    mockListSnapshots.mockRejectedValue(new Error("network error"))

    const getToken = vi.fn().mockResolvedValue("test-token")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken }),
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(true)
    expect(result.current.snapshots).toEqual([])
  })

  it("does not fetch when enabled=false", async () => {
    const getToken = vi.fn().mockResolvedValue("tok")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken, enabled: false }),
    )

    // Let any pending microtasks resolve.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(mockListSnapshots).not.toHaveBeenCalled()
    expect(result.current.snapshots).toEqual([])
  })

  it("create() calls createSnapshot and revalidates", async () => {
    mockListSnapshots.mockResolvedValue([])
    const created: Snapshot = { ...SAMPLE_SNAP, name: "New snap" }
    mockCreateSnapshot.mockResolvedValue(created)
    mockListSnapshots.mockResolvedValueOnce([]).mockResolvedValueOnce([created])

    const getToken = vi.fn().mockResolvedValue("tok")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let snap!: Snapshot
    await act(async () => {
      snap = await result.current.create("New snap", "desc")
    })

    expect(mockCreateSnapshot).toHaveBeenCalledWith("proj-1", "tok", "New snap", "desc")
    expect(snap.name).toBe("New snap")
  })

  it("remove() calls deleteSnapshot and revalidates", async () => {
    mockListSnapshots.mockResolvedValue([SAMPLE_SNAP])
    mockDeleteSnapshot.mockResolvedValue(undefined)
    mockListSnapshots.mockResolvedValueOnce([SAMPLE_SNAP]).mockResolvedValueOnce([])

    const getToken = vi.fn().mockResolvedValue("tok")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.remove("snap-1")
    })

    expect(mockDeleteSnapshot).toHaveBeenCalledWith("proj-1", "snap-1", "tok")
  })

  it("restore() calls restoreSnapshot and returns the result", async () => {
    mockListSnapshots.mockResolvedValue([SAMPLE_SNAP])
    const restoreResult: RestoreResult = {
      restored: 10,
      skippedIdentical: 2,
      skippedConcurrent: 0,
      message: "Restored 10 cells.",
    }
    mockRestoreSnapshot.mockResolvedValue(restoreResult)

    const getToken = vi.fn().mockResolvedValue("tok")
    const { result } = renderHook(() =>
      useSnapshots({ projectId: "proj-1", getToken }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let res!: RestoreResult
    await act(async () => {
      res = await result.current.restore("snap-1")
    })

    expect(mockRestoreSnapshot).toHaveBeenCalledWith("proj-1", "snap-1", "tok")
    expect(res.restored).toBe(10)
  })
})
