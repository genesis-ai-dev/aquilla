// History fetch failure — WHY: a failed D1 fetch on a synced project used to
// fall through to the empty-state copy "No edits yet.", giving a reviewer
// confidently wrong information about a cell that may have dozens of edits.
// Synced projects must see an explicit error + Retry; tokenless local
// projects (which legitimately use cell.history) must NOT see the error.
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

function makeCell(history: CellHistoryEntry[] = []): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "source text",
    translated: "target text",
    context: "GEN 1:1",
    history,
  } as CellData
}

const BASE_PROPS = {
  onClose: vi.fn(),
  projectId: "p1",
  fileId: "f1",
  getTokenForFile: async () => null,
}

function hookResult(over: Partial<ReturnType<typeof useCellEditHistory>>) {
  return {
    history: [],
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("HistoryDrawer fetch-error state", () => {
  it("shows an explicit error with Retry on a synced project instead of 'No edits yet.'", () => {
    const revalidate = vi.fn()
    mockHook.mockReturnValue(hookResult({ isError: true, revalidate }))
    render(<HistoryDrawer {...BASE_PROPS} cell={makeCell()} isSynced />)

    expect(screen.getByText("Couldn't load edit history.")).toBeInTheDocument()
    expect(screen.queryByText("No edits yet.")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(revalidate).toHaveBeenCalledTimes(1)
  })

  it("keeps the plain empty state for local (unsynced) projects", () => {
    // Tokenless local projects always land in isError; that is their normal
    // state, not a failure worth alarming the user about.
    mockHook.mockReturnValue(hookResult({ isError: true }))
    render(<HistoryDrawer {...BASE_PROPS} cell={makeCell()} isSynced={false} />)

    expect(screen.getByText("No edits yet.")).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load edit history.")).not.toBeInTheDocument()
  })

  it("shows local fallback entries with a refresh notice when the fetch fails", () => {
    const entry: CellHistoryEntry = {
      timestamp: "2026-07-01T10:00:00.000Z",
      value: "an older translation",
      source: "human",
      author: "ana",
      validated: false,
    }
    mockHook.mockReturnValue(hookResult({ isError: true }))
    render(<HistoryDrawer {...BASE_PROPS} cell={makeCell([entry])} isSynced />)

    expect(screen.getByText(/Couldn't refresh from the server/)).toBeInTheDocument()
    expect(screen.getByText("an older translation")).toBeInTheDocument()
  })

  it("shows a loading state instead of a premature empty state", () => {
    mockHook.mockReturnValue(hookResult({ isLoading: true }))
    render(<HistoryDrawer {...BASE_PROPS} cell={makeCell()} isSynced />)

    expect(screen.getByText("Loading history…")).toBeInTheDocument()
    expect(screen.queryByText("No edits yet.")).not.toBeInTheDocument()
  })
})
