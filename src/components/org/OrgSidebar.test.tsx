import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSidebar } from "./OrgSidebar"

// AQU-474: project-only invitees (direct project_members grant, no org
// membership) have no org-scoped nav surface to reach their shared project.
// AQU-417: the sidebar no longer lists each shared project inline (that
// scattered the same list under every org). It now shows ONE "Shared with you"
// link to the dedicated /shared page, and stays hidden when there's nothing to
// share. These tests pin that single-entry behavior + the reachability guard.

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => null }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))
vi.mock("@/hooks/usePlatformAdmin", () => ({ usePlatformAdmin: () => ({ isAdmin: false, loading: false }) }))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function renderSidebar() {
  return render(
    <MemoryRouter>
      <OrgProvider>
        <OrgSidebar />
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe("OrgSidebar shared-projects nav (AQU-474 / AQU-417)", () => {
  it("shows a single 'Shared with you' link to /shared when the user has cross-org grants", async () => {
    // No org membership at all — the canonical project-only-invitee scenario.
    listMyOrgs.mockResolvedValue([])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Genesis Draft", gitlabProjectId: null, orgId: 99, role: { level: 400, name: "contributor", source: "override" } },
    ])

    renderSidebar()

    // AQU-417: one dedicated entry point — not the project listed inline.
    const link = await screen.findByRole("link", { name: "Shared with you" })
    expect(link).toHaveAttribute("href", "/shared")
    // The individual shared project now lives on the /shared page, not the nav.
    expect(screen.queryByRole("link", { name: "Genesis Draft" })).not.toBeInTheDocument()
  })

  it("does not render the section when all accessible projects are within the user's active org", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "In-org project", gitlabProjectId: null, orgId: 1, role: { level: 700, name: "owner", source: "org" } },
    ])

    renderSidebar()

    // Let the projects fetch settle before asserting absence.
    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalled())
    expect(screen.queryByText("Shared with you")).not.toBeInTheDocument()
  })

  it("does not render the section when there are no accessible projects", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([])

    renderSidebar()

    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalled())
    expect(screen.queryByText("Shared with you")).not.toBeInTheDocument()
  })
})
