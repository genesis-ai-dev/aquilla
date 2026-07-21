/**
 * MemoryProposalNotice tests — memory.proposed / brief.proposed render as
 * read-only inline notices, with an optional "Review in Memory tab" jump
 * that's absent where there's no Memory tab to jump to (e.g. the dock).
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { BriefProposedItem, MemoryProposedItem } from "@/lib/agent/run-state"
import { BriefProposalNotice, MemoryProposalNotice } from "./MemoryProposalNotice"

const memoryItem: MemoryProposedItem = {
  id: "i0",
  kind: "memory-proposed",
  memoryId: "m1",
  path: "observations/mrk.md",
  preview: "MRK uses formal register",
}

const briefItem: BriefProposedItem = {
  id: "i1",
  kind: "brief-proposed",
  proposalId: "b1",
  preview: "Tighten the tone guidance",
}

describe("MemoryProposalNotice", () => {
  it("shows the path and preview", () => {
    render(<MemoryProposalNotice item={memoryItem} />)
    expect(screen.getByText("observations/mrk.md")).toBeInTheDocument()
    expect(screen.getByText(/MRK uses formal register/)).toBeInTheDocument()
  })

  it("omits the jump when onReviewMemory isn't provided", () => {
    render(<MemoryProposalNotice item={memoryItem} />)
    expect(screen.queryByRole("button", { name: /Review in Memory tab/ })).toBeNull()
  })

  it("tags the notice with data-frame-type and data-memory-path for e2e", () => {
    const { container } = render(<MemoryProposalNotice item={memoryItem} />)
    const row = container.querySelector('[data-frame-type="memory.proposed"]')
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute("data-memory-path", "observations/mrk.md")
  })

  it("jumps to the Memory tab when provided", () => {
    const onReviewMemory = vi.fn()
    render(<MemoryProposalNotice item={memoryItem} onReviewMemory={onReviewMemory} />)
    fireEvent.click(screen.getByRole("button", { name: /Review in Memory tab/ }))
    expect(onReviewMemory).toHaveBeenCalled()
  })
})

describe("BriefProposalNotice", () => {
  it("shows the preview and the Memory-tab jump", () => {
    const onReviewMemory = vi.fn()
    render(<BriefProposalNotice item={briefItem} onReviewMemory={onReviewMemory} />)
    expect(screen.getByText(/Tighten the tone guidance/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Review in Memory tab/ }))
    expect(onReviewMemory).toHaveBeenCalled()
  })

  it('tags the notice with data-frame-type="brief.proposed" for e2e', () => {
    const { container } = render(<BriefProposalNotice item={briefItem} />)
    expect(container.querySelector('[data-frame-type="brief.proposed"]')).not.toBeNull()
  })
})
