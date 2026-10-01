// Phase 2b tests for useCellsAuditStats — drops React Query in favor of
// the Phase 2a pattern. Mocks the global fetch directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useCellsAuditStats, deriveCommittedCellStats, type CellAuditStats } from "./useCellsAuditStats"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { contentHash } from "@/lib/dcs/content-hash"

vi.mock("@/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example.com",
}))

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

const TOKEN_FN = vi.fn().mockResolvedValue("test-token")

const STATS_RESPONSE = [
  {
    cellId: "cell-1",
    editCount: 3,
    contentHash: "abc123",
    lastEditAt: 1700,
    lastEditEventId: "ev-1",
    activeValidators: ["alice", "bob"],
  },
  {
    cellId: "cell-2",
    editCount: 7,
    contentHash: "def456",
    lastEditAt: 1800,
    lastEditEventId: null,
    activeValidators: [],
  },
]

describe("useCellsAuditStats (Phase 2b)", () => {
  it("returns a Map keyed by cellId on happy path", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
    ) as unknown as typeof fetch

    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byCellId.size).toBe(2)
    const c1 = result.current.byCellId.get("cell-1")!
    expect(c1.editCount).toBe(3)
    expect(c1.activeValidators).toEqual(["alice", "bob"])
  })

  it("returns isError when token is null", async () => {
    const noTokenFn = vi.fn().mockResolvedValue(null)
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: noTokenFn,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns isError on non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("err", { status: 500 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.byCellId.size).toBe(0)
  })

  it("does not fetch when disabled", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: false,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("does not fetch when fileId is null", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: null,
        getTokenForFile: TOKEN_FN,
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.byCellId.size).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("revalidate() triggers a refetch", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: [STATS_RESPONSE[0]] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 })) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
      }),
    )
    await waitFor(() => expect(result.current.byCellId.size).toBe(1))
    act(() => { result.current.revalidate() })
    await waitFor(() => expect(result.current.byCellId.size).toBe(2))
  })

  // Perf regression guard (see ProjectWorkspace.tsx commitCompletedCell etc.):
  // a single-cell commit must not re-fetch stats for the whole file. Without
  // revalidateCellStats, every keystroke-commit paired an O(1) cell fetch
  // with an O(all-cells) audit-stats fetch.
  describe("revalidateCellStats", () => {
    it("fetches only the given cell (scoped by cellId) and merges it into the existing map, without a full-file refetch", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
      ) as unknown as typeof fetch

      const { result } = renderHook(() =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      )
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))
      expect(global.fetch).toHaveBeenCalledTimes(1)

      const updatedCell1 = {
        cellId: "cell-1",
        editCount: 4,
        contentHash: "post-commit-hash",
        lastEditAt: 1900,
        lastEditEventId: "ev-2",
        activeValidators: [],
      }
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: [updatedCell1] }), { status: 200 }),
      ) as unknown as typeof fetch

      act(() => { result.current.revalidateCellStats("cell-1") })

      await waitFor(() => expect(result.current.byCellId.get("cell-1")?.editCount).toBe(4))

      // Exactly one request, scoped to the changed cell — not a full-file fetch.
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(calledUrl).toContain("cellId=cell-1")

      // The untouched cell's stats are preserved (merge, not replace).
      expect(result.current.byCellId.get("cell-2")?.editCount).toBe(7)
      expect(result.current.byCellId.size).toBe(2)
    })

    it("prefers target-side stats when a scoped response includes both source and target rows", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
      ) as unknown as typeof fetch

      const { result } = renderHook(() =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      )
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({
          cells: [
            {
              side: "source",
              cellId: "cell-1",
              editCount: 1,
              contentHash: "source-hash",
              lastEditAt: 1000,
              lastEditEventId: "source-event",
              activeValidators: [],
            },
            {
              side: "target",
              cellId: "cell-1",
              editCount: 4,
              contentHash: "target-hash",
              lastEditAt: 1900,
              lastEditEventId: "target-event",
              activeValidators: ["bob"],
            },
          ],
        }), { status: 200 }),
      ) as unknown as typeof fetch

      act(() => { result.current.revalidateCellStats("cell-1") })

      await waitFor(() => expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["bob"]))
      expect(result.current.byCellId.get("cell-1")?.lastEditEventId).toBe("target-event")
    })

    it("is a no-op when the server returns no matching row (e.g. a stale cellId)", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
      ) as unknown as typeof fetch
      const { result } = renderHook(() =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
        }),
      )
      await waitFor(() => expect(result.current.byCellId.size).toBe(2))

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ cells: [] }), { status: 200 }),
      ) as unknown as typeof fetch
      await act(async () => {
        result.current.revalidateCellStats("cell-1")
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.byCellId.get("cell-1")?.editCount).toBe(3)
    })
  })
})

// Derived stats from the POST /events response rows — replaces the
// per-commit GET /cells/audit-stats?cellId=. Must read the rows the way the
// server route does, or the validation pill / stale-parent logic drifts.
describe("deriveCommittedCellStats", () => {
  const base: Omit<CellRow, "side" | "eventId" | "value"> = {
    cellId: "cell-1", valueHtml: null, type: null, canonicalRef: null, anchorCellId: null,
    sourceEventId: null, lastEditor: "alice", lastEditAt: 1234, validated: false, wordCount: 1,
  }
  const source: CellRow = { ...base, side: "source", eventId: "S0", value: "src" }
  const prev: CellAuditStats = {
    cellId: "cell-1", editCount: 3, contentHash: "old", lastEditAt: 1, lastEditEventId: "E0",
    activeValidators: ["bob"], waivers: [{ ruleId: "r1", waivedAt: "2026-01-01T00:00:00.000Z" }],
  }

  it("follows the active lane's target row: new head, validators reset, waivers kept, server hash", () => {
    const rows: CellRow[] = [
      source,
      { ...base, side: "target", eventId: "E1", value: "hola", targetLang: "" },
      { ...base, side: "target", eventId: "E9", value: "bonjour", targetLang: "fr" },
    ]
    expect(deriveCommittedCellStats("cell-1", rows, "", prev)).toEqual({
      cellId: "cell-1",
      editCount: 3,
      contentHash: contentHash("hola"),
      lastEditAt: 1234,
      lastEditEventId: "E1",
      activeValidators: [],
      waivers: prev.waivers,
    })
    expect(deriveCommittedCellStats("cell-1", rows, "fr", prev)?.lastEditEventId).toBe("E9")
  })

  it("keeps validators when the head did not move (a re-applied echo of the same event)", () => {
    const rows: CellRow[] = [source, { ...base, side: "target", eventId: "E0", value: "x" }]
    expect(deriveCommittedCellStats("cell-1", rows, "", prev)?.activeValidators).toEqual(["bob"])
  })

  it("falls back to the source row for a source-only cell and returns null with no rows", () => {
    expect(deriveCommittedCellStats("cell-1", [source], "", undefined)).toMatchObject({
      lastEditEventId: "S0", editCount: 0, activeValidators: [], waivers: [],
    })
    expect(deriveCommittedCellStats("cell-1", [], "", undefined)).toBeNull()
  })

  it("applyCommittedCellStats merges into the hook's map without a fetch", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cells: STATS_RESPONSE }), { status: 200 }),
    ) as unknown as typeof fetch
    const { result } = renderHook(() =>
      useCellsAuditStats({ enabled: true, fileId: "file-abc", getTokenForFile: TOKEN_FN }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const calls = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    let merged = false
    act(() => {
      merged = result.current.applyCommittedCellStats("cell-1", [
        { ...base, side: "target", eventId: "ev-2", value: "new" },
      ])
    })
    expect(merged).toBe(true)
    expect(result.current.byCellId.get("cell-1")).toMatchObject({
      lastEditEventId: "ev-2", activeValidators: [], editCount: 3,
    })
    expect(result.current.byCellId.get("cell-2")?.editCount).toBe(7)
    expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls)
  })
})

// ── AQU-1506 ────────────────────────────────────────────────────────────────
// A cell on an N-lane file has one target row PER LANE in the audit-stats
// response. The merge used to keep whichever target row came first — Postgres
// heap order, which a validate or commit rewrites — so the editor showed one
// lane's validators on another lane's page: "Validated by others" on a cell you
// had just validated yourself, and a batch validate that re-voted cells the
// server then folded away.
describe("useCellsAuditStats — lane-scoped merge (AQU-1506)", () => {
  const SOURCE_ROW = {
    side: "source",
    targetLang: "",
    cellId: "cell-1",
    editCount: 1,
    contentHash: "source-hash",
    lastEditAt: 1000,
    lastEditEventId: "ev-source",
    activeValidators: [],
  }
  const DEFAULT_LANE_ROW = {
    side: "target",
    targetLang: "",
    cellId: "cell-1",
    editCount: 2,
    contentHash: "default-hash",
    lastEditAt: 1800,
    lastEditEventId: "ev-default-head",
    activeValidators: [],
  }
  const FR_LANE_ROW = {
    side: "target",
    targetLang: "fr",
    cellId: "cell-1",
    editCount: 4,
    contentHash: "fr-hash",
    lastEditAt: 1700,
    lastEditEventId: "ev-fr-head",
    activeValidators: ["dev"],
  }

  // A fresh Response per call: a body can only be read once, and these tests
  // deliberately fetch more than once (lane switch, single-cell revalidate).
  function respondWith(cells: object[]) {
    global.fetch = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ cells }), { status: 200 })),
    ) as unknown as typeof fetch
  }

  async function statsOnLane(cells: object[], lane: string) {
    respondWith(cells)
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
        lane,
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    return result.current.byCellId.get("cell-1")
  }

  // The three orderings a two-lane file can arrive in. Row order is heap order,
  // so the answer must not depend on it.
  const ORDERINGS: [string, object[]][] = [
    ["source, default, fr", [SOURCE_ROW, DEFAULT_LANE_ROW, FR_LANE_ROW]],
    ["fr first (the default-lane page's wrong answer)", [FR_LANE_ROW, DEFAULT_LANE_ROW, SOURCE_ROW]],
    ["default first (the fr page's wrong answer)", [DEFAULT_LANE_ROW, FR_LANE_ROW, SOURCE_ROW]],
  ]

  for (const [label, rows] of ORDERINGS) {
    it(`picks the active lane's row regardless of row order — ${label}`, async () => {
      const onFr = await statsOnLane(rows, "fr")
      expect(onFr?.activeValidators).toEqual(["dev"])
      expect(onFr?.lastEditEventId).toBe("ev-fr-head")

      const onDefault = await statsOnLane(rows, "")
      expect(onDefault?.activeValidators).toEqual([])
      expect(onDefault?.lastEditEventId).toBe("ev-default-head")
    })
  }

  it("falls back to the source row when the active lane has no target row, never to another lane's", async () => {
    // `cell-1` is translated on fr only. On the default lane it must read as
    // untranslated-and-unvalidated — exactly as an untranslated cell on a
    // single-lane file does — not inherit fr's validators.
    const stats = await statsOnLane([SOURCE_ROW, FR_LANE_ROW], "")
    expect(stats?.activeValidators).toEqual([])
    expect(stats?.lastEditEventId).toBe("ev-source")
  })

  it("omits the cell entirely when only another lane's target row exists", async () => {
    respondWith([FR_LANE_ROW])
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
        lane: "",
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byCellId.has("cell-1")).toBe(false)
  })

  it("re-derives on a lane switch — the previous lane's map does not describe the new one", async () => {
    respondWith([SOURCE_ROW, DEFAULT_LANE_ROW, FR_LANE_ROW])
    const { result, rerender } = renderHook(
      ({ lane }: { lane: string }) =>
        useCellsAuditStats({
          enabled: true,
          fileId: "file-abc",
          getTokenForFile: TOKEN_FN,
          lane,
        }),
      { initialProps: { lane: "" } },
    )
    await waitFor(() =>
      expect(result.current.byCellId.get("cell-1")?.lastEditEventId).toBe("ev-default-head"),
    )
    rerender({ lane: "fr" })
    await waitFor(() =>
      expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["dev"]),
    )
  })

  it("keeps the pre-lane first-target-row reading when the worker sends no lane marker", async () => {
    // Back-compat: a sync-worker that predates the lane marker gives the client
    // no way to tell the rows apart. Reading every cell as unvalidated would be
    // a worse answer than the historical one, so the old reading stands.
    const unmarked = [
      { ...SOURCE_ROW, targetLang: undefined },
      { ...FR_LANE_ROW, targetLang: undefined },
      { ...DEFAULT_LANE_ROW, targetLang: undefined },
    ]
    const stats = await statsOnLane(unmarked, "fr")
    expect(stats?.lastEditEventId).toBe("ev-fr-head")
    expect(stats?.activeValidators).toEqual(["dev"])
  })

  it("is unchanged on a single-lane file: the target row wins over the source row", async () => {
    const stats = await statsOnLane([SOURCE_ROW, DEFAULT_LANE_ROW], "")
    expect(stats?.lastEditEventId).toBe("ev-default-head")
    // …and the reverse order gives the same answer.
    const reversed = await statsOnLane([DEFAULT_LANE_ROW, SOURCE_ROW], "")
    expect(reversed?.lastEditEventId).toBe("ev-default-head")
  })

  it("scopes the single-cell revalidate to the active lane too", async () => {
    respondWith([SOURCE_ROW, DEFAULT_LANE_ROW, FR_LANE_ROW])
    const { result } = renderHook(() =>
      useCellsAuditStats({
        enabled: true,
        fileId: "file-abc",
        getTokenForFile: TOKEN_FN,
        lane: "fr",
      }),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => { result.current.revalidateCellStats("cell-1") })
    await waitFor(() =>
      expect(result.current.byCellId.get("cell-1")?.lastEditEventId).toBe("ev-fr-head"),
    )
    expect(result.current.byCellId.get("cell-1")?.activeValidators).toEqual(["dev"])
  })
})
