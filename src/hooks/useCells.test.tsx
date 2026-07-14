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
// Seam for the M2-1 conditional refetch (?since= delta). Only consulted when
// the hook holds a watermark (cache hit with maxServerSeq, or streamMeta).
const fetchDeltaMock = vi.fn<(projectId: string, fileId: string, since: number, jwt: string) => Promise<unknown>>()
// Watermark the streamFileCells mock reports via onMeta. `maxServerSeq` is
// the single-value case (every page agrees); `perPage` overrides it with one
// value per page index so B2 tests can stage a mid-stream watermark bump
// (the torn-snapshot tell). undefined = pre-M2-1 server → keeps full-streaming.
const streamMeta: { maxServerSeq?: number; perPage?: Array<number | undefined> } = {}
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
    onMeta?: (meta: { maxServerSeq?: number | null }) => void,
  ) => {
    // onMeta fires once per page (matching the real streamFileCells): with
    // `perPage` staged, page i reports perPage[i]; otherwise every page
    // reports the single `maxServerSeq`.
    const fireMeta = (pageIndex: number) => {
      if (!onMeta) return
      const per = streamMeta.perPage
      onMeta({
        maxServerSeq: per ? per[Math.min(pageIndex, per.length - 1)] : streamMeta.maxServerSeq,
      })
    }
    if (pagesMock.queue.length > 0) {
      // Streaming/pagination fixtures are source pages; the target pass yields
      // nothing so the source pass drains the queue.
      if (side === "target") {
        fireMeta(0)
        await onPage([], true)
        return
      }
      const pages = pagesMock.queue.splice(0)
      for (let i = 0; i < pages.length; i++) {
        fireMeta(i)
        const cont = await onPage(pages[i], i === pages.length - 1)
        if (cont === false) return
      }
      return
    }
    fireMeta(0)
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
  fetchCellsDelta: (...args: unknown[]) =>
    fetchDeltaMock(...(args as Parameters<typeof fetchDeltaMock>)),
}))

// Stub the IDB cells-cache I/O. The hook reads/writes it on hard fetches; the
// real impl is keyed by `${projectId}:${fileId}` and persists across tests
// in fake-indexeddb, which bleeds rows between tests that share the same
// (projectId, fileId) fixture. `cacheEntry` lets the M2-1 tests stage a warm
// cache hit. mergeCellsDelta stays REAL (importOriginal) so the conditional
// refetch tests exercise the actual lib merge, not a stand-in.
const cacheEntry: { value: { rows: CellRow[]; maxServerSeq?: number } | null } = { value: null }
// Every writeCellsCache call is captured so B1/B2 tests can assert what
// watermark (if any) would have been PERSISTED to IDB — the persisted cursor
// is what makes a bad watermark sticky across reloads.
const cacheWrites: Array<{ rows: CellRow[]; maxServerSeq: number | undefined }> = []
vi.mock("@/lib/sync/cells-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cells-cache")>()
  return {
    ...actual,
    readCellsCache: async () =>
      cacheEntry.value
        ? { key: "k", maxLastEditAt: 0, cachedAt: 0, ...cacheEntry.value }
        : null,
    writeCellsCache: async (
      _projectId: string,
      _fileId: string,
      rows: CellRow[],
      maxServerSeq?: number,
    ) => {
      cacheWrites.push({ rows, maxServerSeq })
    },
    resetCellsCacheConnectionForTests: async () => {},
  }
})

// Count buildCellData invocations indirectly: it calls formatVttTime once per
// axis for any cell carrying timecodes (useCells.buildCellData). A per-page
// full rebuild over N accumulated cells therefore drives O(pages × cells)
// formatVttTime calls; the coalesced path drives O(cells). Wrapping the real
// impl (vi.hoisted so the factory can reach the counter) lets a test assert the
// rebuild work stays linear without coupling to React's commit batching.
const vtt = vi.hoisted(() => ({ calls: 0 }))
vi.mock("@/lib/video/vtt-generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/vtt-generator")>()
  return {
    ...actual,
    formatVttTime: (seconds: number) => {
      vtt.calls++
      return actual.formatVttTime(seconds)
    },
  }
})

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
  fetchDeltaMock.mockReset()
  pagesMock.queue = []
  pagesMock.pendingResolvers = []
  sideCache = null
  cacheEntry.value = null
  cacheWrites.length = 0
  delete streamMeta.maxServerSeq
  delete streamMeta.perPage
  vtt.calls = 0
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

  it("does not rebuild the whole cell list on every page of a hard stream (no O(N^2) first open)", async () => {
    // A ~30k-cell Bible file streams in ~60 pages on first open. The old path
    // ran a FULL rebuild (joinSourceAndTarget + buildCellData over every
    // accumulated row) on every source page — O(pages × cells) construction
    // work. The fix paints the first page (so the empty state never flashes)
    // then swaps in the complete list once, so total rebuild work is linear.
    //
    // Each cell carries timecodes, so buildCellData calls formatVttTime twice
    // per cell built. Counting those calls measures total rebuild work without
    // depending on React's commit batching (which coalesces the per-page
    // setCells into the same final reference and hides the wasted CPU).
    const pageCount = 6
    pagesMock.queue = Array.from({ length: pageCount }, (_, i) => [
      makeRow({ cellId: `p${i}`, side: "source", value: `P${i}`, startMs: i * 1000, endMs: i * 1000 + 500 }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )

    await waitFor(() => expect(result.current.cells).toHaveLength(pageCount))
    expect(result.current.isLoading).toBe(false)
    // Accumulation is correct and ordered (the in-place append preserves order).
    expect(result.current.cells.map((c) => c.id)).toEqual(
      Array.from({ length: pageCount }, (_, i) => `p${i}`),
    )
    // Linear rebuild work. The hard load builds the first page (1 cell) then
    // the whole list once (6), and a follow-up soft revalidate rebuilds once
    // more (6) — ~13 cells built × 2 formatVttTime calls ≈ 26. A per-page
    // rebuild builds 1+2+3+4+5+6 + 6 + 6 = 33 cells → 66 calls. The bound sits
    // between, so it fails on the quadratic path and passes on the linear one.
    expect(vtt.calls).toBeLessThanOrEqual(40)
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
    expect(result.current.cells[0].aiDrafted).toBe(false)
    expect(result.current.cells[0].original).toBe("Hello world") // source untouched

    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "Borrador", aiDrafted: true })
    })
    expect(result.current.cells[0].aiDrafted).toBe(true)

    // Any ordinary editor commit is a human touch and clears the draft marker.
    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "Corrección humana" })
    })
    expect(result.current.cells[0].aiDrafted).toBe(false)
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

  it("revalidateCell writes the confirmed row back to the warm-open cache", async () => {
    streamMeta.maxServerSeq = 12
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "old", eventId: "ev-old" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    await waitFor(() => expect(cacheWrites.length).toBeGreaterThan(0))
    cacheWrites.length = 0

    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "new", eventId: "ev-new" }),
    ])

    act(() => { result.current.revalidateCell("c1") })

    await waitFor(() => expect(result.current.cells[0].translated).toBe("new"))
    await waitFor(() => expect(cacheWrites.length).toBeGreaterThan(0))
    const latest = cacheWrites.at(-1)
    const cachedTarget = latest?.rows.find((row) => row.cellId === "c1" && row.side === "target")
    expect(cachedTarget?.value).toBe("new")
    expect(cachedTarget?.eventId).toBe("ev-new")
    expect(latest?.maxServerSeq).toBe(12)
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

// ── M2-1 conditional refetch (?since= delta) ────────────────────────────────
//
// Why this matters: a Bible-sized book is ~60 pages per full stream, and the
// hook used to re-stream ALL of them on every window focus / post-commit
// revalidate (PERF-4). With a watermark, those triggers must collapse to one
// delta request — and the merge must preserve row order and still deliver
// post-commit rows (targetEventId updates) that confirm pending writes.
describe("useCells conditional refetch (M2-1)", () => {
  it("warm reopen with a cached watermark sends ONE ?since= request and no full stream", async () => {
    cacheEntry.value = {
      rows: [
        makeRow({ cellId: "c1", side: "source", value: "cached-src" }),
        makeRow({ cellId: "c1", side: "target", value: "cached-tgt" }),
      ],
      maxServerSeq: 10,
    }
    // Nothing changed since the snapshot.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 10,
    })
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(1))
    expect(fetchDeltaMock).toHaveBeenCalledWith("proj-a", "file-x", 10, "fake-jwt")
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells).toHaveLength(1)
    expect(result.current.cells[0].original).toBe("cached-src")
    expect(result.current.cells[0].translated).toBe("cached-tgt")
    // The full stream never ran.
    expect(fetchAllMock).not.toHaveBeenCalled()
  })

  it("merges a delta through the real lib merge: changed rows update in place, deletions drop", async () => {
    cacheEntry.value = {
      rows: [
        makeRow({ cellId: "a", side: "source", value: "A", anchorCellId: null }),
        makeRow({ cellId: "b", side: "source", value: "B", anchorCellId: "a" }),
        makeRow({ cellId: "c", side: "source", value: "C", anchorCellId: "b" }),
        makeRow({ cellId: "b", side: "target", value: "B-tgt", anchorCellId: "a" }),
      ],
      maxServerSeq: 5,
    }
    // b's target was edited; c was deleted outright.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta",
      changedCellIds: ["b", "c"],
      cells: [
        makeRow({ cellId: "b", side: "source", value: "B", anchorCellId: "a" }),
        makeRow({ cellId: "b", side: "target", value: "B-new", anchorCellId: "a", eventId: "ev-new" }),
      ],
      maxServerSeq: 8,
    })
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    expect(result.current.cells.map((c) => c.id)).toEqual(["a", "b"])
    expect(result.current.cells[1].translated).toBe("B-new")
    // Post-commit read-back confirmation keys off targetEventId updates.
    expect(result.current.cells[1].targetEventId).toBe("ev-new")
    expect(fetchAllMock).not.toHaveBeenCalled()
  })

  it("window focus revalidates via the delta path instead of re-streaming the file (PERF-4)", async () => {
    // Cold load: full stream hands the hook a watermark via stream meta.
    streamMeta.maxServerSeq = 3
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "old" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    const fullStreamCalls = fetchAllMock.mock.calls.length

    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta",
      changedCellIds: ["c1"],
      cells: [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "peer-edit" }),
      ],
      maxServerSeq: 4,
    })
    act(() => { window.dispatchEvent(new Event("focus")) })
    await waitFor(() => expect(result.current.cells[0].translated).toBe("peer-edit"))
    expect(fetchDeltaMock).toHaveBeenCalledWith("proj-a", "file-x", 3, "fake-jwt")
    // No additional full stream ran for the focus revalidate.
    expect(fetchAllMock.mock.calls.length).toBe(fullStreamCalls)

    // The cursor advanced: the next revalidate asks from seq 4.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 4,
    })
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(2))
    expect(fetchDeltaMock).toHaveBeenLastCalledWith("proj-a", "file-x", 4, "fake-jwt")
  })

  it("falls back to the full stream when the server answers resync", async () => {
    cacheEntry.value = {
      rows: [makeRow({ cellId: "c1", side: "source", value: "stale" })],
      maxServerSeq: 2,
    }
    fetchDeltaMock.mockResolvedValueOnce({ kind: "resync" })
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "fresh" }),
      makeRow({ cellId: "c2", side: "source", value: "bulk-imported" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    expect(result.current.cells[0].original).toBe("fresh")
    expect(fetchDeltaMock).toHaveBeenCalledTimes(1)
    expect(fetchAllMock).toHaveBeenCalled()
  })

  it("a failed delta (e.g. RES-6 timeout) leaves the cached view intact and surfaces isError", async () => {
    cacheEntry.value = {
      rows: [
        makeRow({ cellId: "c1", side: "source", value: "cached-src" }),
        makeRow({ cellId: "c1", side: "target", value: "cached-tgt" }),
      ],
      maxServerSeq: 7,
    }
    fetchDeltaMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    // Cached rows survive — no blanking, no fallback stream mid-error.
    expect(result.current.cells).toHaveLength(1)
    expect(result.current.cells[0].original).toBe("cached-src")
    expect(fetchAllMock).not.toHaveBeenCalled()

    // The next trigger retries and recovers.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 7,
    })
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.isError).toBe(false))
    expect(result.current.cells[0].original).toBe("cached-src")
  })

  it("a delta cannot clobber a cell mutated locally after the snapshot began (FRO-247)", async () => {
    cacheEntry.value = {
      rows: [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "old" }),
      ],
      maxServerSeq: 1,
    }
    // Stall the delta until the local edit lands.
    let resolveDelta: (v: unknown) => void = () => {}
    fetchDeltaMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDelta = resolve }),
    )
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(1))

    // Local optimistic edit AFTER the delta snapshot began.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "mine" }) })
    expect(result.current.cells[0].translated).toBe("mine")

    // The delta resolves carrying a PRE-edit server row for the same cell.
    act(() => {
      resolveDelta({
        kind: "delta",
        changedCellIds: ["c1"],
        cells: [
          makeRow({ cellId: "c1", side: "source", value: "src" }),
          makeRow({ cellId: "c1", side: "target", value: "stale-server" }),
        ],
        maxServerSeq: 2,
      })
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    // The local write survives the merge.
    expect(result.current.cells[0].translated).toBe("mine")
  })

  it("a delta whose protected-cell rows were discarded does NOT advance the watermark; the peer edit re-delivers once the floor clears (B1)", async () => {
    cacheEntry.value = {
      rows: [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "old" }),
      ],
      maxServerSeq: 1,
    }
    // Stall the first delta until the local edit lands.
    let resolveDelta: (v: unknown) => void = () => {}
    fetchDeltaMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDelta = resolve }),
    )
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(1))

    // Local edit AFTER the delta snapshot began → c1 is floor/shadow-protected.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "mine" }) })

    // The delta resolves carrying a peer commit (E2) for the SAME cell. The
    // merge rightly discards it (the local write is fresher) — but the cursor
    // must NOT advance past E2, or every future ?since= starts beyond the
    // peer's committed edit and it is skipped forever (split-brain that IDB
    // then persists across reloads).
    act(() => {
      resolveDelta({
        kind: "delta",
        changedCellIds: ["c1"],
        cells: [
          makeRow({ cellId: "c1", side: "source", value: "src" }),
          makeRow({ cellId: "c1", side: "target", value: "peer-E2", eventId: "ev-E2" }),
        ],
        maxServerSeq: 2,
      })
    })
    await waitFor(() => expect(cacheWrites.length).toBeGreaterThan(0))
    expect(result.current.cells[0].translated).toBe("mine")
    // The persisted cursor stayed at the request's `since` — not past E2.
    expect(cacheWrites.at(-1)?.maxServerSeq).toBe(1)

    // The own write confirms via the targeted read-back → shadow clears and
    // the freshness floor settles (no local mutation outpaces the next fetch).
    fetchByIdsMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "mine", eventId: "ev-mine" }),
    ])
    act(() => { result.current.revalidateCell("c1") })
    await waitFor(() => expect(result.current.cells[0].targetEventId).toBe("ev-mine"))

    // The next trigger re-sends ?since=1 (NOT 2): the held-back range is
    // re-delivered and the cell's current server row now merges.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta",
      changedCellIds: ["c1"],
      cells: [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "peer-E2-final", eventId: "ev-E2-final" }),
      ],
      maxServerSeq: 3,
    })
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(2))
    expect(fetchDeltaMock).toHaveBeenLastCalledWith("p", "f", 1, "fake-jwt")
    await waitFor(() => expect(result.current.cells[0].translated).toBe("peer-E2-final"))
  })

  it("a soft full re-stream that discarded protected rows persists NO watermark — the next trigger full-streams (B1)", async () => {
    // Cold load: pre-M2-1 response shape, so no cursor is minted yet.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "old" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    // A soft refetch goes in flight against an M2-1 server (watermark now
    // reported). Its snapshot is STALE — it predates the local edit below.
    streamMeta.maxServerSeq = 5
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    fetchAllMock.mockImplementationOnce(async () => {
      await gate
      return [
        makeRow({ cellId: "c1", side: "source", value: "src" }),
        makeRow({ cellId: "c1", side: "target", value: "old" }),
      ]
    })
    act(() => { result.current.revalidate() })
    await act(async () => {})

    // Local edit while the stream is in flight → c1's rows are protected.
    act(() => { result.current.applyOptimisticTargetEdit("c1", { value: "mine" }) })

    await act(async () => { release(); await gate })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.cells[0].translated).toBe("mine")
    // The swap discarded the stale server rows for c1, so the stored snapshot
    // is NOT a faithful image of the server at seq 5 — no cursor may be
    // persisted with it.
    expect(cacheWrites.at(-1)?.maxServerSeq).toBeUndefined()

    // The next trigger full-streams (never a delta) and, now postdating the
    // edit, confirms the committed value.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "mine", validated: true }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.cells[0].status).toBe("validated"))
    expect(fetchDeltaMock).not.toHaveBeenCalled()
  })

  it("a torn full stream (mid-stream watermark bump) stores NO cursor — the next trigger full-streams and self-heals (B2)", async () => {
    // The server paginates by offset: rows can shift across page boundaries
    // while the stream is in flight, skipping a cell entirely. The tell is a
    // page-to-page maxServerSeq bump. A torn snapshot must not mint a ?since=
    // cursor — the skipped cell never "changes" again, so no delta would ever
    // re-deliver it and the torn state would persist in IDB forever.
    streamMeta.maxServerSeq = 5
    streamMeta.perPage = [5, 9] // the event log advanced between source pages
    pagesMock.queue = [
      [makeRow({ cellId: "a", side: "source", value: "A" })],
      // 'b' was skipped: a deletion above it shifted offsets mid-stream.
      [makeRow({ cellId: "c", side: "source", value: "C" })],
    ]
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    // The torn snapshot's rows are kept (better than blanking the view) but
    // no watermark was persisted alongside them.
    expect(cacheWrites.at(-1)?.maxServerSeq).toBeUndefined()

    // Next trigger: no cursor ⇒ no delta request; the full re-stream delivers
    // a consistent snapshot including the skipped cell, and mints a cursor.
    delete streamMeta.perPage
    streamMeta.maxServerSeq = 9
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "a", side: "source", value: "A" }),
      makeRow({ cellId: "b", side: "source", value: "B" }),
      makeRow({ cellId: "c", side: "source", value: "C" }),
    ])
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.cells).toHaveLength(3))
    expect(fetchDeltaMock).not.toHaveBeenCalled()
    expect(cacheWrites.at(-1)?.maxServerSeq).toBe(9)
  })

  it("a consistent multi-page stream still mints the first page's cursor (B2 control)", async () => {
    streamMeta.maxServerSeq = 7
    streamMeta.perPage = [7, 7]
    pagesMock.queue = [
      [makeRow({ cellId: "a", side: "source", value: "A" })],
      [makeRow({ cellId: "b", side: "source", value: "B" })],
    ]
    const { result } = renderHook(() =>
      useCells({ projectId: "p", fileId: "f", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))
    expect(cacheWrites.at(-1)?.maxServerSeq).toBe(7)

    // The minted cursor drives the delta path on the next trigger.
    fetchDeltaMock.mockResolvedValueOnce({
      kind: "delta", changedCellIds: [], cells: [], maxServerSeq: 7,
    })
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(fetchDeltaMock).toHaveBeenCalledTimes(1))
    expect(fetchDeltaMock).toHaveBeenCalledWith("p", "f", 7, "fake-jwt")
  })
})


// ---------------------------------------------------------------------------
// FRO-274: quarantined outbox records excluded from overlay; shadow cleared
// ---------------------------------------------------------------------------
describe("FRO-274: quarantined outbox filtering and shadow clear", () => {
  // Import outbox helpers — they use fake-indexeddb from the global setup.
  // We need to reset IDB state between tests to avoid bleed.
  let enqueue: typeof import("@/lib/sync/outbox").enqueueOutboxEvent
  let quarantine: typeof import("@/lib/sync/outbox").quarantineOutboxEvents
  let resetConn: typeof import("@/lib/sync/outbox").resetOutboxConnectionForTests

  beforeEach(async () => {
    // Dynamically import so the module is fresh; reset + delete the DB.
    const outboxMod = await import("@/lib/sync/outbox")
    enqueue = outboxMod.enqueueOutboxEvent
    quarantine = outboxMod.quarantineOutboxEvents
    resetConn = outboxMod.resetOutboxConnectionForTests
    await resetConn()
    await new Promise<void>((resolve) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onsuccess = () => resolve()
      d.onerror = () => resolve()
      d.onblocked = () => resolve()
    })
    fetchAllMock.mockReset()
    fetchByIdsMock.mockReset()
    fetchByIdsMock.mockResolvedValue([])
    sideCache = null
  })

  it("quarantined (failed) outbox record is excluded from the pending overlay", async () => {
    // Stage rows: c1 already has a server target value.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "src" }),
      makeRow({ cellId: "c1", side: "target", value: "server-value" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].translated).toBe("server-value")

    // Enqueue a commit event for c1 → overlay shows the pending value.
    const { CQRS_SCHEMA_VERSION } = await import("@/lib/sync/outbox-types")
    await act(async () => {
      await enqueue({
        id: "ev-c1",
        schemaVersion: CQRS_SCHEMA_VERSION,
        kind: "target.cell.commit",
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "c1",
        author: "alice",
        payload: { value: "pending-value", valueHtml: "<p>pending-value</p>" },
        clientTs: Date.now(),
      })
    })
    await waitFor(() => expect(result.current.cells[0].translated).toBe("pending-value"))
    expect(result.current.cells[0].hasPendingEdit).toBe(true)

    // Quarantine the event (403 rejection) → overlay must STOP showing pending.
    await act(async () => {
      await quarantine(["ev-c1"], { status: 403, reason: "forbidden" })
    })
    // After quarantine the overlay no longer applies the rejected value.
    await waitFor(() => expect(result.current.cells[0].hasPendingEdit).toBeFalsy())
    // Cell reverts to server value (shadow also cleared since the same value
    // was in both overlay and shadow).
    await waitFor(() => expect(result.current.cells[0].translated).toBe("server-value"))
  })

  it("shadow is cleared on quarantine only for the cell whose event failed (FRO-274 + FRO-247 write-clock preserved)", async () => {
    // Two cells: c1 committed (quarantined), c2 committed (still pending).
    // c2's shadow must not be touched.
    fetchAllMock.mockResolvedValueOnce([
      makeRow({ cellId: "c1", side: "source", value: "S1" }),
      makeRow({ cellId: "c1", side: "target", value: "s1-server" }),
      makeRow({ cellId: "c2", side: "source", value: "S2" }),
      makeRow({ cellId: "c2", side: "target", value: "s2-server" }),
    ])
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-x", getToken, enabled: true }),
    )
    await waitFor(() => expect(result.current.cells).toHaveLength(2))

    // Apply optimistic edits for both cells (simulates commits recorded by applyOptimisticTargetEdit).
    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "c1-optimistic" })
      result.current.applyOptimisticTargetEdit("c2", { value: "c2-optimistic" })
    })
    expect(result.current.cells.find((c) => c.id === "c1")?.translated).toBe("c1-optimistic")
    expect(result.current.cells.find((c) => c.id === "c2")?.translated).toBe("c2-optimistic")

    // Enqueue events in the outbox so the quarantine has something to operate on.
    const { CQRS_SCHEMA_VERSION } = await import("@/lib/sync/outbox-types")
    await act(async () => {
      await enqueue({
        id: "ev-c1",
        schemaVersion: CQRS_SCHEMA_VERSION,
        kind: "target.cell.commit",
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "c1",
        author: "alice",
        payload: { value: "c1-optimistic" },
        clientTs: Date.now(),
      })
      await enqueue({
        id: "ev-c2",
        schemaVersion: CQRS_SCHEMA_VERSION,
        kind: "target.cell.commit",
        projectId: "proj-a",
        fileId: "file-x",
        cellId: "c2",
        author: "alice",
        payload: { value: "c2-optimistic" },
        clientTs: Date.now(),
      })
    })

    // Quarantine ONLY c1.
    await act(async () => {
      await quarantine(["ev-c1"], { status: 403, reason: "forbidden" })
    })

    // c1 shadow cleared; c2 shadow untouched.
    await waitFor(() => {
      const c1 = result.current.cells.find((c) => c.id === "c1")
      return c1?.translated === "s1-server"
    })
    const c2After = result.current.cells.find((c) => c.id === "c2")
    expect(c2After?.translated).toBe("c2-optimistic")
    expect(c2After?.hasPendingEdit).toBe(true)
  })
})

describe("useCells (AQU-538, target lanes)", () => {
  // A cell with TWO target rows sharing the same cellId but different lanes.
  // `targetLang` isn't on CellRow yet (slice 1 lands it) — attach it via a
  // cast, mirroring the hook's own defensive read.
  function twoLaneRows(): CellRow[] {
    return [
      makeRow({ cellId: "c1", side: "source", value: "Source 1" }),
      makeRow({ cellId: "c1", side: "target", value: "hello" }), // default lane ''
      { ...makeRow({ cellId: "c1", side: "target", value: "hola", eventId: "e-c1-target-es" }), targetLang: "es" } as CellRow,
    ]
  }

  it("renders the ACTIVE lane's target row when a cell has multiple lanes", async () => {
    fetchAllMock.mockResolvedValue(twoLaneRows())
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-a", fileId: "file-lane", getToken, enabled: true, lane: "es" }),
    )
    await waitFor(() => expect(result.current.cells.length).toBe(1))
    // Only the "es" target row participates in the pair for this view.
    expect(result.current.cells[0].translated).toBe("hola")
  })

  it("the default lane ('') shows the default-lane target, not another lane's", async () => {
    fetchAllMock.mockResolvedValue(twoLaneRows())
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-b", fileId: "file-lane", getToken, enabled: true, lane: "" }),
    )
    await waitFor(() => expect(result.current.cells.length).toBe(1))
    expect(result.current.cells[0].translated).toBe("hello")
  })

  it("an optimistic edit touches ONLY the active lane's row", async () => {
    fetchAllMock.mockResolvedValue(twoLaneRows())
    const { result } = renderHook(() =>
      useCells({ projectId: "proj-c", fileId: "file-lane", getToken, enabled: true, lane: "es" }),
    )
    await waitFor(() => expect(result.current.cells[0]?.translated).toBe("hola"))
    act(() => {
      result.current.applyOptimisticTargetEdit("c1", { value: "nuevo" })
    })
    // The "es" view reflects the edit — proving the edit matched the "es"
    // target row (had it wrongly mutated the default-lane row, the es-filtered
    // view would still read "hola").
    await waitFor(() => expect(result.current.cells[0].translated).toBe("nuevo"))
    expect(result.current.cells[0].hasPendingEdit).toBe(true)
  })
})
