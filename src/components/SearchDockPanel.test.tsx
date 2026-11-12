/**
 * SearchDockPanel — AQU-597 mode-switcher labelling.
 *
 * WHY: testers reported the dock's find-and-replace control was "hard to see
 * and unclear what it depicts, making it hard to explain to others" — it was
 * an icon-only toggle using the abstract lucide `Replace` glyph. The fix gives
 * each mode toggle a visible text label alongside its icon. These tests guard
 * that the labels stay present (so the control never regresses to icon-only)
 * and that switching to the labelled Replace mode still works.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { expectTooltip } from "@/test-utils/tooltip"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { SearchDockPanel, type SearchDockPanelProps } from "./SearchDockPanel"

/** Minimal required props to render the dock panel. */
function baseProps(extra: Partial<SearchDockPanelProps> = {}): SearchDockPanelProps {
  return {
    activeFileId: null,
    activeFileName: null,
    loading: false,
    ready: true,
    results: [],
    onReady: vi.fn(),
    onSearch: vi.fn(),
    onSearchPassages: vi.fn(),
    onClearResults: vi.fn(),
    onSelect: vi.fn(),
    isReadOnly: false,
    ...extra,
  }
}

describe("SearchDockPanel — labelled mode switcher (AQU-597)", () => {
  it("renders each mode toggle with a visible text label, not icon-only", () => {
    render(<SearchDockPanel {...baseProps({ bibleResourcesEnabled: true })} />)

    // Accessible names come from aria-label; the visible text label is what
    // makes the control explainable to others.
    const searchToggle = screen.getByRole("button", { name: "Search" })
    const replaceToggle = screen.getByRole("button", { name: "Find & replace" })
    const bibleToggle = screen.getByRole("button", { name: "Bible data" })

    expect(searchToggle).toHaveTextContent("Search")
    expect(replaceToggle).toHaveTextContent("Replace")
    expect(bibleToggle).toHaveTextContent("Bible")
  })

  it("switching to Find & Replace marks it pressed and reveals the full-panel entry", () => {
    const onOpenFullPanel = vi.fn()
    render(<SearchDockPanel {...baseProps({ onOpenFullPanel })} />)

    const replaceToggle = screen.getByRole("button", { name: "Find & replace" })
    expect(replaceToggle).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(replaceToggle)

    expect(replaceToggle).toHaveAttribute("aria-pressed", "true")
    // Replace mode footer offers the full Find & Replace panel.
    expect(
      screen.getByRole("button", { name: /open find & replace/i }),
    ).toBeInTheDocument()
  })

  it("opens the full panel in replace mode with the dock query", () => {
    const onOpenFullPanel = vi.fn()
    render(<SearchDockPanel {...baseProps({ onOpenFullPanel })} />)

    fireEvent.click(screen.getByRole("button", { name: "Find & replace" }))
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "teste" } })
    fireEvent.click(screen.getByRole("button", { name: /open find & replace/i }))

    expect(onOpenFullPanel).toHaveBeenCalledWith({
      mode: "replace",
      query: "teste",
      find: { caseSensitive: false, matchWord: false, useRegexp: false },
    })
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. The mode
// toggles and "Expand all" carry their own words, so they have no hover.
describe("SearchDockPanel — hover only names icon buttons", () => {
  async function expectNoHover(el: Element) {
    await userEvent.setup().hover(el)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  }
  const result = {
    cellId: "c1", fileId: "f1", fileName: "GEN", original: "In the beginning", translated: "Au commencement",
    context: "GEN 1:1", matchedFields: new Set(), matchCount: 1, matchedTokens: ["beginning"],
    snippet: "In the beginning", rank: 1,
  } as unknown as WorkspaceSearchResult

  it("the mode toggles have no hover", async () => {
    render(<TooltipProvider delay={0}><SearchDockPanel {...baseProps({ bibleResourcesEnabled: true })} /></TooltipProvider>)
    await expectNoHover(screen.getByRole("button", { name: "Search" }))
    await expectNoHover(screen.getByRole("button", { name: "Find & replace" }))
    await expectNoHover(screen.getByRole("button", { name: "Bible data" }))
  })

  it("Expand all has no hover", async () => {
    render(<TooltipProvider delay={0}><SearchDockPanel {...baseProps({ results: [result], onExpandResults: vi.fn() })} /></TooltipProvider>)
    await expectNoHover(screen.getByRole("button", { name: "Expand all results" }))
  })

  it("the icon-only full-panel button keeps its name on hover", async () => {
    render(<TooltipProvider delay={0}><SearchDockPanel {...baseProps({ onOpenFullPanel: vi.fn() })} /></TooltipProvider>)
    await expectTooltip(screen.getByRole("button", { name: "Open full search panel" }), "Open full search panel")
  })
})
