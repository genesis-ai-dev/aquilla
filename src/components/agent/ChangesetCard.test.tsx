/**
 * ChangesetCard tests — the summary/cell-count facts render, sample per-cell
 * changes from GET /api/v2/changesets/:id/approval render inline, Approve/
 * Reject act in-conversation (approve POSTs the GET's digest — never one the
 * frame carried), the "View full details" link still points at approvalUrl in
 * a new tab, and (mem-M5) polling stops once the status turns terminal.
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

const DIGEST = "sha256:0123456789abcdef"

function approvalPayload(status: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    digest: DIGEST,
    changes: {
      total: 5,
      truncated: false,
      items: [
        { fileId: "f1", fileName: "Genesis", cellId: "c1", canonicalRef: "GEN 1:1", source: "src 1", before: "old 1", after: "new 1" },
        { fileId: "f1", fileName: "Genesis", cellId: "c2", canonicalRef: "GEN 1:2", source: "src 2", before: null, after: "new 2" },
        { fileId: "f1", fileName: "Genesis", cellId: "c3", canonicalRef: "GEN 1:3", source: "src 3", before: "old 3", after: "new 3" },
        { fileId: "f1", fileName: "Genesis", cellId: "c4", canonicalRef: "GEN 1:4", source: "src 4", before: "old 4", after: "new 4" },
        { fileId: "f1", fileName: "Genesis", cellId: "c5", canonicalRef: "GEN 1:5", source: "src 5", before: "old 5", after: "new 5" },
      ],
    },
    ...extra,
  }
}

function mockApproval(status: string, extra: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => approvalPayload(status, extra),
  } as Response)
}

describe("ChangesetCard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockApproval("staged"))
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

  it("links View full details to approvalUrl, opened in a new tab", () => {
    render(<ChangesetCard item={item()} />)
    const link = screen.getByRole("link", { name: /View full details/ })
    expect(link).toHaveAttribute("href", "https://app.example/approve/cs-1")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("renders a capped sample of the per-cell changes from the approval payload", async () => {
    render(<ChangesetCard item={item()} />)

    // First three of five changes render; the rest are counted, not shown.
    expect(await screen.findByText("new 1")).toBeInTheDocument()
    expect(screen.getByText("old 1")).toBeInTheDocument()
    expect(screen.getByText("new 3")).toBeInTheDocument()
    expect(screen.queryByText("new 4")).not.toBeInTheDocument()
    expect(screen.getByText(/and 2 more changes/i)).toBeInTheDocument()
  })

  it("approves in place: POSTs the fetched digest and shows the approved state", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      if (String(url).endsWith("/approve")) {
        const body = JSON.parse(String(init?.body)) as { digest: string }
        expect(body.digest).toBe(DIGEST)
        return { ok: true, json: async () => ({ confirmationId: "conf-1" }) } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const { container } = render(<ChangesetCard item={item()} />)
    const approveBtn = await screen.findByRole("button", { name: /Approve/ })
    approveBtn.click()

    await waitFor(() =>
      expect(screen.getByText(/the agent can now commit/i)).toBeInTheDocument(),
    )
    expect(container.querySelector('[data-changeset-status="approved"]')).not.toBeNull()
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
  })

  it("rejects in place and flips to Discarded", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      if (String(url).endsWith("/reject")) {
        return { ok: true, json: async () => ({ changesetId: "cs-1", status: "discarded" }) } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ChangesetCard item={item()} />)
    const rejectBtn = await screen.findByRole("button", { name: /Reject/ })
    rejectBtn.click()

    await waitFor(() => expect(screen.getByText("Discarded")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
  })

  it("surfaces an action error without losing the card", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "validation_failed", message: "changeset has expired" } }),
      } as Response
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ChangesetCard item={item()} />)
    const approveBtn = await screen.findByRole("button", { name: /Approve/ })
    approveBtn.click()

    await waitFor(() => expect(screen.getByText("changeset has expired")).toBeInTheDocument())
    // Still actionable after a failed attempt.
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument()
  })

  it("shows Committed and no action buttons for a committed changeset", async () => {
    vi.stubGlobal("fetch", mockApproval("committed"))
    render(<ChangesetCard item={item()} />)

    await waitFor(() => expect(screen.getByText("Committed")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Reject/ })).not.toBeInTheDocument()
  })

  it("stops polling once a terminal status is reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetchMock = mockApproval("discarded")
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
