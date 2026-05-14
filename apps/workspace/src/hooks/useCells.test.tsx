// Phase 2a tests for useCells.
//
// The hook reads cells from the sync-worker via `fetchAllFileCells`. We mock
// that module with vi.mock so each test can stage its own response without
// hitting the network. The tests verify:
//   - happy-path mapping of CellRow -> CellData (source/target join,
//     translated text, status derivation)
//   - revalidate() triggers a refetch and updates state
//   - stats overlay overrides validator-derived fields
//   - disabled / missing-token path returns empty cells

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

const fetchAllMock = vi.fn<(projectId: string, fileId: string, jwt: string, side?: "source" | "target") => Promise<CellRow[]>>()

vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: (...args: unknown[]) =>
    fetchAllMock(...(args as Parameters<typeof fetchAllMock>)),
}))

import { useCells } from "./useCells"
import type { CellAuditStats } from "./useCellsAuditStats"

function makeRow(over: Partial<CellRow> & Pick<CellRow, "cellId" | "side">): CellRow {
  return {
    value: "",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `e-${over.cellId}-${over.side}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  }
}

const getToken = async () => "fake-jwt"

beforeEach(() => {
  fetchAllMock.mockReset()
})

describe("useCells (Phase 2a, D1-backed)", () => {
  it("returns empty cells until a fetch completes; then maps source/target rows into CellData", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "Source 1", canonicalRef: "GEN 1:1" }),
      makeRow({ cellId: "c1", side: "target", value: "Target 1", validated: true }),
      makeRow({ cellId: "c2", side: "source", value: "Source 2" }),
      makeRow({ cellId: "c2", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        getToken,
        enabled: true,
      }),
    )

    expect(result.current.cells).toEqual([])

    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    const cells = result.current.cells
    expect(cells[0].id).toBe("c1")
    expect(cells[0].original).toBe("Source 1")
    expect(cells[0].translated).toBe("Target 1")
    expect(cells[0].status).toBe("validated")
    expect(cells[0].globalReferences).toEqual(["GEN 1:1"])
    expect(cells[1].id).toBe("c2")
    expect(cells[1].original).toBe("Source 2")
    expect(cells[1].translated).toBe("")
    expect(cells[1].status).toBe("empty")
  })

  it("derives 'unvalidated' status when target text is present but validated=false", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "tgt", validated: false }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].status).toBe("unvalidated")
  })

  it("preserves source-chain order when joining source + target rows", async () => {
    // Server returns source rows first (chain order), then target rows.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "a", side: "source", value: "A" }),
      makeRow({ cellId: "b", side: "source", value: "B" }),
      makeRow({ cellId: "c", side: "source", value: "C" }),
      makeRow({ cellId: "c", side: "target", value: "C-t" }),
      makeRow({ cellId: "a", side: "target", value: "A-t" }),
      makeRow({ cellId: "b", side: "target", value: "B-t" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(3))
    expect(result.current.cells.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("revalidate() triggers a refetch and reflects new data", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "v1" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("v1")

    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "v2" }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.cells[0].translated).toBe("v2"))
    expect(fetchAllMock).toHaveBeenCalledTimes(2)
  })

  it("returns empty cells when disabled, without fetching", async () => {
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: false }),
    )
    // Give the effect a microtask to potentially fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.cells).toEqual([])
    expect(fetchAllMock).not.toHaveBeenCalled()
  })

  it("surfaces isError=true when getToken returns null", async () => {
    const nullToken = async () => null
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        getToken: nullToken,
        enabled: true,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.cells).toEqual([])
    expect(fetchAllMock).not.toHaveBeenCalled()
  })

  it("overlays activeValidators from auditStats over the empty default", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "hello", validated: false }),
    ])
    const stats = new Map<string, CellAuditStats>([
      ["c1", {
        cellId: "c1",
        editCount: 1,
        contentHash: "abc",
        lastEditAt: 100,
        lastEditEventId: "ev1",
        activeValidators: ["alice", "bob"],
      }],
    ])
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        username: "alice",
        requiredValidations: 2,
        auditStats: stats,
        getToken,
        enabled: true,
      }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].activeValidators).toEqual(["alice", "bob"])
    expect(result.current.cells[0].validationStatus).toBe("full")
  })

  it("re-derives validation status when stats overlay updates (no refetch)", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "hello", validated: false }),
    ])
    const stats1 = new Map<string, CellAuditStats>([
      ["c1", { cellId: "c1", editCount: 1, contentHash: "", lastEditAt: 0, lastEditEventId: "ev1", activeValidators: [] }],
    ])
    const { result, rerender } = renderHook(
      (props: { stats: ReadonlyMap<string, CellAuditStats> }) =>
        useCells({
          projectId: "proj-a",
          fileId: "file-x",
          username: "alice",
          requiredValidations: 2,
          auditStats: props.stats,
          getToken,
          enabled: true,
        }),
      { initialProps: { stats: stats1 } },
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].validationStatus).toBe("none")

    const stats2 = new Map<string, CellAuditStats>([
      ["c1", { cellId: "c1", editCount: 1, contentHash: "", lastEditAt: 0, lastEditEventId: "ev1", activeValidators: ["alice"] }],
    ])
    rerender({ stats: stats2 })
    await waitFor(() => expect(result.current.cells[0].validationStatus).toBe("self"))
    // No refetch — only the in-memory derivation refreshed.
    expect(fetchAllMock).toHaveBeenCalledTimes(1)
  })
})
