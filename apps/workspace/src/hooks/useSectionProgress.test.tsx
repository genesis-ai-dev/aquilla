import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { useSectionProgress } from "./useSectionProgress"

// Phase 2c-β: section progress is computed from D1-projected cells, not from
// the legacy Y.Doc. The hook fetches via `fetchAllFileCells` — we mock that
// at the module boundary so the test stays a unit on the hook semantics.

vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: vi.fn(),
}))
import { fetchAllFileCells } from "@/lib/sync/cells-read"

const PROJECT = "proj-1"
const FILE = "file-1"

function row(opts: {
  cellId: string
  side: "source" | "target"
  value: string
  canonicalRef: string | null
  validated?: boolean
  lastEditor?: string | null
}): CellRow {
  return {
    cellId: opts.cellId,
    side: opts.side,
    value: opts.value,
    valueHtml: null,
    type: null,
    canonicalRef: opts.canonicalRef,
    anchorCellId: null,
    eventId: `evt-${opts.cellId}-${opts.side}`,
    sourceEventId: null,
    lastEditor: opts.lastEditor ?? null,
    lastEditAt: 0,
    validated: Boolean(opts.validated),
    wordCount: 0,
  }
}

const mockedFetch = fetchAllFileCells as unknown as ReturnType<typeof vi.fn>

describe("useSectionProgress", () => {
  beforeEach(() => {
    mockedFetch.mockReset()
  })
  afterEach(() => {
    mockedFetch.mockReset()
  })

  it("groups cells by canonical-ref chapter and reports completion", async () => {
    mockedFetch.mockResolvedValueOnce([
      row({ cellId: "c1", side: "source", value: "Hello", canonicalRef: "GEN 1:1" }),
      row({ cellId: "c1", side: "target", value: "Bonjour", canonicalRef: "GEN 1:1" }),
      row({ cellId: "c2", side: "source", value: "World", canonicalRef: "GEN 1:2" }),
      // c2 has no target → empty translated → 50% completion in chapter 1
      row({ cellId: "c3", side: "source", value: "!", canonicalRef: "GEN 2:1" }),
      row({ cellId: "c3", side: "target", value: "!", canonicalRef: "GEN 2:1" }),
    ])
    const getTokenForFile = vi.fn(async () => "jwt-token")
    const { result } = renderHook(() =>
      useSectionProgress(PROJECT, FILE, 1, getTokenForFile),
    )

    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 1_000 })

    const sections = result.current!
    expect(sections).toHaveLength(2)
    expect(sections[0].label).toBe("GEN 1")
    expect(sections[0].textCompleted).toBe(50)
    expect(sections[1].label).toBe("GEN 2")
    expect(sections[1].textCompleted).toBe(100)
  })

  it("returns null when projectId or fileId is null", () => {
    const { result } = renderHook(() =>
      useSectionProgress(null, FILE, 1, async () => "jwt"),
    )
    expect(result.current).toBeNull()
  })

  it("degrades to [] when the fetch throws so the sidebar doesn't hang on Loading…", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() =>
      useSectionProgress(PROJECT, FILE, 1, async () => "jwt"),
    )
    await waitFor(() => expect(result.current).toEqual([]), { timeout: 1_000 })
  })
})
