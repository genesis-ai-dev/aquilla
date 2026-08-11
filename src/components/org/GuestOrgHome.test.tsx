import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { GuestOrgHome } from "./GuestOrgHome"

// AQU-790: the overview for a guest org (`/orgs/:guestId`). It shows only the
// projects in that org shared with the caller, titled with the org name, and it
// renders none of the member-org chrome. These pin (a) the scoping to the one
// guest org, (b) exclusion of other foreign-org grants and own-org projects,
// and (c) that rows are client-side links to /projects/:id.

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
// The sidebar runs its own switcher/fetches — irrelevant to this page's list.
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function renderGuestHome(initialEntry = "/orgs/2") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <OrgProvider>
        <GuestOrgHome />
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

describe("GuestOrgHome (AQU-790)", () => {
  it("lists only the active guest org's shared projects, titled with its name", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
    fetchAccessibleProjects.mockResolvedValue([
      // Own-org project — never in a shared list.
      { id: "own-1", name: "My Org Project", orgId: 1, role: { level: 700, name: "owner", source: "creator" } },
      // The active guest org (id 2).
      { id: "p2", name: "Guest Gospel", orgId: 2, orgName: "Sunset Bible", role: { level: 100, name: "viewer", source: "override" } },
      // A different guest org — must not appear on org 2's overview.
      { id: "p3", name: "Other Shared", orgId: 3, orgName: "Other Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    renderGuestHome()

    const list = await screen.findByTestId("guest-org-projects")
    const link = within(list).getByRole("link", { name: /guest gospel/i })
    expect(link).toHaveAttribute("href", "/projects/p2")
    // Scoped strictly to the active guest org.
    expect(within(list).queryByText("Other Shared")).not.toBeInTheDocument()
    expect(within(list).queryByText("My Org Project")).not.toBeInTheDocument()
    // Titled with the guest org's name.
    expect(screen.getByRole("heading", { name: "Sunset Bible" })).toBeInTheDocument()
  })
})
