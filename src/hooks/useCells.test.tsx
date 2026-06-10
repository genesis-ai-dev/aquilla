// Phase 2a tests for useCells.
//
// The hook reads cells from the sync-worker via `streamFileCells` (pages are
// streamed in so the first ~500 rows paint immediately on Bible-sized files).
// We mock `streamFileCells` with vi.mock so each test can stage its own
// response without hitting the network. `fetchAllMock` is preserved as the
// per-test seam — it returns the *full* row set; the mock adapter splits it
// into a single page so existing tests keep working unchanged. Tests that
// want to verify per-page rendering should use `pagesMock` directly.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

const fetchAllMock = vi.fn<(projectId: string, fileId: string, jwt: string, side?: "source" | "target") => Promise<CellRow[]>>()
// Seam for the targeted single-cell refetch (revalidateCell → fetchCellsByIds).
const fetchByIdsMock = vi.fn<(projectId: string, fileId: string, cellIds: string[], jwt: string) => Promise<CellRow[]>>()
// Optional override: a queue of pages to deliver one-at-a-time. When non-empty,
// the streamFileCells mock pulls from here instead of calling fetchAllMock.
const pagesMock: { queue: CellRow[][]; pendingResolvers: Array<() => void> } = {
  queue: [],
  pendingResolvers: [],
}

// The editor loads in two passes per fetch — target side first (tiny), then
// source — so translations aren't hidden behind the full source stream on
// large files. Tests still provide ONE combined dataset; cache it on the
// target pass and reuse on the source pass so a `mockResolvedValueOnce` is
// consumed once per load (call counts unchanged) and each pass gets its side.
let sideCache: CellRow[] | null = null

type OnPage = (rows: CellRow[], isLast: boolean) => boolean | void | Promise<boolean | void>

vi.mock("@/lib/sync/cells-read", () => ({
  streamFileCells: async (
    projectId: string,
    fileId: string,
    jwt: string,
    onPage: OnPage,
    side?: "source" | "target",
  ) => {
    if (pagesMock.queue.length > 0) {
      // Streaming/pagination fixtures are source pages; the target pass yields
      // nothing so the source pass drains the queue.
      if (side === "target") {
        await onPage([], true)
        return
      }
      const pages = pagesMock.queue.splice(0)
      for (let i = 0; i < pages.length; i++) {
        const cont = await onPage(pages[i], i === pages.length - 1)
        if (cont === false) return
      }
      return
    }
    let rows: CellRow[]
    if (side === "source" && sideCache !== null) {
      rows = sideCache
    } else {
      rows = (await fetchAllMock(projectId, fileId, jwt, side)) ?? []
      sideCache = rows
    }
    const filtered = side ? rows.filter((r) => r.side === side) : rows
    await onPage(filtered, true)
  },
  fetchAllFileCells: (...args: unknown[]) =>
    fetchAllMock(...(args as Parameters<typeof fetchAllMock>)),
  fetchCellsByIds: (...args: unknown[]) =>
    fetchByIdsMock(...(args as Parameters<typeof fetchByIdsMock>)),
}))

// Stub the IDB cells-cache. The hook reads/writes it on hard fetches; the
// real impl is keyed by `${projectId}:${fileId}` and persists across tests
// in fake-indexeddb, which bleeds rows between tests that share the same
// (projectId, fileId) fixture. Tests assert against `fetchAllMock` output,
// not cache contents, so a no-op stub is the right shape.
vi.mock("@/lib/sync/cells-cache", () => ({
  readCellsCache: async () => null,
  writeCellsCache: async () => {},
  resetCellsCacheConnectionForTests: async () => {},
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
  fetchByIdsMock.mockReset()
  fetchByIdsMock.mockResolvedValue([])
  pagesMock.queue = []
  pagesMock.pendingResolvers = []
  sideCache = null
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

  it("loads the target side first so translations aren't hidden behind the source stream", async () => {
    // Regression: on a 30k-cell file with a few translations, the combined
    // read returns all source rows before any target row, so translations
    // only appeared after the entire file streamed in — committed edits
    // looked lost on reload. The hook now fetches the target side first.
    fetchAllMock.mockResolvedValue([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "tgt" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("tgt")
    expect(result.current.cells[0].original).toBe("src")
    // The very first read pass targets the (small) target side.
    expect(fetchAllMock.mock.calls[0][3]).toBe("target")
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

  it("retries on null token (keeps skeleton up) and succeeds once it resolves", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "ok" }),
    ])
    let calls = 0
    const flakyToken = async () => {
      calls++
      return calls < 2 ? null : "jwt"
    }
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        getToken: flakyToken,
        enabled: true,
      }),
    )
    // First attempt sees null → must NOT flip to isError; the skeleton stays.
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))
    expect(result.current.isError).toBe(false)
    // After the backoff retry resolves, cells appear.
    await waitFor(() => expect(result.current.cells.length).toBe(1), { timeout: 2000 })
    expect(result.current.isError).toBe(false)
  })

  it("eventually surfaces isError=true if getToken keeps returning null", async () => {
    const nullToken = async () => null
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        getToken: nullToken,
        enabled: true,
      }),
    )
    // 6 attempts with 250→4000ms backoff exhausts in ~7.75s; allow headroom.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 10_000 })
    expect(result.current.cells).toEqual([])
    expect(fetchAllMock).not.toHaveBeenCalled()
  }, 12_000)

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
        waivers: [],
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
    // "full-self": threshold met (2/2) and current user "alice" is a validator
    expect(result.current.cells[0].validationStatus).toBe("full-self")
  })

  it("renders the first page of cells before later pages arrive (streaming)", async () => {
    // Bible-sized-file simulation: three pages of source rows. The hook
    // should expose cells from page 1 before pages 2/3 land — otherwise we
    // flash the 'Import content, or start typing in the first cell.' empty
    // state for the entire load.
    pagesMock.queue = [
      [
        makeRow({ cellId: "p1a", side: "source", value: "P1-A" }),
        makeRow({ cellId: "p1b", side: "source", value: "P1-B" }),
      ],
      [
        makeRow({ cellId: "p2a", side: "source", value: "P2-A" }),
      ],
      [
        makeRow({ cellId: "p3a", side: "source", value: "P3-A" }),
      ],
    ]
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    // First page arrives.
    await waitFor(() => expect(result.current.cells.length).toBeGreaterThanOrEqual(2))
    expect(result.current.cells.slice(0, 2).map((c) => c.id)).toEqual(["p1a", "p1b"])
    // Subsequent pages append in order, preserving the source chain.
    await waitFor(() => expect(result.current.cells).toHaveLength(4))
    expect(result.current.cells.map((c) => c.id)).toEqual(["p1a", "p1b", "p2a", "p3a"])
    expect(result.current.isLoading).toBe(false)
  })

  it("re-derives validation status when stats overlay updates (no refetch)", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "target", value: "hello", validated: false }),
    ])
    const stats1 = new Map<string, CellAuditStats>([
      ["c1", { cellId: "c1", editCount: 1, contentHash: "", lastEditAt: 0, lastEditEventId: "ev1", activeValidators: [], waivers: [] }],
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
      ["c1", { cellId: "c1", editCount: 1, contentHash: "", lastEditAt: 0, lastEditEventId: "ev1", activeValidators: ["alice"], waivers: [] }],
    ])
    rerender({ stats: stats2 })
    await waitFor(() => expect(result.current.cells[0].validationStatus).toBe("self"))
    // No refetch — only the in-memory derivation refreshed.
    expect(fetchAllMock).toHaveBeenCalledTimes(1)
  })

  it("applyOptimisticTargetEdit updates the cell's translated value without a refetch", async () => {
    // A paired source+target row for cell c1. Translated starts blank.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "Hello world" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-a",
        fileId: "file-x",
        username: "alice",
        getToken,
        enabled: true,
      }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("")
    expect(result.current.cells[0].status).toBe("empty")

    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "Hola mundo" })
    })

    // The cell is updated in-place — useHealth's signature for this cellId
    // will shift, triggering a per-cell rule re-evaluation on the next render.
    expect(result.current.cells[0].translated).toBe("Hola mundo")
    expect(result.current.cells[0].status).not.toBe("empty")
    expect(result.current.cells[0].original).toBe("Hello world") // source untouched
    // No refetch fired.
    expect(fetchAllMock).toHaveBeenCalledTimes(1)
  })

  it("keeps an optimistic edit when an in-flight refetch lands with stale (pre-commit) data", async () => {
    // The Bible-specific disappearing-prediction bug. A full refetch was
    // already in flight (it snapshotted the target side BEFORE the AI commit);
    // when it completes ~8s later it must NOT clobber the optimistic value with
    // its stale empty target. The optimistic edit survives until a refetch that
    // POSTDATES it confirms the value.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("")

    // A soft refetch is in flight, gated open — it will resolve with STALE data
    // (target still empty), modelling a fetch whose target page predates the commit.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    fetchAllMock.mockImplementationOnce(async () => {
      await gate
      return [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "" }),
      ]
    })
    act(() => { result.current.revalidate() })

    // While it's in flight, the AI prediction commits optimistically.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "predicted" }) })
    expect(result.current.cells[0].translated).toBe("predicted")

    // The stale in-flight refetch lands. It must not wipe the prediction.
    await act(async () => { release(); await gate })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells[0].translated).toBe("predicted")
  })

  it("keeps a committed value when a targeted refetch confirms it while a stale full refetch is still in flight (FRO-247)", async () => {
    // The client-demo vanish. Timeline:
    //   1. A full soft refetch is in flight — its target side snapshotted
    //      BEFORE the commit (stale-empty).
    //   2. The user commits → optimistic shadow set, value visible.
    //   3. The post-flush targeted revalidateCell returns the FRESH row →
    //      the shadow is confirmed and cleared (it did its job).
    //   4. The stale full refetch lands and swaps its buffer in. With the
    //      shadow gone and the outbox overlay flushed, nothing re-applies the
    //      value → the cell blanks until a manual page refresh.
    // The committed value must survive step 4.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    // 1. Stale full refetch in flight, gated open.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    fetchAllMock.mockImplementationOnce(async () => {
      await gate
      return [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "" }),
      ]
    })
    act(() => { result.current.revalidate() })
    // Let the fetch reach its snapshot point (token resolves) pre-commit.
    await act(async () => {})

    // 2. Commit.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "committed" }) })
    expect(result.current.cells[0].translated).toBe("committed")

    // 3. Targeted refetch (post-flush) returns the fresh, authoritative row.
    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "committed", validated: true }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))

    // 4. The stale full refetch lands. It must not clobber the committed row.
    await act(async () => { release(); await gate })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells[0].translated).toBe("committed")
    expect(result.current.cells[0].status).toBe("validated")
  })

  it("keeps a targeted write-back (validated flag) when a stale full refetch lands after it (FRO-247)", async () => {
    // Validate flow: no value change → no optimistic shadow exists at all.
    // The targeted refetch brings back validated=true; a full refetch whose
    // snapshot predates the validation must not revert it.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "v", validated: false }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].status).toBe("unvalidated")

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    fetchAllMock.mockImplementationOnce(async () => {
      await gate
      return [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "v", validated: false }),
      ]
    })
    act(() => { result.current.revalidate() })
    await act(async () => {})

    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "v", validated: true }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))

    await act(async () => { release(); await gate })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells[0].status).toBe("validated")
  })

  it("keeps a cell edited mid-flight even when the stale refetch's snapshot lacks its rows entirely (FRO-247)", async () => {
    // 'Whole row disappears': the stale snapshot predates the cell (or its
    // rows fail to come back), so the buffer swap doesn't just blank the
    // value — it removes the row, and the shadow can't resurrect a cell that
    // has no rows. Rows written after the fetch started must be retained.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "S1" }),
      makeRow({ cellId: "c2", side: "source", value: "S2" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    fetchAllMock.mockImplementationOnce(async () => {
      await gate
      // Stale snapshot is missing c2 altogether.
      return [makeRow({ cellId: "c1", side: "source", value: "S1" })]
    })
    act(() => { result.current.revalidate() })
    await act(async () => {})

    act(() => { result.current.applyOptimisticTargetEdit("c2", { value: "nuevo" }) })
    expect(result.current.cells.find((c) => c.id === "c2")?.translated).toBe("nuevo")

    await act(async () => { release(); await gate })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const c2 = result.current.cells.find((c) => c.id === "c2")
    expect(c2).toBeDefined()
    expect(c2?.translated).toBe("nuevo")
  })

  it("revalidateCell replaces the cell's rows in place — the row must not move to the bottom of the file (FRO-247)", async () => {
    // The targeted refetch used to filter-out + append the cell's rows, which
    // re-ordered the cell to the file's tail (cells render in source-row
    // order). Routing every local commit through revalidateCell (ba019e8)
    // made the just-edited row teleport out of the viewport on every commit.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "a", side: "source", value: "A" }),
      makeRow({ cellId: "b", side: "source", value: "B" }),
      makeRow({ cellId: "b", side: "target", value: "B-old" }),
      makeRow({ cellId: "c", side: "source", value: "C" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(3))
    expect(result.current.cells.map((c) => c.id)).toEqual(["a", "b", "c"])

    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "b", side: "source", value: "B" }),
      makeRow({ cellId: "b", side: "target", value: "B-new" }),
    ])
    act(() => { result.current.revalidateCell("b") })
    await waitFor(() => expect(result.current.cells.find((c) => c.id === "b")?.translated).toBe("B-new"))
    expect(result.current.cells.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("discards a targeted response that predates a mid-flight local edit, then applies the retry (FRO-247)", async () => {
    // A targeted fetch is in flight when a local edit lands. Its response
    // predates the edit (freshness floor > fetch startSeq) and must be
    // discarded — then the bounded retry refetches against the newer state
    // and the fresh row takes over.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "old" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // First targeted response: stale (snapshotted before the edit).
    fetchByIdsMock.mockImplementationOnce(async () => {
      await gate
      return [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "old" }),
      ]
    })
    // Retry response: the projection has caught up.
    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "v2", validated: true }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    // Let the first fetch start (captures its startSeq) before the edit.
    await act(async () => {})
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "v2" }) })
    expect(result.current.cells[0].translated).toBe("v2")

    await act(async () => { release(); await gate })
    // The stale response is discarded; the retry applies the fresh row.
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))
    expect(result.current.cells[0].translated).toBe("v2")
    expect(fetchByIdsMock).toHaveBeenCalledTimes(2)
  })

  it("keeps genuinely empty cells empty and lets an optimistic clear confirm — no stuck shadows (FRO-247)", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "S1" }),
      makeRow({ cellId: "c1", side: "target", value: "x" }),
      makeRow({ cellId: "c2", side: "source", value: "S2" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    expect(result.current.cells[1].translated).toBe("")

    // User clears c1's text — an optimistic edit to the empty string.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "" }) })
    expect(result.current.cells[0].translated).toBe("")
    expect(result.current.cells[0].status).toBe("empty")

    // The projection catches up: c1's target is now genuinely empty. The
    // shadow must confirm-and-clear (no stuck value), and untouched c2
    // stays empty.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "S1" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
      makeRow({ cellId: "c2", side: "source", value: "S2" }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells[0].translated).toBe("")
    expect(result.current.cells[1].translated).toBe("")

    // Prove the shadow is gone (not stuck at ""): a later server value for
    // c1 must drive the cell again.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "S1" }),
      makeRow({ cellId: "c1", side: "target", value: "remote" }),
      makeRow({ cellId: "c2", side: "source", value: "S2" }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.cells[0].translated).toBe("remote"))
  })

  it("rapid successive commits: a refetch reflecting only the first commit neither clobbers nor confirms the second (FRO-247)", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    // Two commits back-to-back; the shadow tracks the latest (v2).
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "v1" }) })
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "v2" }) })
    expect(result.current.cells[0].translated).toBe("v2")

    // Server has only applied commit 1: the row write-back lands (eventId
    // advances) but the displayed value must stay v2 — a v1 row can't
    // confirm a v2 shadow.
    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "v1", eventId: "ev-1" }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(result.current.cells[0].targetEventId).toBe("ev-1"))
    expect(result.current.cells[0].translated).toBe("v2")

    // Commit 2 projects: the shadow confirms and the authoritative row
    // (validated) drives the cell.
    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "v2", eventId: "ev-2", validated: true }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))
    expect(result.current.cells[0].translated).toBe("v2")
    expect(result.current.cells[0].targetEventId).toBe("ev-2")
  })

  it("lets a refetch that confirms the optimistic value take over (no permanent shadow)", async () => {
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "predicted" }) })
    expect(result.current.cells[0].translated).toBe("predicted")

    // A refetch returns the now-projected value → the optimistic shadow clears
    // and the authoritative row drives the cell (validated flag included).
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "predicted", validated: true }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))
    expect(result.current.cells[0].translated).toBe("predicted")
  })

  it("applyOptimisticTargetEdit synthesizes a target row when only source exists", async () => {
    // Source-only pair — the very first commit on this cell.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "Hello" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("")

    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "Hola" })
    })

    expect(result.current.cells[0].translated).toBe("Hola")
    expect(result.current.cells[0].original).toBe("Hello")
  })
})
