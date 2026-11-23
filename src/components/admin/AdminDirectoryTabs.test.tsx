import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AdminOverviewTab, AdminProjectsTable } from "./AdminDirectoryTabs"
import {
  getAdminActivity,
  getAdminOrgsPage,
  getAdminOverview,
  getAdminProjects,
  getAdminProjectsPage,
} from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/frontier/admin")>("@/lib/frontier/admin")
  return {
    ...actual,
    getAdminOverview: vi.fn(),
    getAdminOrgsPage: vi.fn(),
    getAdminProjectsPage: vi.fn(),
    getAdminActivity: vi.fn(),
    getAdminProjects: vi.fn(),
  }
})

const overview = {
  orgs: 2,
  teams: 1,
  users: 4,
  activeProjects: 3,
  archivedProjects: 0,
  activeUsers7d: 1,
  newUsers7d: 1,
}

describe("admin tabs load on their own", () => {
  beforeEach(() => {
    vi.mocked(getAdminOverview).mockResolvedValue(overview)
    vi.mocked(getAdminOrgsPage).mockResolvedValue({ rows: [], total: 2, limit: 5, offset: 0, overdue: null })
    vi.mocked(getAdminProjectsPage).mockResolvedValue({
      rows: [],
      total: 3,
      limit: 6,
      offset: 0,
      overdue: 1,
    })
    vi.mocked(getAdminActivity).mockResolvedValue([])
    vi.mocked(getAdminProjects).mockResolvedValue([])
  })

  it("loads overview tiles without the unpaged project list", async () => {
    const onAttentionTotal = vi.fn()
    render(
      <MemoryRouter>
        <AdminOverviewTab
          jwt="jwt"
          onOpenOrg={vi.fn()}
          onOpenTile={vi.fn()}
          onViewProjects={vi.fn()}
          onViewActivity={vi.fn()}
          onAttentionTotal={onAttentionTotal}
        />
      </MemoryRouter>,
    )
    expect(await screen.findByText("Need attention")).toBeInTheDocument()
    await waitFor(() => expect(onAttentionTotal).toHaveBeenCalledWith(3))
    expect(getAdminProjects).not.toHaveBeenCalled()
    expect(getAdminProjectsPage).toHaveBeenCalledWith(
      "jwt",
      expect.objectContaining({ limit: 6, lens: "needs-attention", sort: "status", dir: "desc" }),
    )
    expect(getAdminOrgsPage).toHaveBeenCalledWith(
      "jwt",
      expect.objectContaining({ limit: 5, sort: "projectCount", dir: "desc" }),
    )
    expect(getAdminActivity).toHaveBeenCalledWith("jwt", 8)
  })

  it("loads the projects tab as its own page", async () => {
    render(
      <MemoryRouter>
        <AdminProjectsTable jwt="jwt" initialLens="all" onSelectOrg={vi.fn()} />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(getAdminProjectsPage).toHaveBeenCalledWith(
        "jwt",
        expect.objectContaining({ limit: 50, offset: 0, sort: "name", dir: "asc", lens: "all" }),
      ),
    )
    expect(getAdminOrgsPage).not.toHaveBeenCalled()
    expect(getAdminProjects).not.toHaveBeenCalled()
  })
})
