// Expanding a collapsed edit group must survive a history refresh.
//
// WHY: the drawer keeps "show intermediate edits" in per-group component
// state, so anything that remounts the group silently collapses it while the
// user is reading it. The group key was `terminal.timestamp` + index, and a
// commit's timestamp changes the moment the server-confirmed entry (serverTs)
// replaces the locally pending one (clientTs) — i.e. on the very refresh the
// user triggers by editing. Keying on the stable event id keeps the same
// component mounted across that swap.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HistoryDrawer } from "./HistoryDrawer"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"

vi.mock("@/hooks/useCellEditHistory", () => ({
  useCellEditHistory: vi.fn(),
}))

import { useCellEditHistory } from "@/hooks/useCellEditHistory"

const mockHook = vi.mocked(useCellEditHistory)

const CELL = {
  id: "c1",
  fileId: "f1",
  original: "source text",
  translated: "v1 final",
  history: [],
} as unknown as CellData

const BASE_PROPS = {
  onClose: vi.fn(),
  projectId: "p1",
  fileId: "f1",
  getTokenForFile: async () => "token",
  isSynced: true,
}

/** Three incremental edits by one author — the drawer collapses these into a
 *  single group with two intermediate edits behind the toggle. */
function edits(baseMs: number, syncState?: CellHistoryEntry["syncState"]): CellHistoryEntry[] {
  return ["v1", "v1 updated", "v1 final"].map((value, i) => ({
    timestamp: new Date(baseMs + i * 1000).toISOString(),
    value,
    source: "human" as const,
    author: "alice",
    validated: false,
    eventId: `e${i + 1}`,
    isStale: false,
    ...(syncState ? { syncState } : {}),
  }))
}

function hookResult(history: CellHistoryEntry[]) {
  return { history, isLoading: false, isError: false, revalidate: vi.fn() }
}

beforeEach(() => vi.clearAllMocks())

describe("HistoryDrawer intermediate-edits toggle", () => {
  it("stays expanded when the same commits come back with server timestamps", () => {
    // Locally pending commits first — what the drawer shows while the outbox
    // is still flushing.
    mockHook.mockReturnValue(hookResult(edits(1_700_000_000_000, "pending")))
    const { rerender } = render(<HistoryDrawer {...BASE_PROPS} cell={CELL} />)

    fireEvent.click(screen.getByRole("button", { name: "Show intermediate edits" }))
    expect(screen.getByRole("button", { name: "Hide intermediate edits" })).toBeInTheDocument()

    // The server ack lands: same events (same ids), server-recorded timestamps.
    mockHook.mockReturnValue(hookResult(edits(1_700_000_005_000)))
    rerender(<HistoryDrawer {...BASE_PROPS} cell={CELL} />)

    expect(screen.getByRole("button", { name: "Hide intermediate edits" })).toBeInTheDocument()
    expect(screen.getByText("v1 updated")).toBeInTheDocument()
  })
})
