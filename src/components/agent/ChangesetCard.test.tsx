/**
 * ChangesetCard tests — the summary/cell-count facts render, the
 * "Review & approve" link points at approvalUrl and opens in a new tab, and
 * (mem-M5) the card polls GET /api/v2/changesets/:id/approval and flips its
 * visual state (badge + disabled link) once the status turns terminal.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { ChangesetItem } from "@/lib/agent/run-state"
import { ChangesetCard } from "./ChangesetCard"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { jwt: "test-jwt", username: "alice" }, loading: false })),
}))

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

function mockApprovalStatus(status: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status }),
  } as Response)
}

describe("ChangesetCard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockApprovalStatus("staged"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it("polls the approval route and flips the badge + disables the link once approved", async () => {
    const fetchMock = mockApprovalStatus("approved")
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<ChangesetCard item={item()} />)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/changesets/cs-1/approval"),
        expect.objectContaining({ headers: { Authorization: "Bearer test-jwt" } }),
      ),
    )
    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument())
    expect(container.querySelector('[data-changeset-status="approved"]')).not.toBeNull()
    expect(screen.queryByRole("link", { name: /Review & approve/ })).not.toBeInTheDocument()
    expect(screen.getByText("Review & approve")).toBeInTheDocument()
  })

  it("stops polling once a terminal status is reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetchMock = mockApprovalStatus("discarded")
      vi.stubGlobal("fetch", fetchMock)
      render(<ChangesetCard item={item()} />)

      await waitFor(() => expect(screen.getByText("Discarded")).toBeInTheDocument())
      const callsAtTerminal = fetchMock.mock.calls.length

      // Two more poll intervals would fire if polling hadn't stopped.
      await vi.advanceTimersByTimeAsync(15000)
      expect(fetchMock.mock.calls.length).toBe(callsAtTerminal)
    } finally {
      vi.useRealTimers()
    }
  })
})
