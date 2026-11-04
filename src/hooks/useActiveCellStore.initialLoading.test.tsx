// A full fetch must report `isLoading` from the moment it is asked for. The
// sync token and the cache read are two async hops, and the project socket
// can open inside them. With zero rows, no loading flag and an open socket,
// `deriveCellAreaState` returned "ready-empty": the editor read "<file> is
// empty" for a frame (a flash for people) and, since that placeholder has no
// aria-busy region, the Jev smart-test readiness gate passed through the gap
// onto a file that was still loading (Hetzner QA job 1853).

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/sync/cells-read", () => ({
  streamFileCells: vi.fn(),
  fetchCellsByIds: vi.fn(),
  fetchCellsDelta: vi.fn(),
}))
vi.mock("@/lib/sync/cells-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cells-cache")>()
  return {
    ...actual,
    readCellsCache: vi.fn(async () => null),
    scheduleCellsCacheWrite: vi.fn(),
    flushCellsCacheWrites: vi.fn(async () => undefined),
  }
})

import { streamFileCells } from "@/lib/sync/cells-read"
import { useActiveCellStore } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useActiveCellStore — isLoading on a cold open", () => {
  it("is true before the sync token resolves, so an open socket cannot read the file as empty", async () => {
    let releaseToken!: (jwt: string) => void
    const getToken = vi.fn(() => new Promise<string>((resolve) => { releaseToken = resolve }))
    vi.mocked(streamFileCells).mockImplementation(async (_p, _f, _jwt, onPage) => {
      await onPage([row("c1", "source", "Source 1")], true)
    })

    const { result } = renderHook(() =>
      useActiveCellStore({ projectId: "p1", fileId: "f1", username: "alice", getToken, enabled: true }),
    )

    // The token is still pending: nothing has been read, yet the hook must
    // already say it is loading.
    await waitFor(() => expect(getToken).toHaveBeenCalled())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.store.getCellView("c1")).toBeNull()

    await act(async () => { releaseToken("jwt") })
    await waitFor(() => expect(result.current.store.getCellView("c1")).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })
})
