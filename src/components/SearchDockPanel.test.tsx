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
import { render, screen, fireEvent } from "@testing-library/react"
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
    const replaceToggle = screen.getByRole("button", { name: "Find & Replace" })
    const bibleToggle = screen.getByRole("button", { name: "Bible resources" })

    expect(searchToggle).toHaveTextContent("Search")
    expect(replaceToggle).toHaveTextContent("Replace")
    expect(bibleToggle).toHaveTextContent("Bible")
  })

  it("switching to Find & Replace marks it pressed and reveals the full-panel entry", () => {
    const onOpenFullPanel = vi.fn()
    render(<SearchDockPanel {...baseProps({ onOpenFullPanel })} />)

    const replaceToggle = screen.getByRole("button", { name: "Find & Replace" })
    expect(replaceToggle).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(replaceToggle)

    expect(replaceToggle).toHaveAttribute("aria-pressed", "true")
    // Replace mode footer offers the full Find & Replace panel.
    expect(
      screen.getByRole("button", { name: /open find & replace/i }),
    ).toBeInTheDocument()
  })
})
