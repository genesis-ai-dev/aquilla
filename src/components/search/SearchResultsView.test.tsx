/**
 * SearchResultsView.test.tsx — AQU-309
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SearchResultsView } from "./SearchResultsView"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"

function makeResult(overrides: Partial<WorkspaceSearchResult> = {}): WorkspaceSearchResult {
  return {
    cellId: "cell-1",
    fileId: "file-1",
    fileName: "Genesis.sfm",
    original: "In the beginning God created",
    translated: "Au commencement Dieu créa",
    context: "GEN 1:1",
    matchedFields: new Set(["original"]),
    matchCount: 1,
    matchedTokens: ["god"],
    snippet: "In the beginning God created",
    rank: 1,
    ...overrides,
  }
}

describe("SearchResultsView", () => {
  it("renders a result and its file group", () => {
    render(
      <SearchResultsView
        query="God"
        results={[makeResult()]}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("Genesis.sfm")).toBeInTheDocument()
    expect(screen.getByText(/In the beginning/)).toBeInTheDocument()
  })

  it("shows empty state when no results", () => {
    render(
      <SearchResultsView
        query="xyz"
        results={[]}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("No results")).toBeInTheDocument()
  })

  it("groups results by file", () => {
    const results = [
      makeResult({ fileId: "file-1", fileName: "Genesis.sfm", cellId: "c1" }),
      makeResult({ fileId: "file-1", fileName: "Genesis.sfm", cellId: "c2", context: "GEN 1:2" }),
      makeResult({ fileId: "file-2", fileName: "Exodus.sfm", cellId: "c3" }),
    ]
    render(
      <SearchResultsView
        query="God"
        results={results}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("Genesis.sfm")).toBeInTheDocument()
    expect(screen.getByText("Exodus.sfm")).toBeInTheDocument()
  })

  it("calls onJumpToResult when a result row is clicked", () => {
    const onJump = vi.fn()
    const result = makeResult()
    render(
      <SearchResultsView
        query="God"
        results={[result]}
        onJumpToResult={onJump}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /In the beginning/ }))
    expect(onJump).toHaveBeenCalledWith(result)
  })

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn()
    render(
      <SearchResultsView
        query="God"
        results={[makeResult()]}
        onJumpToResult={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /close search results/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it("shows result count in header", () => {
    const results = [
      makeResult({ cellId: "c1" }),
      makeResult({ cellId: "c2", context: "GEN 1:2" }),
    ]
    render(
      <SearchResultsView
        query="God"
        results={results}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/2 results in 1 file/)).toBeInTheDocument()
  })

  it("shows the query in the header, whole-sentence rather than glued fragments", () => {
    render(
      <SearchResultsView
        query="God"
        results={[makeResult()]}
        onJumpToResult={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // AQU-511 wave-3 finding 3: "for" and the quoted query used to be two
    // separately translated fragments glued together in fixed JSX order.
    // They are now one catalog key ("search.expanded.forQuery") — see the
    // sibling reorder-proof test in SearchResultsView.i18n.test.tsx.
    expect(screen.getByText(/for\s+.God./)).toBeInTheDocument()
  })

  it("WHY: onJumpToResult must be called — if not, click-to-jump from expanded view is broken", () => {
    // This test encodes the core invariant: every result row must fire onJumpToResult
    // so that ProjectWorkspace can scroll the editor to the clicked cell.
    const onJump = vi.fn()
    const results = [
      makeResult({ cellId: "c1", context: "GEN 1:1", snippet: "In the beginning" }),
      makeResult({ cellId: "c2", context: "GEN 1:2", snippet: "And the earth was formless" }),
    ]
    render(
      <SearchResultsView
        query="beginning"
        results={results}
        onJumpToResult={onJump}
        onClose={vi.fn()}
      />,
    )
    const rows = screen.getAllByRole("button")
    // Find result row buttons (not header close button)
    const resultButtons = rows.filter((b) => b.getAttribute("aria-label") !== "Close search results")
    expect(resultButtons.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(resultButtons[1])
    expect(onJump).toHaveBeenCalledTimes(1)
  })
})
