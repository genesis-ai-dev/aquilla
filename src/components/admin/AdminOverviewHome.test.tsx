/**
 * AdminOverviewHome — the operator home. Verifies stat tiles render, the
 * Needs-attention section lists at-risk projects, and the nav callbacks fire.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AdminOverviewHome } from "./AdminOverviewHome"
import type { AdminOverview, AdminOrg, AdminUser, AdminProject, AdminActivity } from "@/lib/frontier/admin"

const navigate = vi.fn()

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigate }
})

const overview: AdminOverview = {
  orgs: 4,
  teams: 6,
  users: 20,
  activeProjects: 9,
  archivedProjects: 3,
  activeUsers7d: 5,
}
const orgs: AdminOrg[] = [
  { id: 1, name: "Busy", createdAt: "2026-01-01", ownerUsername: "al", memberCount: 5, projectCount: 8 },
]
const users: AdminUser[] = [
  { id: 1, username: "al", email: "a@x", displayName: null, createdAt: "2026-01-01", orgCount: 1, lastActiveAt: null },
]
const projects: AdminProject[] = [
  {
    id: "late",
    name: "Late Project",
    orgId: 1,
    orgName: "Busy",
    archived: false,
    createdAt: "2026-01-01",
    deadlineAt: "2020-01-01",
    creatorUsername: "al",
    totalCells: 100,
    validatedCells: 10,
    wordCount: 500,
    lastEditAt: Date.now(),
  },
]
const activity: AdminActivity[] = [
  { id: 1, userId: 1, username: "al", type: "edit", description: "edited a cell", timestamp: "2026-06-30T12:00:00Z" },
]

function renderHome(overrides: Partial<React.ComponentProps<typeof AdminOverviewHome>> = {}) {
  const props = {
    overview,
    orgs,
    users,
    projects,
    activity,
    onOpenOrg: vi.fn(),
    onViewProjects: vi.fn(),
    onViewActivity: vi.fn(),
    ...overrides,
  }
  render(
    <MemoryRouter>
      <AdminOverviewHome {...props} />
    </MemoryRouter>,
  )
  return props
}

describe("AdminOverviewHome", () => {
  it("renders stat tiles with context", () => {
    renderHome()
    expect(screen.getByText("Organizations")).toBeInTheDocument()
    expect(screen.getByText(/archived/)).toBeInTheDocument()
  })

  it("lists at-risk projects in Needs attention", () => {
    renderHome()
    const table = screen.getByTestId("admin-overview-attention-table")
    expect(table).toHaveClass("border-0")
    expect(within(table).getByText("Late Project")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Late Project" })).not.toBeInTheDocument()
    expect(screen.getByText("Overdue")).toBeInTheDocument()
  })

  it("navigates to a project when its attention row is clicked", () => {
    navigate.mockClear()
    renderHome()
    const table = screen.getByTestId("admin-overview-attention-table")
    fireEvent.click(within(table).getByText("Late Project").closest("tr")!)
    expect(navigate).toHaveBeenCalledWith("/projects/late")
  })

  it("fires nav callbacks for org and activity", () => {
    const props = renderHome()
    const orgsTable = screen.getByTestId("admin-overview-orgs-table")
    expect(orgsTable).toHaveClass("border-0")
    fireEvent.click(within(orgsTable).getByText("Busy").closest("tr")!)
    expect(props.onOpenOrg).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole("button", { name: /view all/i }))
    expect(props.onViewActivity).toHaveBeenCalled()
  })

  it("renders most active organizations as a table", () => {
    renderHome()
    const orgsTable = screen.getByTestId("admin-overview-orgs-table")
    expect(within(orgsTable).getByText("Projects")).toBeInTheDocument()
    expect(within(orgsTable).getByText("Members")).toBeInTheDocument()
  })

  it("shows an all-clear empty state when nothing is at risk", () => {
    renderHome({ projects: [] })
    expect(screen.getByText(/all clear/i)).toBeInTheDocument()
  })
})
