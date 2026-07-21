/**
 * ChangesetCard tests — the summary/cell-count facts render, and the
 * "Review & approve" link points at approvalUrl and opens in a new tab.
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { ChangesetItem } from "@/lib/agent/run-state"
import { ChangesetCard } from "./ChangesetCard"

function item(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return {
    id: "i0",
    kind: "changeset",
    changesetId: "cs-1",
    approvalUrl: "https://app.example/approve/cs-1",
    summary: "Import glossary.csv",
    cellCount: 40,
    ...overrides,
  }
}

describe("ChangesetCard", () => {
  it("shows the summary and cell count", () => {
    render(<ChangesetCard item={item()} />)
    expect(screen.getByText("Import glossary.csv")).toBeInTheDocument()
    expect(screen.getByText("40 cells")).toBeInTheDocument()
  })

  it("singularizes the cell count for a single cell", () => {
    render(<ChangesetCard item={item({ cellCount: 1 })} />)
    expect(screen.getByText("1 cell")).toBeInTheDocument()
  })

  it('tags the card with data-frame-type="changeset.staged" for e2e selectors', () => {
    const { container } = render(<ChangesetCard item={item()} />)
    expect(container.querySelector('[data-frame-type="changeset.staged"]')).not.toBeNull()
  })

  it("links Review & approve to approvalUrl, opened in a new tab", () => {
    render(<ChangesetCard item={item()} />)
    const link = screen.getByRole("link", { name: /Review & approve/ })
    expect(link).toHaveAttribute("href", "https://app.example/approve/cs-1")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })
})
