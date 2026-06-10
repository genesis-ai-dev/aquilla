import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { AssignedToMe } from "./AssignedToMe"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 400, name: "contributor" } }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: vi.fn(async () => [
    { id: "pa", name: "John" },
    { id: "pb", name: "Mark" },
  ]),
}))
vi.mock("@/lib/sync/assignments", () => ({ getMyAssignmentsForOrg: vi.fn() }))

import { getMyAssignmentsForOrg } from "@/lib/sync/assignments"
const mockGetMy = vi.mocked(getMyAssignmentsForOrg)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

function renderInbox() {
  return render(
    <MemoryRouter>
      <OrgProvider>
        <AssignedToMe />
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("AssignedToMe", () => {
  it("aggregates the caller's open assignments across projects with progress", async () => {
    // One org-level request (GET /orgs/:orgId/assignments/mine) replaces the
    // old per-project fan-out — rows arrive with projectName attached.
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", scopeKind: "books", scopeLabel: "John", deadline: "2026-06-30", note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", deadline: null, note: null, cellsTotal: 5, cellsDone: 5, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getAllByText("John").length).toBeGreaterThan(0))
    expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument()
    expect(screen.getByText("4/10 cells · 40%")).toBeInTheDocument()
    expect(screen.getByText("5/5 cells · 100%")).toBeInTheDocument()
    expect(screen.getByText("Due 2026-06-30")).toBeInTheDocument()
    expect(mockGetMy).toHaveBeenCalledWith("jwt", 1)
  })

  it("shows an empty state when there are no assignments", async () => {
    mockGetMy.mockResolvedValue([])
    renderInbox()
    await waitFor(() => expect(screen.getByText("You have no open assignments.")).toBeInTheDocument())
  })

  it("surfaces a failed org-level read as an error (no silent empty state)", async () => {
    // The single org read has no per-project fallback — a failure must be
    // visible, not rendered as "no assignments".
    mockGetMy.mockRejectedValue(new Error("getMyAssignmentsForOrg failed: HTTP 403"))
    renderInbox()

    await waitFor(() =>
      expect(screen.getByText(/getMyAssignmentsForOrg failed: HTTP 403/)).toBeInTheDocument(),
    )
    expect(screen.queryByText("You have no open assignments.")).not.toBeInTheDocument()
  })
})
