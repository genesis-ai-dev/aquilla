// AQU-478: UpstreamChangesPanel tests — role gating + repin flow.
//
// Mocks useUpstreamChangesReview directly (the hook's own fetch-composition
// logic is covered by the sync-worker route tests) so this file focuses on
// the component's rendering/gating/interaction contract:
//   - viewer sees the panel read-only (no repin buttons enabled)
//   - reviewer can repin a single cell (emitTargetCellRepin called once)
//   - below-reviewer cannot repin; only project_lead+ sees bulk selection
//   - a no-op repin (translator won the race) surfaces as "skipped"

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { UpstreamChangesPanel } from "./UpstreamChangesPanel"
import { ROLE } from "@/lib/sync/role-policy"
import type { ReviewBatchGroup } from "@/hooks/useUpstreamChangesReview"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

const mockEmitRepin = vi.fn()
vi.mock("@/lib/sync/events-emit", () => ({
  emitTargetCellRepin: (...args: unknown[]) => mockEmitRepin(...args),
}))

const mockFetchCellsByIds = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchCellsByIds: (...args: unknown[]) => mockFetchCellsByIds(...args),
}))

let reviewState: {
  groups: ReviewBatchGroup[]
  totalFlagged: number
  isLoading: boolean
  isError: boolean
  revalidate: () => void
}
vi.mock("@/hooks/useUpstreamChangesReview", () => ({
  useUpstreamChangesReview: () => reviewState,
}))

function makeGroup(): ReviewBatchGroup {
  return {
    batchId: "batch-1",
    serverTs: Date.parse("2026-07-06T12:00:00Z"),
    cellCount: 1,
    items: [
      {
        fileId: "file-a",
        fileName: "Genesis",
        cellId: "cell-1",
        category: "changed",
        oldValue: "In the beginning",
        newValue: "In the beginning (fixed)",
        newSourceEventId: "mirror-evt-2",
        batchId: "batch-1",
        batchServerTs: Date.parse("2026-07-06T12:00:00Z"),
        target: { eventId: "target-evt-1", sourceEventId: "mirror-evt-1", value: "Au commencement" },
      },
    ],
  }
}

const BASE_PROPS = {
  projectId: "proj-1",
  files: [{ id: "file-a", name: "Genesis" }],
  getToken: vi.fn().mockResolvedValue("jwt-token"),
  username: "reviewer1",
}

describe("UpstreamChangesPanel", () => {
  beforeEach(() => {
    mockEmitRepin.mockClear().mockResolvedValue("new-event-id")
    mockFetchCellsByIds.mockClear()
    navigate.mockClear()
    reviewState = {
      groups: [makeGroup()],
      totalFlagged: 1,
      isLoading: false,
      isError: false,
      revalidate: vi.fn(),
    }
  })

  it("shows nothing flagged when there are no review items", () => {
    reviewState = { groups: [], totalFlagged: 0, isLoading: false, isError: false, revalidate: vi.fn() }
    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.PROJECT_LEAD} />)
    expect(screen.getByText(/Nothing flagged/i)).toBeTruthy()
  })

  it("viewer (100) sees the panel but cannot repin — no Accept as-is action available", () => {
    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.VIEWER} />)
    expect(screen.getByText(/Genesis/)).toBeTruthy()
    const acceptButtons = screen.queryAllByRole("button", { name: /Accept as-is/i })
    for (const btn of acceptButtons) expect(btn).toBeDisabled()
    expect(screen.getByText(/Reviewer or above required/i)).toBeTruthy()
  })

  it("reviewer (300) can repin a single flagged cell", async () => {
    mockFetchCellsByIds.mockResolvedValue([
      { cellId: "cell-1", side: "target", eventId: "target-evt-1", sourceEventId: "mirror-evt-2" },
    ])
    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.REVIEWER} />)

    const acceptButton = screen.getByRole("button", { name: /Accept as-is/i })
    expect(acceptButton).not.toBeDisabled()
    fireEvent.click(acceptButton)

    await waitFor(() => {
      expect(mockEmitRepin).toHaveBeenCalledTimes(1)
    })
    expect(mockEmitRepin).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        fileId: "file-a",
        cellId: "cell-1",
        sourceEventId: "mirror-evt-2",
        expectedTargetEventId: "target-evt-1",
      }),
    )
  })

  it("reports a no-op repin as skipped when a translator re-committed first (race negative case)", async () => {
    // fetchCellsByIds returns the PRE-repin sourceEventId (mirror-evt-1),
    // meaning the emitted repin's WHERE clause guard didn't match — a
    // translator's concurrent commit moved cells.event_id first.
    mockFetchCellsByIds.mockResolvedValue([
      { cellId: "cell-1", side: "target", eventId: "some-newer-event", sourceEventId: "mirror-evt-1" },
    ])
    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.REVIEWER} />)

    fireEvent.click(screen.getByRole("button", { name: /Accept as-is/i }))

    await waitFor(() => {
      expect(screen.getByText(/skipped — retranslated since/i)).toBeTruthy()
    })
  })

  it("only project_lead (500)+ sees bulk-selection checkboxes", () => {
    const { unmount } = render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.REVIEWER} />)
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    unmount()

    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.PROJECT_LEAD} />)
    expect(screen.queryAllByRole("checkbox").length).toBeGreaterThan(0)
  })

  it("navigates to the cell in the editor when 'Open' is clicked", () => {
    render(<UpstreamChangesPanel {...BASE_PROPS} roleLevel={ROLE.VIEWER} />)
    fireEvent.click(screen.getByRole("button", { name: /^Open$/i }))
    expect(navigate).toHaveBeenCalledWith("/project/proj-1/file/file-a?cellId=cell-1")
  })
})
