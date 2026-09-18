// AQU-1326: file-open paint order for the store the workspace actually reads.
//
// This is the regression's escape level. The same target-first-then-source
// ordering existed in BOTH `useCells` and `useActiveCellStore`; a fix and unit
// test on `useCells` alone left the workspace path untouched, because
// `ProjectWorkspace` mounts `useActiveCellStore`. These tests pin the ordering
// on the hook the editor really uses.
//
// The rule: the SOURCE side streams first and paints on its first page, so the
// first row appears after one cells page whatever fraction of the file is
// translated. The TARGET side follows and merges into the already-painted rows
// — a translation may land a page late, but it is never dropped.

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
    // No warm cache: every test here exercises the cold full-stream path.
    readCellsCache: vi.fn(async () => null),
    scheduleCellsCacheWrite: vi.fn(),
    flushCellsCacheWrites: vi.fn(async () => undefined),
  }
})

import { streamFileCells } from "@/lib/sync/cells-read"
import { useActiveCellStore } from "./useActiveCellStore"

const streamMock = vi.mocked(streamFileCells)

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

const SOURCE_ROWS = [row("c1", "source", "Source 1"), row("c2", "source", "Source 2")]
const TARGET_ROWS = [row("c1", "target", "Translated 1"), row("c2", "target", "Translated 2")]

function renderStore() {
  return renderHook(() =>
    useActiveCellStore({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      getToken: async () => "jwt",
      enabled: true,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useActiveCellStore — file-open paint order (AQU-1326)", () => {
  it("requests the SOURCE side before the TARGET side", async () => {
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
      await onPage(side === "source" ? SOURCE_ROWS : TARGET_ROWS, true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const sides = streamMock.mock.calls.map((call) => call[4])
    expect(sides).toEqual(["source", "target"])
  })

  it("paints the first source page without waiting for the target stream", async () => {
    // The target stream is parked, modelling a mostly-translated file whose
    // target side is as large as its source side. The view must paint from the
    // source stream alone rather than waiting behind it.
    let releaseTarget!: () => void
    const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve })
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
      if (side === "target") {
        await targetGate
        await onPage(TARGET_ROWS, true)
        return
      }
      await onPage(SOURCE_ROWS, true)
    })

    const { result } = renderStore()

    // Painted from the source side while the target side is still in flight.
    await waitFor(() => expect(result.current.store.getAllSummaries()).toHaveLength(2))
    expect(result.current.isLoading).toBe(true)
    const painted = result.current.store.getAllSummaries()
    expect(painted.map((cell) => cell.id)).toEqual(["c1", "c2"])

    // Translations land behind the first paint and are merged in, not lost.
    await act(async () => {
      releaseTarget()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.store.getCellView("c1")?.translated).toBe("Translated 1")
    expect(result.current.store.getCellView("c2")?.translated).toBe("Translated 2")
  })

  it("still paints a file whose source side is empty (target-only rows survive)", async () => {
    // The source pass yields nothing, so nothing paints until the target pass
    // — the final replace must still swap those rows in rather than leaving
    // the file blank.
    streamMock.mockImplementation(async (_p, _f, _jwt, onPage, side) => {
      await onPage(side === "source" ? [] : TARGET_ROWS, true)
    })
    const { result } = renderStore()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.store.getAllSummaries()).toHaveLength(2)
  })
})
